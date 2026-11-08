import { listComposeServices, type ImageInfo } from "@infra/shared";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { loadUsedImages } from "./images.js";
import { localRepoDigest, parseImageRef } from "./image-ref.js";
import { POLICIES, pickCandidates, validatePattern, type UpdatePolicy } from "./image-tags.js";
import type { ManifestHead, Platform, RegistryClient, ResolvedManifest } from "./registry.js";
import { RegistryError } from "./registry.js";
import { bumpConfigRevision } from "./stacks.js";
import { getSecuritySettings } from "./settings.js";

/** Ce dont l'évaluation a besoin du registre (substituable dans les tests). */
export interface RegistryLike {
  headManifest: RegistryClient["headManifest"];
  resolvePlatform: RegistryClient["resolvePlatform"];
  listTags: RegistryClient["listTags"];
  configLayers: RegistryClient["configLayers"];
}

export type CheckKind = "up_to_date" | "update_available" | "pinned" | "local" | "unsupported";

export interface CheckDetail {
  ref: string;
  registry: string | null;
  repository: string | null;
  tag: string | null;
  /** Digest de registre de l'image déployée (celui de l'index pour une image multi-architecture). */
  deployedDigest: string | null;
  remoteDigest: string | null;
  platform: string;
  /** Même tag mais contenu différent côté registre : vrai / faux / null (indéterminable). */
  contentChanged: boolean | null;
  candidates: string[];
  /** Versions proposées par la règle de suivi mais écartées par l'utilisateur (absent sur les anciens résultats). */
  ignored?: string[];
  /** La décision repose sur une heuristique (tag non interprétable, expression libre). */
  uncertain: boolean;
  tagsTruncated: boolean;
  policy: UpdatePolicy;
  pattern: string | null;
  notes: string[];
}

export interface CheckOutcome {
  kind: CheckKind;
  detail: CheckDetail;
}

export interface EvaluateInput {
  ref: string;
  imageId: string;
  image: Pick<ImageInfo, "repoDigests" | "os" | "arch" | "variant" | "layers"> | null;
  policy: UpdatePolicy;
  pattern: string | null;
  /** Versions à ne plus proposer pour ce composant. */
  ignored?: string[];
}

const empty = (input: EvaluateInput): CheckDetail => ({
  ref: input.ref,
  registry: null,
  repository: null,
  tag: null,
  deployedDigest: null,
  remoteDigest: null,
  platform: "",
  contentChanged: null,
  candidates: [],
  ignored: [],
  uncertain: false,
  tagsTruncated: false,
  policy: input.policy,
  pattern: input.pattern,
  notes: [],
});

/**
 * Compare l'image déployée à ce que propose le registre : (1) même tag mais
 * contenu différent, pour la plateforme cible ; (2) nouveaux tags selon la
 * politique du composant. Ne télécharge aucune image et ne déploie rien.
 * Lève RegistryError : l'appelant conserve alors la dernière observation.
 */
