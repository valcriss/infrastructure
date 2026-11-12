import {
  evaluateRemediation,
  patchEligibility,
  patchedTagFor,
  patchRepository,
  sourceCopyTag,
  type Bilan,
  type Eligibility,
  type PatchCancelMessage,
  type PatchMessage,
  type PatchPackageChange,
  type PatchProgress,
  type PatchResult,
  type PatchStage,
  type RegistryAuth,
} from "@infra/shared";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { loadUsedImages } from "./images.js";
import { parseImageRef } from "./image-ref.js";
import type { RegistryStore } from "./registries.js";
import { AUTO_ACTOR, RemediationAuto } from "./remediation-auto.js";
import { getRegistrySettings } from "./registry-app-routes.js";
import type { ScanService } from "./scans.js";

/** Version des règles (verdict, options de scan) : un changement autorise de nouveaux jobs sur les mêmes images. */
export const POLICY_VERSION = 1;
export const POLICY = "os_safe";
/** Un seul correctif à la fois par hôte (la vérification se fait dans la requête de démarrage), et deux au total. */
const MAX_RUNNING_TOTAL = 2;
/** Durée maximale confiée à l'agent ; au-delà (plus une marge) le résultat est déclaré indéterminé. */
export const PATCH_TIMEOUT_SEC = 30 * 60;
const STALE_MARGIN_MIN = 10;
/** Un job en attente sur un hôte hors ligne depuis plus longtemps que ça est abandonné. */
const STALE_QUEUED_MIN = 30;
/** Un agent qui ne confirme pas son annulation dans ce délai la rend « indéterminée ». */
const CANCEL_CONFIRM_SEC = 120;
/** Verrou consultatif PostgreSQL qui sérialise le démarrage des jobs (limites par hôte et globale). */
const PUMP_LOCK = 7_305_002;

export type JobStatus =
  | "queued" | "preparing" | "scanning_before" | "patching" | "scanning_after" | "verifying"
  | "validated" | "partial" | "rejected" | "failed" | "unknown" | "cancelled";

const ACTIVE: JobStatus[] = ["queued", "preparing", "scanning_before", "patching", "scanning_after", "verifying", "unknown"];
const RUNNING: JobStatus[] = ["preparing", "scanning_before", "patching", "scanning_after", "verifying"];

export interface RemediationTransport {
  isOnline(hostId: string): boolean;
  send(hostId: string, message: PatchMessage | PatchCancelMessage): boolean;
}

