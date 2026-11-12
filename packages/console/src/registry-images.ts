import { REGISTRY_STACK_NAME } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { loadUsedImages } from "./images.js";
import type { ImageRef } from "./image-ref.js";
import { RegistryError, type RegistryClient } from "./registry.js";
import { getRegistrySettings, type RegistrySettings } from "./registry-app-routes.js";
import { getRetentionSettings, markRetention, type RetentionMark, type RetentionSettings } from "./registry-retention.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Seuls les dépôts créés par les correctifs sont gérés (et supprimables) depuis la console. */
export const MANAGED_PREFIX = "patched/";
const MAX_REPOSITORIES = 200;
const MAX_TAGS_PER_REPOSITORY = 100;
const ACTIVE = ["queued", "preparing", "scanning_before", "patching", "scanning_after", "verifying", "unknown"];

/** Commande à lancer dans le conteneur du registre pour libérer l'espace des images supprimées. */
export const GARBAGE_COLLECT_COMMAND = "registry garbage-collect /etc/distribution/config.yml";

export interface UsageRef {
  stackId: string;
  stackName: string;
  revision: number;
  /** « courante », « déployée » ou « ancienne » (une révision plus ancienne qui sert de retour arrière). */
  kind: "current" | "deployed" | "history";
}

export interface RegistryImage {
  digest: string;
  tags: string[];
  sizeBytes: number | null;
  /** `patched` : image corrigée ; `source` : copie de l'image d'origine ; `other` : dépôt ou tag inconnu de la console. */
  kind: "patched" | "source" | "other";
  remediation: { id: string; status: string } | null;
  /** Date du correctif d'origine (sert à classer les images pour la rétention). */
  createdAt: string | null;
  /** Digest de la copie source dont provient une image corrigée. */
  sourceDigest: string | null;
  /** Ce que dit la règle de rétention (désactivée : jamais candidate). */
  retention: RetentionMark;
  /** Usages qui interdisent la suppression (révision courante ou déployée, conteneur en cours, correctif actif). */
  blockers: string[];
  /** Révisions plus anciennes qui référencent l'image : suppression possible après confirmation. */
  history: UsageRef[];
  deletable: boolean;
  /** Pourquoi la suppression est refusée (null si elle est possible). */
  reason: string | null;
}

export interface RegistryRepository {
  repository: string;
  managed: boolean;
  images: RegistryImage[];
  truncated: boolean;
}

export interface RegistryImagesView {
  registry: string;
  reachable: boolean;
  /** Raison de l'échec quand le registre n'a pas pu être interrogé. */
  error: string | null;
  repositories: RegistryRepository[];
  truncated: boolean;
  totalBytes: number;
  gcCommand: string;
  retention: Pick<RetentionSettings, "mode" | "keepPerRepository">;
  /** Nombre d'images que la règle de rétention propose de supprimer. */
  retentionCandidates: number;
  /** Nom du service à utiliser avec `docker exec`/Terminal. */
  containerHint: string;
}