export async function evaluateImage(input: EvaluateInput, client: RegistryLike): Promise<CheckOutcome> {
  const detail = empty(input);
  const parsed = parseImageRef(input.ref);
  if (!parsed) {
    detail.notes.push("Référence d'image non interprétable.");
    return { kind: "unsupported", detail };
  }
  detail.registry = parsed.registry;
  detail.repository = parsed.repository;
  detail.tag = parsed.tag;

  if (parsed.digest && !parsed.tag) {
    detail.deployedDigest = parsed.digest;
    detail.notes.push("Image épinglée par digest : son contenu ne peut pas dériver. Changez le digest dans le Compose pour la mettre à jour.");
    return { kind: "pinned", detail };
  }
  if (!input.image) {
    detail.notes.push("Informations d'image indisponibles pour le moment (inventaire de l'hôte).");
    return { kind: "unsupported", detail };
  }
  const local = localRepoDigest(input.image, parsed);
  if (!local) {
    detail.notes.push(
      input.image.repoDigests.length === 0
        ? "Image locale (construite ou chargée sans registre) : aucune comparaison possible."
        : "Cette image n'a pas été téléchargée depuis ce dépôt : aucune comparaison possible.",
    );
    return { kind: "local", detail };
  }
  detail.deployedDigest = local;
  const platform: Platform | null = input.image.os && input.image.arch ? { os: input.image.os, arch: input.image.arch, ...(input.image.variant ? { variant: input.image.variant } : {}) } : null;
  detail.platform = platform ? `${platform.os}/${platform.arch}${platform.variant ? `/${platform.variant}` : ""}` : "";

  // 1. Même tag, contenu différent ?
  const head: ManifestHead = await client.headManifest(parsed, parsed.tag as string);
  detail.remoteDigest = head.digest;
  if (head.digest === local) {
    detail.contentChanged = false;
  } else if (!platform) {
    detail.contentChanged = null;
    detail.notes.push("Plateforme de l'image inconnue : le tag a changé mais l'effet sur votre variante n'est pas déterminable.");
  } else {
    try {
      const remote: ResolvedManifest = await client.resolvePlatform(parsed, parsed.tag as string, platform);
      let same = [remote.manifestDigest, remote.configDigest].some((d) => d !== null && (d === input.imageId || d === local));
      let repackaged = false;
      // Les identifiants locaux et distants peuvent différer sans que le contenu change (image poussée depuis un
      // index multi-plateforme, autre compression…) : on compare alors les couches décrites par la configuration.
      if (!same && remote.configDigest && input.image.layers && input.image.layers.length > 0) {
        const remoteLayers = await client.configLayers(parsed, remote.configDigest);
        same = remoteLayers.length === input.image.layers.length && remoteLayers.every((l, i) => l === input.image?.layers?.[i]);
        repackaged = same;
      }
      detail.contentChanged = !same;
      if (same) {
        detail.notes.push(
          repackaged
            ? "Le registre expose un autre empaquetage (digest différent) du même contenu : les couches sont identiques."
            : "Le tag a été republié pour d'autres plateformes ; la variante de cet hôte est inchangée.",
        );
      }
    } catch (err) {
      if (!(err instanceof RegistryError) || err.code !== "unsupported") throw err;
      detail.contentChanged = null;
      detail.notes.push(err.message);
    }
  }

  // 2. Nouveaux tags selon la politique.
  if (input.policy !== "same_tag") {
    if (input.policy === "pattern" && validatePattern(input.pattern ?? "") !== null) {
      detail.notes.push("Expression de suivi invalide : aucune recherche de tags.");
    } else {
      const { tags, truncated } = await client.listTags(parsed);
      detail.tagsTruncated = truncated;
      const found = pickCandidates(parsed.tag as string, tags, input.policy, input.pattern);
      const hidden = new Set(input.ignored ?? []);
      detail.candidates = found.candidates.filter((t) => !hidden.has(t));
      detail.ignored = found.candidates.filter((t) => hidden.has(t));
      detail.uncertain = found.uncertain;
      detail.notes.push(...found.notes);
      if (truncated) detail.notes.push("Liste de tags tronquée (dépôt très volumineux) : des candidats ont pu échapper à la recherche.");
    }
  }

  const update = detail.contentChanged === true || detail.candidates.length > 0;
  return { kind: update ? "update_available" : "up_to_date", detail };
}

// --- Persistance et planification ---------------------------------------------------------------

export interface CheckRow {
  stackId: string;
  service: string;
  checkedAt: Date;
  status: "ok" | "error";
  kind: CheckKind | null;
  detail: CheckDetail | null;
  error: string | null;
  lastSuccessAt: Date | null;
}

export interface PolicyRow {
  policy: UpdatePolicy;
  pattern: string | null;
}