interface DbRow {
  id: string;
  image_id: string;
  platform: string;
  host_id: string;
  image_ref: string;
  source_scan_id: string | null;
  policy: string;
  policy_version: number;
  status: JobStatus;
  requested_by: string;
  registry_host: string;
  repository: string;
  source_tag: string;
  patched_tag: string;
  patch_number: number;
  source_digest: string | null;
  patched_digest: string | null;
  tools: Record<string, string> | null;
  bilan: Bilan | null;
  package_changes: PatchPackageChange[] | null;
  config_changes: string[] | null;
  labels_added: string[] | null;
  vex_statements: number | null;
  error: string | null;
  applied: JobView["applied"] | null;
  registry_deleted_at: Date | null;
  cancel_requested_at: Date | null;
  cancel_requested_by: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface JobView {
  id: string;
  imageId: string;
  platform: string;
  hostId: string;
  imageRef: string;
  policy: string;
  status: JobStatus;
  /** Étape terminale ou en cours, pour l'interface : le verdict est le statut quand le job est terminé. */
  active: boolean;
  requestedBy: string;
  registry: string;
  repository: string;
  sourceTag: string;
  patchedTag: string;
  /** Référence immuable à utiliser (digest), absente tant que l'image n'est pas produite. */
  patchedRef: string | null;
  sourceDigest: string | null;
  patchedDigest: string | null;
  tools: Record<string, string> | null;
  bilan: Bilan | null;
  packageChanges: PatchPackageChange[] | null;
  configChanges: string[] | null;
  labelsAdded: string[] | null;
  vexStatements: number | null;
  error: string | null;
  /** Où l'image corrigée a été proposée (révisions créées, jamais déployées par la console). */
  applied: { stackId: string; stackName: string; service: string; revision: number; by: string; at: string }[];
  /** L'image corrigée a été supprimée du registre : elle n'est plus utilisable. */
  imageDeleted: boolean;
  /** Une annulation a été demandée à l'agent et n'est pas encore confirmée. */
  cancelRequested: boolean;
  /** Préparé par la planification (et non à la demande d'un utilisateur). */
  automatic: boolean;
  /** Relu par un utilisateur (un correctif automatique est « à relire » tant qu'il ne l'est pas). */
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const COLUMNS = `id, image_id, platform, host_id, image_ref, source_scan_id, policy, policy_version, status, requested_by, registry_host,
  repository, source_tag, patched_tag, patch_number, source_digest, patched_digest, tools, bilan, package_changes, config_changes,
  labels_added, vex_statements, error, applied, registry_deleted_at, cancel_requested_at, cancel_requested_by, reviewed_at, reviewed_by, created_at, started_at, finished_at`;

const toView = (r: DbRow, detail: boolean): JobView => ({
  id: r.id,
  imageId: r.image_id,
  platform: r.platform,
  hostId: r.host_id,
  imageRef: r.image_ref,
  policy: r.policy,
  status: r.status,
  active: (ACTIVE as string[]).includes(r.status),
  requestedBy: r.requested_by,
  registry: r.registry_host,
  repository: r.repository,
  sourceTag: r.source_tag,
  patchedTag: r.patched_tag,
  patchedRef: r.patched_digest ? `${r.registry_host}/${r.repository}@${r.patched_digest}` : null,
  sourceDigest: r.source_digest,
  patchedDigest: r.patched_digest,
  tools: r.tools,
  // Les listes détaillées ne figurent que dans le détail d'un job, pas dans les listes.
  bilan: r.bilan && !detail ? { ...r.bilan, resolved: [], remaining: [], added: [] } : r.bilan,
  packageChanges: detail ? r.package_changes : null,
  configChanges: r.config_changes,
  labelsAdded: r.labels_added,
  vexStatements: r.vex_statements,
  error: r.error,
  applied: r.applied ?? [],
  imageDeleted: r.registry_deleted_at !== null,
  cancelRequested: r.cancel_requested_at !== null && (RUNNING as string[]).includes(r.status),
  automatic: r.requested_by === AUTO_ACTOR,
  reviewedAt: r.reviewed_at?.toISOString() ?? null,
  reviewedBy: r.reviewed_by,
  createdAt: r.created_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null,
  finishedAt: r.finished_at?.toISOString() ?? null,
});

export interface EligibilityReport extends Eligibility {
  imageId: string;
  platform: string;
  /** Hôtes qui portent l'image et peuvent la corriger. */
  hosts: { id: string; name: string; online: boolean; capable: boolean }[];
  registry: { ready: boolean; reason: string | null };
  /** Un job est déjà en cours pour ce contenu d'image. */
  activeJob: { id: string; status: JobStatus } | null;
  /** Tout est réuni pour lancer un correctif. */
  canStart: boolean;
}

export interface CreateRequest {
  imageId: string;
  platform: string;
  hostId?: string | undefined;
  requestedBy: string;
}

/**
 * Correctifs d'images. Un job est lié au contenu de l'image ; l'agent fait tout le travail (copie dans le registre,
 * scans, moteur) et la console décide du verdict d'après les deux scans. Rien n'est déployé et aucune image en cours
 * d'usage n'est modifiée. En cas de perte de connexion le résultat est « indéterminé » : jamais relancé à l'aveugle.
 */
export class RemediationService {
  private timer: NodeJS.Timeout | undefined;
  /** Préparation planifiée des correctifs (désactivée par défaut). */
  readonly auto: RemediationAuto;
  /** Démarrage des correctifs suspendu (ramasse-miettes du registre en cours) : les jobs restent en file. */
  private held = false;

  constructor(
    private readonly pool: Pool,
    private readonly transport: RemediationTransport,
    private readonly scans: Pick<ScanService, "latestSucceeded" | "vulnerabilities">,
    private readonly registries: Pick<RegistryStore, "credentials">,
    private readonly log: { warn(msg: string): void; error(obj: unknown, msg?: string): void } = { warn: () => {}, error: () => {} },
  ) {
    this.auto = new RemediationAuto(pool, this, (hostId) => transport.isOnline(hostId), log);
  }

  start(tickMs = 60_000): void {
    this.timer = setInterval(() => void this.tick().catch((e: unknown) => this.log.error(e, "boucle de correctifs")), tickMs);
    this.timer.unref();
    this.auto.start();
  }

  close(): void {
    clearInterval(this.timer);
    this.auto.close();
  }

  /** Au redémarrage de la console, un job en cours a un résultat inconnu : jamais relancé automatiquement. */
  async markInterrupted(): Promise<void> {
    await this.pool.query(
      `UPDATE remediation_jobs SET status = 'unknown', error = 'Console redémarrée pendant le correctif : le résultat est indéterminé.'
        WHERE status = ANY($1::text[])`,
      [RUNNING],
    );
  }

  // --- Lecture ---------------------------------------------------------------------------------------

  async get(id: string): Promise<JobView | null> {
    const { rows } = await this.pool.query<DbRow>(`SELECT ${COLUMNS} FROM remediation_jobs WHERE id = $1`, [id]);
    return rows[0] ? toView(rows[0], true) : null;
  }

  async list(filter: { imageId?: string | undefined; hostId?: string | undefined; status?: string | undefined; limit: number }): Promise<JobView[]> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT ${COLUMNS} FROM remediation_jobs
        WHERE ($1::text IS NULL OR image_id = $1) AND ($2::uuid IS NULL OR host_id = $2) AND ($3::text IS NULL OR status = $3)
        ORDER BY created_at DESC LIMIT $4`,
      [filter.imageId ?? null, filter.hostId ?? null, filter.status ?? null, filter.limit],
    );
    return rows.map((r) => toView(r, false));
  }

  /** Éligibilité d'une image : dernier scan, distribution, correctifs, hôtes capables et registre prêt. */
  async eligibility(imageId: string, platform: string | null): Promise<EligibilityReport> {
    const img = (await loadUsedImages(this.pool)).find((i) => i.imageId === imageId && (platform === null || i.platform === platform));
    if (!img) throw new HttpError(404, "image_not_found", "Image inconnue : elle n'est utilisée par aucun conteneur observé.");
    const scan = await this.scans.latestSucceeded(img.imageId, img.platform);
    const vulns = scan ? await this.scans.vulnerabilities(scan.id) : [];
    const base = patchEligibility(scan ? { os: scan.os, vulnerabilities: vulns, truncated: scan.truncated } : null);

    const caps = await this.pool.query<{ id: string; capabilities: string[] }>("SELECT id, capabilities FROM hosts WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL", [[...new Set(img.usedBy.map((u) => u.hostId))]]);
    const hosts = [...new Map(img.usedBy.map((u) => [u.hostId, u.hostName])).entries()].map(([id, name]) => ({
      id,
      name,
      online: this.transport.isOnline(id),
      capable: (caps.rows.find((c) => c.id === id)?.capabilities ?? []).includes("image.patch"),
    }));
    const registry = await this.registryReadiness();
    const active = await this.pool.query<{ id: string; status: JobStatus }>(
      "SELECT id, status FROM remediation_jobs WHERE image_id = $1 AND platform = $2 AND policy = $3 AND policy_version = $4 AND status = ANY($5::text[])",
      [img.imageId, img.platform, POLICY, POLICY_VERSION, ACTIVE],
    );
    const activeJob = active.rows[0] ?? null;
    return {
      ...base,
      imageId: img.imageId,
      platform: img.platform,
      hosts,
      registry,
      activeJob,
      canStart: base.eligible && registry.ready && !activeJob && hosts.some((h) => h.online && h.capable),
    };
  }

  /** Le registre privé est-il prêt à recevoir les images corrigées ? (application créée, déployée, mot de passe présent) */
  private async registryReadiness(): Promise<{ ready: boolean; reason: string | null }> {
    const settings = await getRegistrySettings(this.pool);
    if (!settings) return { ready: false, reason: "Aucun registre privé configuré : créez-le dans Paramètres → Registry." };
    const stack = await this.pool.query<{ deployed_revision: number | null }>("SELECT deployed_revision FROM stacks WHERE id = $1", [settings.stackId]);
    if (!stack.rows[0]) return { ready: false, reason: "L'application registry a été supprimée." };
    if (stack.rows[0].deployed_revision === null) return { ready: false, reason: "L'application registry n'est pas déployée." };
    const creds = await this.registries.credentials(settings.host);
    if (!creds?.username || !creds.password) return { ready: false, reason: "Le mot de passe du registre n'est plus disponible : renouvelez-le dans Paramètres → Registry." };
    return { ready: true, reason: null };
  }

  // --- Création --------------------------------------------------------------------------------------

  async create(input: CreateRequest): Promise<{ job: JobView; created: boolean }> {
    const report = await this.eligibility(input.imageId, input.platform);
    if (report.activeJob) {
      const existing = await this.get(report.activeJob.id);
      if (existing) return { job: existing, created: false };
    }
    if (!report.eligible) throw new HttpError(409, `not_eligible_${report.reason}`, report.message);
    if (!report.registry.ready) throw new HttpError(409, "registry_not_ready", report.registry.reason ?? "Registre non prêt.");

    const img = (await loadUsedImages(this.pool)).find((i) => i.imageId === report.imageId && i.platform === report.platform);
    const candidates = report.hosts.filter((h) => h.online && h.capable && (input.hostId === undefined || h.id === input.hostId));
    const host = candidates[0];
    if (!host || !img) {
      throw new HttpError(409, "no_capable_host", input.hostId ? "Cet hôte ne porte pas l'image, est hors ligne ou son agent est trop ancien (mettez-le à jour)." : "Aucun hôte en ligne, à jour et portant cette image.");
    }
    const settings = await getRegistrySettings(this.pool);
    if (!settings) throw new HttpError(409, "registry_not_ready", "Aucun registre privé configuré.");
    const ref = img.usedBy.find((u) => u.hostId === host.id)?.ref ?? img.refs[0] ?? img.imageId;
    const parsed = parseImageRef(ref);
    const repository = patchRepository(parsed?.registry ?? "local", parsed?.repository ?? img.imageId.replace(/^sha256:/, "").slice(0, 12));
    const scan = await this.scans.latestSucceeded(report.imageId, report.platform);

    // Numéro de correctif : le tag est immuable, un nouveau job prend toujours le numéro suivant.
    const id = await this.insert(
      { ...input, imageId: report.imageId, platform: report.platform },
      host.id, ref, scan?.id ?? null, settings.host, repository, parsed?.tag ?? null,
    );
    await audit(this.pool, input.requestedBy, "remediation.create", `${id} ${report.imageId}`, "success");
    void this.pumpAny().catch((e: unknown) => this.log.error(e, "démarrage des correctifs"));
    const job = await this.get(id);
    return { job: job as JobView, created: true };
  }

  private async insert(input: CreateRequest, hostId: string, ref: string, scanId: string | null, registryHost: string, repository: string, tag: string | null): Promise<string> {
    // Numéro suivant parmi les tags `<étiquette>-patch.<n>` déjà attribués pour ce dépôt (les jobs annulés comptent).
    const prefix = patchedTagFor(tag, 0).slice(0, -1);
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = await this.pool.query<{ n: number }>(
        "SELECT coalesce(max(patch_number), 0) + 1 AS n FROM remediation_jobs WHERE registry_host = $1 AND repository = $2 AND left(patched_tag, length($3)) = $3",
        [registryHost, repository, prefix],
      );
      const n = next.rows[0]?.n ?? 1;
      try {
        const { rows } = await this.pool.query<{ id: string }>(
          `INSERT INTO remediation_jobs (image_id, platform, host_id, image_ref, source_scan_id, policy, policy_version, status, requested_by,
                                         registry_host, repository, source_tag, patched_tag, patch_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10, $11, $12, $13) RETURNING id`,
          [input.imageId, input.platform, hostId, ref, scanId, POLICY, POLICY_VERSION, input.requestedBy, registryHost, repository, sourceCopyTag(input.imageId), patchedTagFor(tag, n), n],
        );
        return rows[0]?.id ?? "";
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === "23505" && e.constraint === "remediation_jobs_active_idx") {
          throw new HttpError(409, "already_running", "Un correctif est déjà en cours pour cette image.");
        }
        if (e.code === "23505") continue; // numéro de tag pris entre-temps : on recompte
        throw err;
      }
    }
    throw new HttpError(409, "tag_conflict", "Impossible d'attribuer un tag de correctif : réessayez.");
  }

  // --- Annulation ------------------------------------------------------------------------------------

  /** Marque un correctif terminé comme relu (sans effet s'il l'est déjà). */
  async review(id: string, actor: string): Promise<JobView> {
    const { rows } = await this.pool.query<DbRow>(
      `UPDATE remediation_jobs SET reviewed_at = coalesce(reviewed_at, now()), reviewed_by = coalesce(reviewed_by, $2)
        WHERE id = $1 AND NOT (status = ANY($3::text[])) RETURNING ${COLUMNS}`,
      [id, actor, ACTIVE],
    );
    if (!rows[0]) {
      if (!(await this.get(id))) throw new HttpError(404, "remediation_not_found", "Correctif introuvable.");
      throw new HttpError(409, "not_finished", "Ce correctif n'est pas terminé : il ne peut pas encore être relu.");
    }
    await audit(this.pool, actor, "remediation.review", id, "success");
    return toView(rows[0], true);
  }

  /** Correctifs préparés automatiquement, terminés avec une image utilisable, que personne n'a encore relus. */
  async toReview(): Promise<JobView[]> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT ${COLUMNS} FROM remediation_jobs
        WHERE requested_by = $1 AND status IN ('validated', 'partial') AND reviewed_at IS NULL AND registry_deleted_at IS NULL
        ORDER BY finished_at DESC LIMIT 100`,
      [AUTO_ACTOR],
    );
    return rows.map((r) => toView(r, false));
  }