interface Revision {
  stackId: string;
  stackName: string;
  revision: number;
  compose: string;
  kind: UsageRef["kind"];
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** La référence apparaît dans le texte, sans être le début d'une référence plus longue (`-patch.1` / `-patch.10`). */
export function mentions(text: string, ref: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_./-])${escapeRegex(ref)}(?![A-Za-z0-9_.-])`, "m").test(text);
}

/**
 * Liste et nettoyage prudent des images du registre privé. Rien n'est supprimé automatiquement : une suppression est
 * manuelle, par digest, jamais pour une image utilisée par une révision courante ou déployée, un conteneur ou un
 * correctif en cours. L'espace disque n'est libéré que par le ramasse-miettes du registre (hors console).
 */
export class RegistryImages {
  constructor(
    private readonly pool: Pool,
    private readonly client: Pick<RegistryClient, "catalog" | "listTags" | "headManifest" | "manifestSize" | "deleteManifest">,
  ) {}

  private async settings(): Promise<RegistrySettings> {
    const s = await getRegistrySettings(this.pool);
    if (!s) throw new HttpError(409, "registry_not_configured", "Aucune application registry n'est configurée.");
    return s;
  }

  private ref(s: RegistrySettings, repository: string): ImageRef {
    return { registry: s.host, apiHost: s.host, repository, tag: null, digest: null, dockerHub: false };
  }

  private async revisions(): Promise<Revision[]> {
    const { rows } = await this.pool.query<{ id: string; name: string; revision: number; compose: string; current: number; deployed: number | null }>(
      `SELECT s.id, s.name, r.revision, r.compose, s.current_revision AS current, s.deployed_revision AS deployed
         FROM stacks s JOIN stack_revisions r ON r.stack_id = s.id`,
    );
    return rows.map((r) => ({
      stackId: r.id,
      stackName: r.name,
      revision: r.revision,
      compose: r.compose,
      kind: r.revision === r.current ? "current" : r.revision === r.deployed ? "deployed" : "history",
    }));
  }

  /** Usages d'une image : références par digest ou par l'un de ses tags dans les révisions. */
  private usage(revisions: Revision[], host: string, repository: string, digest: string, tags: string[]): UsageRef[] {
    const refs = [`${host}/${repository}@${digest}`, ...tags.map((t) => `${host}/${repository}:${t}`)];
    const out: UsageRef[] = [];
    for (const r of revisions) {
      if (refs.some((ref) => mentions(r.compose, ref))) out.push({ stackId: r.stackId, stackName: r.stackName, revision: r.revision, kind: r.kind });
    }
    return out;
  }

  async list(): Promise<RegistryImagesView> {
    const s = await this.settings();
    const view: RegistryImagesView = {
      registry: s.host, reachable: false, error: null, repositories: [], truncated: false, totalBytes: 0,
      gcCommand: GARBAGE_COLLECT_COMMAND, containerHint: REGISTRY_STACK_NAME,
      retention: { mode: "off", keepPerRepository: 0 }, retentionCandidates: 0,
    };
    const retention = await getRetentionSettings(this.pool);
    view.retention = { mode: retention.mode, keepPerRepository: retention.keepPerRepository };
    let names: string[];
    try {
      const cat = await this.client.catalog(this.ref(s, "catalog"));
      names = cat.repositories.slice().sort();
      view.truncated = cat.truncated || names.length > MAX_REPOSITORIES;
      names = names.slice(0, MAX_REPOSITORIES);
      view.reachable = true;
    } catch (err) {
      view.error = err instanceof RegistryError ? err.message : "Registre injoignable.";
      return view;
    }

    const [revisions, jobs, used] = await Promise.all([
      this.revisions(),
      this.pool.query<{ id: string; status: string; repository: string; source_digest: string | null; patched_digest: string | null; created_at: Date }>(
        "SELECT id, status, repository, source_digest, patched_digest, created_at FROM remediation_jobs WHERE registry_host = $1 ORDER BY created_at",
        [s.host],
      ),
      loadUsedImages(this.pool),
    ]);
    const running = used.flatMap((i) => [...i.refs, ...i.usedBy.map((u) => u.ref)]);
    const activeRepos = new Set(
      (await this.pool.query<{ repository: string }>("SELECT DISTINCT repository FROM remediation_jobs WHERE registry_host = $1 AND status = ANY($2::text[])", [s.host, ACTIVE])).rows.map((r) => r.repository),
    );

    for (const repository of names) {
      const managed = repository.startsWith(MANAGED_PREFIX);
      const ref = this.ref(s, repository);
      const byDigest = new Map<string, RegistryImage>();
      let truncated: boolean;
      try {
        const { tags, truncated: more } = await this.client.listTags(ref);
        truncated = more || tags.length > MAX_TAGS_PER_REPOSITORY;
        for (const tag of tags.slice(0, MAX_TAGS_PER_REPOSITORY)) {
          let digest: string;
          try {
            digest = (await this.client.headManifest(ref, tag)).digest;
          } catch {
            continue; // tag supprimé entre-temps
          }
          const known = byDigest.get(digest);
          if (known) {
            known.tags.push(tag);
            continue;
          }
          byDigest.set(digest, {
            digest, tags: [tag], sizeBytes: null, kind: "other", remediation: null, createdAt: null, sourceDigest: null, retention: { candidate: false, reason: null }, blockers: [], history: [], deletable: false, reason: null,
          });
        }
      } catch {
        truncated = true; // dépôt illisible : la liste est incomplète
      }

      for (const img of byDigest.values()) {
        const patched = jobs.rows.filter((j) => j.repository === repository && j.patched_digest === img.digest).at(-1);
        const source = jobs.rows.filter((j) => j.repository === repository && j.source_digest === img.digest).at(-1);
        const job = patched ?? source ?? null;
        img.kind = patched ? "patched" : source ? "source" : "other";
        img.remediation = job ? { id: job.id, status: job.status } : null;
        img.createdAt = job?.created_at.toISOString() ?? null;
        img.sourceDigest = patched?.source_digest ?? null;
        try {
          img.sizeBytes = await this.client.manifestSize(ref, img.digest);
        } catch {
          img.sizeBytes = null;
        }
        view.totalBytes += img.sizeBytes ?? 0;

        const usage = this.usage(revisions, s.host, repository, img.digest, img.tags);
        img.history = usage.filter((u) => u.kind === "history");
        for (const u of usage.filter((x) => x.kind !== "history")) {
          img.blockers.push(`${u.kind === "current" ? "Révision courante" : "Révision déployée"} r${u.revision} de « ${u.stackName} »`);
        }
        const refs = [`${s.host}/${repository}@${img.digest}`, ...img.tags.map((t) => `${s.host}/${repository}:${t}`)];
        if (running.some((r) => refs.some((x) => mentions(r, x)))) img.blockers.push("Utilisée par un conteneur en cours");
        if (activeRepos.has(repository)) img.blockers.push("Un correctif est en cours pour ce dépôt");
        if (!managed) img.reason = "Image non créée par la console : supprimez-la depuis le registre lui-même.";
        else if (img.blockers.length > 0) img.reason = img.blockers.join(" ; ");
        img.deletable = managed && img.blockers.length === 0;
      }
      const images = [...byDigest.values()].sort((a, b) => a.tags[0]!.localeCompare(b.tags[0]!));
      if (managed) {
        const marks = markRetention(images, retention);
        for (const img of images) img.retention = marks.get(img.digest) ?? img.retention;
        view.retentionCandidates += images.filter((i) => i.retention.candidate).length;
      }
      view.repositories.push({ repository, managed, images, truncated });
    }
    return view;
  }

  /** Supprime l'image (par digest) si, et seulement si, aucun usage ne la protège. Les contrôles sont refaits ici. */
  async remove(input: { repository: string; digest: string; acceptHistory?: boolean | undefined }, actor: string, fresh?: RegistryImagesView): Promise<{ deleted: true; tags: string[]; gcCommand: string }> {
    const s = await this.settings();
    if (!input.repository.startsWith(MANAGED_PREFIX)) {
      throw new HttpError(409, "not_managed", "Seules les images créées par les correctifs peuvent être supprimées depuis la console.");
    }
    // `fresh` : vue calculée à l'instant par l'appelant (suppressions en série) ; sinon les protections sont recalculées.
    const view = fresh ?? (await this.list());
    if (!view.reachable) throw new HttpError(502, "registry_unreachable", view.error ?? "Registre injoignable.");
    const repo = view.repositories.find((r) => r.repository === input.repository);
    const img = repo?.images.find((i) => i.digest === input.digest);
    if (!repo || !img) throw new HttpError(404, "image_not_found", "Image introuvable dans le registre.");
    if (!img.deletable) throw new HttpError(409, "image_in_use", img.reason ?? "Cette image ne peut pas être supprimée.");
    if (img.history.length > 0 && !input.acceptHistory) {
      throw new HttpError(409, "history_requires_confirmation", `Des révisions plus anciennes la référencent (${img.history.map((h) => `${h.stackName} r${h.revision}`).join(", ")}) : un retour arrière ne pourrait plus la télécharger. Confirmez explicitement.`);
    }
    try {
      await this.client.deleteManifest(this.ref(s, input.repository), input.digest);
    } catch (err) {
      if (err instanceof RegistryError && err.code === "not_found") throw new HttpError(404, "image_not_found", "Image déjà supprimée du registre.");
      throw new HttpError(502, "registry_delete_failed", err instanceof RegistryError ? err.message : "Suppression impossible.");
    }
    await this.pool.query(
      "UPDATE remediation_jobs SET registry_deleted_at = now() WHERE registry_host = $1 AND repository = $2 AND patched_digest = $3 AND registry_deleted_at IS NULL",
      [s.host, input.repository, input.digest],
    );
    await audit(this.pool, actor, "registry.image.delete", `${input.repository}@${input.digest}`, "success");
    return { deleted: true, tags: img.tags, gcCommand: GARBAGE_COLLECT_COMMAND };
  }
}

export const RemoveImageBody = z.object({
  repository: z.string().min(1).max(255).regex(/^[a-z0-9]+([._/-][a-z0-9]+)*$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  acceptHistory: z.boolean().optional(),
});

/** Lecture : tout utilisateur ; suppression : administrateur (routes de réglages). */
export function registerRegistryImageRoutes(app: FastifyInstance, deps: { auth: Guard; images: RegistryImages }): void {
  const { auth, images } = deps;
  app.get("/api/v1/settings/registry/images", { preHandler: auth }, async () => images.list());
  app.post("/api/v1/settings/registry/images/delete", { preHandler: auth }, async (request) => images.remove(RemoveImageBody.parse(request.body), request.actor));
}