export class ImageWatcher {
  private timer: NodeJS.Timeout | undefined;
  private readonly checking = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly client: RegistryLike,
    private readonly log: { error(obj: unknown, msg?: string): void } = { error: () => {} },
  ) {}

  start(tickMs = 5 * 60_000): void {
    this.timer = setInterval(() => void this.scheduledPass().catch((e: unknown) => this.log.error(e, "vérification des images")), tickMs);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  isChecking(stackId: string): boolean {
    return this.checking.has(stackId);
  }

  async policies(stackId: string): Promise<Record<string, PolicyRow>> {
    const { rows } = await this.pool.query<{ service: string; policy: UpdatePolicy; pattern: string | null }>(
      "SELECT service, policy, pattern FROM image_policies WHERE stack_id = $1",
      [stackId],
    );
    return Object.fromEntries(rows.map((r) => [r.service, { policy: r.policy, pattern: r.pattern }]));
  }

  /** Versions écartées par composant : { service: [{ tag, reason, createdBy, createdAt }] }. */
  async ignoredTags(stackId: string): Promise<Record<string, { tag: string; reason: string | null; createdBy: string; createdAt: Date }[]>> {
    const { rows } = await this.pool.query<{ service: string; tag: string; reason: string | null; created_by: string; created_at: Date }>(
      "SELECT service, tag, reason, created_by, created_at FROM image_ignored_tags WHERE stack_id = $1 ORDER BY created_at",
      [stackId],
    );
    const out: Record<string, { tag: string; reason: string | null; createdBy: string; createdAt: Date }[]> = {};
    for (const r of rows) (out[r.service] ??= []).push({ tag: r.tag, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at });
    return out;
  }

  /**
   * Ne plus proposer cette version pour ce composant. Le dernier résultat est corrigé tout de suite (sans interroger le
   * registre) : la proposition et l'alerte disparaissent immédiatement.
   */
  async ignoreTag(stackId: string, service: string, tag: string, reason: string | null, actor: string): Promise<void> {
    const stack = await this.pool.query("SELECT 1 FROM stacks WHERE id = $1", [stackId]);
    if (stack.rowCount === 0) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    await this.pool.query(
      `INSERT INTO image_ignored_tags (stack_id, service, tag, reason, created_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stack_id, service, tag) DO UPDATE SET reason = $4`,
      [stackId, service, tag, reason, actor],
    );
    const row = await this.pool.query<{ kind: CheckKind | null; detail: CheckDetail | null }>("SELECT kind, detail FROM image_checks WHERE stack_id = $1 AND service = $2", [stackId, service]);
    const found = row.rows[0];
    if (found?.detail && found.detail.candidates.includes(tag)) {
      const detail: CheckDetail = { ...found.detail, candidates: found.detail.candidates.filter((t) => t !== tag), ignored: [...new Set([...(found.detail.ignored ?? []), tag])] };
      const kind: CheckKind = found.kind === "update_available" && detail.contentChanged !== true && detail.candidates.length === 0 ? "up_to_date" : (found.kind ?? "up_to_date");
      await this.pool.query("UPDATE image_checks SET kind = $3, detail = $4 WHERE stack_id = $1 AND service = $2", [stackId, service, kind, JSON.stringify(detail)]);
    }
    await audit(this.pool, actor, "image-tag.ignore", `${stackId}/${service}@${tag}`, "success");
  }

  /** Propose de nouveau la version : une vérification est relancée pour la retrouver. */
  async unignoreTag(stackId: string, service: string, tag: string, actor: string): Promise<void> {
    const r = await this.pool.query("DELETE FROM image_ignored_tags WHERE stack_id = $1 AND service = $2 AND tag = $3", [stackId, service, tag]);
    if (r.rowCount === 0) throw new HttpError(404, "ignored_tag_not_found", "Cette version n'est pas ignorée.");
    await audit(this.pool, actor, "image-tag.unignore", `${stackId}/${service}@${tag}`, "success");
    void this.checkStack(stackId).catch(() => {});
  }

  async setPolicy(stackId: string, service: string, policy: UpdatePolicy, pattern: string | null, actor: string): Promise<void> {
    if (!POLICIES.includes(policy)) throw new HttpError(400, "invalid_policy", "Politique inconnue.");
    if (policy === "pattern") {
      const err = validatePattern(pattern ?? "");
      if (err) throw new HttpError(400, "invalid_pattern", err);
    }
    const stack = await this.pool.query("SELECT 1 FROM stacks WHERE id = $1", [stackId]);
    if (stack.rowCount === 0) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    await this.pool.query(
      `INSERT INTO image_policies (stack_id, service, policy, pattern) VALUES ($1, $2, $3, $4)
       ON CONFLICT (stack_id, service) DO UPDATE SET policy = $3, pattern = $4, updated_at = now()`,
      [stackId, service, policy, policy === "pattern" ? pattern : null],
    );
    // Les règles de suivi font partie de la configuration sauvegardée dans Git.
    await bumpConfigRevision(this.pool);
    await audit(this.pool, actor, "image-policy.set", `${stackId}/${service}`, "success");
  }

  async checks(stackId: string): Promise<CheckRow[]> {
    const { rows } = await this.pool.query<{
      service: string;
      checked_at: Date;
      status: "ok" | "error";
      kind: CheckKind | null;
      detail: CheckDetail | null;
      error: string | null;
      last_success_at: Date | null;
    }>("SELECT service, checked_at, status, kind, detail, error, last_success_at FROM image_checks WHERE stack_id = $1", [stackId]);
    return rows.map((r) => ({
      stackId,
      service: r.service,
      checkedAt: r.checked_at,
      status: r.status,
      kind: r.kind,
      detail: r.detail,
      error: r.error,
      lastSuccessAt: r.last_success_at,
    }));
  }

  /** Dernières vérifications de toutes les stacks (tableau de bord et alertes). */
  async allChecks(): Promise<(CheckRow & { stackName: string })[]> {
    const { rows } = await this.pool.query<{
      stack_id: string; stack_name: string; service: string; checked_at: Date; status: "ok" | "error";
      kind: CheckKind | null; detail: CheckDetail | null; error: string | null; last_success_at: Date | null;
    }>(`SELECT c.stack_id, s.name AS stack_name, c.service, c.checked_at, c.status, c.kind, c.detail, c.error, c.last_success_at
          FROM image_checks c JOIN stacks s ON s.id = c.stack_id`);
    return rows.map((r) => ({ stackId: r.stack_id, stackName: r.stack_name, service: r.service, checkedAt: r.checked_at, status: r.status, kind: r.kind, detail: r.detail, error: r.error, lastSuccessAt: r.last_success_at }));
  }

  /** Vérifie tous les composants en marche d'une stack. Un échec de registre conserve la dernière observation. */
  async checkStack(stackId: string): Promise<void> {
    if (this.checking.has(stackId)) return;
    this.checking.add(stackId);
    try {
      const policies = await this.policies(stackId);
      const ignored = await this.ignoredTags(stackId);
      const images = await loadUsedImages(this.pool, { stackId });
      const done = new Set<string>();
      for (const img of images) {
        for (const user of img.usedBy) {
          if (!user.service || done.has(user.service)) continue;
          done.add(user.service);
          const policy = policies[user.service] ?? { policy: "same_tag" as const, pattern: null };
          try {
            const out = await evaluateImage({ ref: user.ref, imageId: img.imageId, image: img.info, policy: policy.policy, pattern: policy.pattern, ignored: (ignored[user.service] ?? []).map((i) => i.tag) }, this.client);
            await this.pool.query(
              `INSERT INTO image_checks (stack_id, service, checked_at, status, kind, detail, error, last_success_at)
               VALUES ($1, $2, now(), 'ok', $3, $4, NULL, now())
               ON CONFLICT (stack_id, service) DO UPDATE SET checked_at = now(), status = 'ok', kind = $3, detail = $4, error = NULL, last_success_at = now()`,
              [stackId, user.service, out.kind, JSON.stringify(out.detail)],
            );
          } catch (err) {
            const message = err instanceof RegistryError ? err.message : "Erreur inattendue lors de la vérification.";
            if (!(err instanceof RegistryError)) this.log.error(err, "vérification d'image");
            await this.pool.query(
              `INSERT INTO image_checks (stack_id, service, checked_at, status, error) VALUES ($1, $2, now(), 'error', $3)
               ON CONFLICT (stack_id, service) DO UPDATE SET checked_at = now(), status = 'error', error = $3`,
              [stackId, user.service, message.slice(0, 500)],
            );
          }
        }
      }
      await this.pruneRemovedServices(stackId);
    } finally {
      this.checking.delete(stackId);
    }
  }

  /**
   * Retire les vérifications des services qui ne figurent plus dans le Compose déployé : sans cela, une alerte
   * « mise à jour disponible » ou « vérification impossible » resterait affichée pour un service supprimé.
   */
  private async pruneRemovedServices(stackId: string): Promise<void> {
    const { rows } = await this.pool.query<{ compose: string | null }>(
      `SELECT r.compose FROM stacks s LEFT JOIN stack_revisions r ON r.stack_id = s.id AND r.revision = s.deployed_revision WHERE s.id = $1`,
      [stackId],
    );
    const compose = rows[0]?.compose;
    if (!compose) return; // Compose indisponible (jamais déployée, chiffrée) : on ne supprime rien
    const services = listComposeServices(compose).map((s) => s.name);
    if (services.length === 0) return; // YAML illisible : prudence
    await this.pool.query("DELETE FROM image_checks WHERE stack_id = $1 AND service <> ALL($2::text[])", [stackId, services]);
  }

  async scheduledPass(now = Date.now()): Promise<number> {
    const { imageCheckIntervalHours } = await getSecuritySettings(this.pool);
    if (imageCheckIntervalHours === 0) return 0;
    const stacks = await this.pool.query<{ id: string; last: Date | null }>(
      `SELECT s.id, (SELECT min(c.checked_at) FROM image_checks c WHERE c.stack_id = s.id) AS last
         FROM stacks s JOIN hosts h ON h.id = s.host_id WHERE s.deployed_revision IS NOT NULL AND h.revoked_at IS NULL`,
    );
    let n = 0;
    for (const s of stacks.rows) {
      if (s.last && now - s.last.getTime() < imageCheckIntervalHours * 3600_000) continue;
      await this.checkStack(s.id);
      n++;
    }
    return n;
  }
}