  /**
   * Un job en attente est annulé. Un job « indéterminé » (connexion perdue) est abandonné par l'utilisateur, qui
   * assume de ne pas avoir vérifié le registre. Pour un job en cours, l'arrêt est DEMANDÉ à l'agent (processus tué,
   * conteneurs supprimés) : le job ne passe à « annulé » que lorsque l'agent le confirme, jamais avant.
   */
  async cancel(id: string, actor: string): Promise<JobView> {
    const { rows } = await this.pool.query<DbRow>(
      `UPDATE remediation_jobs SET status = 'cancelled', finished_at = now(),
              error = CASE WHEN status = 'unknown' THEN 'Abandonné par ' || $2 || ' (résultat indéterminé).' ELSE 'Annulé par ' || $2 || '.' END
        WHERE id = $1 AND status IN ('queued', 'unknown') RETURNING ${COLUMNS}`,
      [id, actor],
    );
    if (!rows[0]) return this.requestStop(id, actor);
    await audit(this.pool, actor, "remediation.cancel", id, "success");
    return toView(rows[0], true);
  }

  /** Demande à l'agent d'arrêter un correctif en cours ; l'état ne change qu'à sa confirmation. */
  private async requestStop(id: string, actor: string): Promise<JobView> {
    const { rows } = await this.pool.query<DbRow>(`SELECT ${COLUMNS} FROM remediation_jobs WHERE id = $1`, [id]);
    const job = rows[0];
    if (!job) throw new HttpError(404, "remediation_not_found", "Correctif introuvable.");
    if (!(RUNNING as string[]).includes(job.status)) throw new HttpError(409, "not_cancellable", "Ce correctif est déjà terminé.");
    if (job.cancel_requested_at) return toView(job, true); // demande déjà envoyée : sans effet
    const caps = await this.pool.query<{ capabilities: string[] }>("SELECT capabilities FROM hosts WHERE id = $1", [job.host_id]);
    if (!(caps.rows[0]?.capabilities ?? []).includes("image.patch.cancel")) {
      throw new HttpError(409, "agent_cannot_cancel", "L'agent de cet hôte ne sait pas annuler un correctif en cours : mettez-le à jour, ou attendez la fin de l'étape.");
    }
    if (!this.transport.send(job.host_id, { type: "patch_cancel", jobId: job.id })) {
      throw new HttpError(409, "host_offline", "L'hôte est hors ligne : l'annulation ne peut pas être demandée. Si la connexion est perdue, le correctif passe à « indéterminé » et peut être abandonné.");
    }
    const updated = await this.pool.query<DbRow>(
      `UPDATE remediation_jobs SET cancel_requested_at = now(), cancel_requested_by = $2 WHERE id = $1 AND status = ANY($3::text[]) RETURNING ${COLUMNS}`,
      [id, actor, RUNNING],
    );
    await audit(this.pool, actor, "remediation.cancel", `${id} (arrêt demandé à l'agent)`, "success");
    // Le correctif a pu se terminer entre-temps : on renvoie l'état réel.
    return toView(updated.rows[0] ?? job, true);
  }

  // --- File d'exécution ------------------------------------------------------------------------------

  /** Démarre ce qui peut l'être (un job par hôte, deux au total). */
  /** Suspend ou reprend le démarrage des correctifs ; à la reprise, la file repart. */
  hold(held: boolean): void {
    this.held = held;
    if (!held) void this.pumpAny().catch((e: unknown) => this.log.error(e, "reprise des correctifs"));
  }

  async pumpAny(): Promise<void> {
    if (this.held) return;
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [PUMP_LOCK]);
      for (;;) {
        const running = await client.query<{ host_id: string }>("SELECT host_id FROM remediation_jobs WHERE status = ANY($1::text[])", [RUNNING]);
        if (running.rows.length >= MAX_RUNNING_TOTAL) return;
        const busy = new Set(running.rows.map((r) => r.host_id));
        const queued = await client.query<DbRow>(`SELECT ${COLUMNS} FROM remediation_jobs WHERE status = 'queued' ORDER BY created_at`);
        const next = queued.rows.find((j) => !busy.has(j.host_id) && this.transport.isOnline(j.host_id));
        if (!next) return;
        if (!(await this.dispatch(client, next))) return;
      }
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [PUMP_LOCK]);
      } finally {
        client.release();
      }
    }
  }

  private async dispatch(client: { query: Pool["query"] }, job: DbRow): Promise<boolean> {
    const settings = await getRegistrySettings(this.pool);
    const creds = settings ? await this.registries.credentials(settings.host) : null;
    if (!settings || !creds?.username || !creds.password) {
      await client.query("UPDATE remediation_jobs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [job.id, "Le registre privé n'est plus utilisable (supprimé, ou mot de passe indisponible)."]);
      return true;
    }
    const auth: RegistryAuth = { registry: job.registry_host, username: creds.username, password: creds.password };
    const message: PatchMessage = {
      type: "patch",
      jobId: job.id,
      expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      imageId: job.image_id,
      imageRef: job.image_ref.slice(0, 300),
      platform: job.platform as PatchMessage["platform"],
      target: { registry: job.registry_host, repository: job.repository, sourceTag: job.source_tag, patchedTag: job.patched_tag },
      registryAuths: [auth],
      timeoutSec: PATCH_TIMEOUT_SEC,
    };
    await client.query("UPDATE remediation_jobs SET status = 'preparing', started_at = now() WHERE id = $1 AND status = 'queued'", [job.id]);
    if (!this.transport.send(job.host_id, message)) {
      await client.query("UPDATE remediation_jobs SET status = 'queued', started_at = NULL WHERE id = $1", [job.id]);
      return false;
    }
    return true;
  }

  // --- Retours de l'agent ----------------------------------------------------------------------------

  async onProgress(hostId: string, msg: PatchProgress): Promise<void> {
    await this.pool.query(
      "UPDATE remediation_jobs SET status = $3 WHERE id = $1 AND host_id = $2 AND status = ANY($4::text[])",
      [msg.jobId, hostId, msg.stage satisfies PatchStage, RUNNING],
    );
  }

  async onResult(hostId: string, msg: PatchResult): Promise<void> {
    const { rows } = await this.pool.query<DbRow>(`SELECT ${COLUMNS} FROM remediation_jobs WHERE id = $1 AND host_id = $2`, [msg.jobId, hostId]);
    const job = rows[0];
    // Résultat inconnu, d'un autre hôte, ou déjà traité (rejeu) : ignoré. Un job « indéterminé » accepte son résultat tardif.
    if (!job || !(RUNNING as string[]).concat(["unknown"]).includes(job.status)) return;

    if (msg.status === "cancelled") {
      const by = job.cancel_requested_by;
      await this.pool.query("UPDATE remediation_jobs SET status = 'cancelled', finished_at = now(), error = $2, tools = $3 WHERE id = $1", [
        job.id, by ? `Annulé par ${by}.` : "Arrêté sur l'hôte.", msg.tools ? JSON.stringify(msg.tools) : null,
      ]);
      await audit(this.pool, "agent", "remediation.finish", `${job.id} cancelled`, "success");
      void this.pumpAny().catch(() => undefined);
      return;
    }
    if (msg.status === "failed" || !msg.before || !msg.after || !msg.patched || !msg.source) {
      await this.pool.query("UPDATE remediation_jobs SET status = 'failed', finished_at = now(), error = $2, tools = $3 WHERE id = $1", [
        job.id, msg.error ?? "Le correctif a échoué sans détail.", msg.tools ? JSON.stringify(msg.tools) : null,
      ]);
      await audit(this.pool, "agent", "remediation.finish", `${job.id} failed`, "failure");
      void this.pumpAny().catch(() => undefined);
      return;
    }
    const bilan = evaluateRemediation({ before: msg.before, after: msg.after, configChanges: msg.configChanges ?? [], labelsAdded: msg.labelsAdded ?? [] });
    await this.pool.query(
      `UPDATE remediation_jobs SET status = $2, finished_at = now(), error = NULL, source_digest = $3, patched_digest = $4, tools = $5, bilan = $6,
              package_changes = $7, config_changes = $8, labels_added = $9, vex_statements = $10 WHERE id = $1`,
      [
        job.id, bilan.verdict, msg.source.digest, msg.patched.digest, msg.tools ? JSON.stringify(msg.tools) : null, JSON.stringify(bilan),
        JSON.stringify(msg.packageChanges ?? []), JSON.stringify(msg.configChanges ?? []), JSON.stringify(msg.labelsAdded ?? []), msg.vexStatements ?? null,
      ],
    );
    await audit(this.pool, "agent", "remediation.finish", `${job.id} ${bilan.verdict}`, "success");
    void this.pumpAny().catch(() => undefined);
  }

  /** Connexion perdue : le résultat réel est indéterminé (le travail a pu aboutir). Réconcilié si le résultat arrive plus tard. */
  async onDisconnect(hostId: string): Promise<void> {
    await this.pool.query(
      `UPDATE remediation_jobs SET status = 'unknown', error = 'Connexion à l''agent perdue pendant le correctif : le résultat est indéterminé. Vérifiez le registre avant de relancer.'
        WHERE host_id = $1 AND status = ANY($2::text[])`,
      [hostId, RUNNING],
    );
  }

  private async tick(): Promise<void> {
    await this.pool.query(
      `UPDATE remediation_jobs SET status = 'unknown', error = 'Aucun retour de l''agent dans le délai prévu : le résultat est indéterminé.'
        WHERE status = ANY($1::text[]) AND started_at < now() - ($2 || ' seconds')::interval`,
      [RUNNING, String(PATCH_TIMEOUT_SEC + STALE_MARGIN_MIN * 60)],
    );
    // Annulation non confirmée : l'agent a peut-être déjà fini, ou ne répond plus. Résultat indéterminé, jamais « annulé ».
    await this.pool.query(
      `UPDATE remediation_jobs SET status = 'unknown', error = 'L''agent n''a pas confirmé l''annulation : le résultat est indéterminé. Vérifiez le registre avant de relancer.'
        WHERE status = ANY($1::text[]) AND cancel_requested_at < now() - ($2 || ' seconds')::interval`,
      [RUNNING, String(CANCEL_CONFIRM_SEC)],
    );
    await this.pool.query(
      `UPDATE remediation_jobs SET status = 'failed', finished_at = now(), error = 'Hôte hors ligne trop longtemps : correctif abandonné.'
        WHERE status = 'queued' AND created_at < now() - ($1 || ' minutes')::interval`,
      [String(STALE_QUEUED_MIN)],
    );
    await this.pumpAny();
  }
}
