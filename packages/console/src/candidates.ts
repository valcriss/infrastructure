import type { ConsoleMessage } from "@infra/shared";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { loadUsedImages } from "./images.js";
import { parseImageRef } from "./image-ref.js";
import type { RegistryStore } from "./registries.js";
import type { ScanService } from "./scans.js";

export interface CandidateTransport {
  isOnline(hostId: string): boolean;
  send(hostId: string, message: ConsoleMessage): boolean;
}

export interface CandidateRow {
  id: string;
  stackId: string;
  service: string;
  hostId: string;
  ref: string;
  baseRef: string;
  status: "pulling" | "scanning" | "succeeded" | "failed";
  error: string | null;
  imageId: string | null;
  platform: string | null;
  scanId: string | null;
  requestedBy: string;
  createdAt: Date;
  finishedAt: Date | null;
}

interface Db {
  id: string;
  stack_id: string;
  service: string;
  host_id: string;
  ref: string;
  base_ref: string;
  status: CandidateRow["status"];
  error: string | null;
  image_id: string | null;
  platform: string | null;
  scan_id: string | null;
  requested_by: string;
  created_at: Date;
  finished_at: Date | null;
}

const toRow = (r: Db): CandidateRow => ({
  id: r.id,
  stackId: r.stack_id,
  service: r.service,
  hostId: r.host_id,
  ref: r.ref,
  baseRef: r.base_ref,
  status: r.status,
  error: r.error,
  imageId: r.image_id,
  platform: r.platform,
  scanId: r.scan_id,
  requestedBy: r.requested_by,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

const COLUMNS = "id, stack_id, service, host_id, ref, base_ref, status, error, image_id, platform, scan_id, requested_by, created_at, finished_at";
/** Au plus 2 téléchargements/scans de comparaison à la fois : disque et bande passante de l'hôte. */
const MAX_ACTIVE = 2;
const PULL_TIMEOUT_MIN = 20;
/** Un résultat récent est réutilisé au lieu de re-télécharger la même image. */
const REUSE_HOURS = 6;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Référence identique à l'actuelle, avec une autre étiquette (conserve le registre et le nom tels qu'écrits). */
export function withTag(ref: string, tag: string): string {
  const at = ref.indexOf("@");
  const base = at === -1 ? ref : ref.slice(0, at);
  const lastSlash = base.lastIndexOf("/");
  const colon = base.indexOf(":", lastSlash + 1);
  return `${colon === -1 ? base : base.slice(0, colon)}:${tag}`;
}

/**
 * Comparaison des vulnérabilités d'une autre version d'image : téléchargement sur l'hôte, scan, puis retrait de
 * l'image. Rien n'est déployé ni modifié ; sert à décider d'un changement de version en connaissance de cause.
 */
export class CandidateScans {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly scans: ScanService,
    private readonly transport: CandidateTransport,
    private readonly registries: Pick<RegistryStore, "authsFor">,
  ) {}

  start(tickMs = 15_000): void {
    this.timer = setInterval(() => void this.tick().catch(() => {}), tickMs);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  async get(id: string): Promise<CandidateRow | null> {
    const { rows } = await this.pool.query<Db>(`SELECT ${COLUMNS} FROM candidate_scans WHERE id = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(stackId: string): Promise<CandidateRow[]> {
    const { rows } = await this.pool.query<Db>(`SELECT ${COLUMNS} FROM candidate_scans WHERE stack_id = $1 AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT 30`, [stackId]);
    return rows.map(toRow);
  }

  /**
   * Ferme des comparaisons : elles ne sont plus proposées (ni réutilisées si on compare de nouveau la même version).
   * Sans identifiant, ferme toutes celles du service. L'image candidate est toujours nettoyée sur l'hôte.
   */
  async dismiss(input: { stackId: string; scanId?: string; service?: string; actor: string }): Promise<number> {
    const r = await this.pool.query(
      `UPDATE candidate_scans SET dismissed_at = now()
        WHERE stack_id = $1 AND dismissed_at IS NULL AND ($2::uuid IS NULL OR id = $2) AND ($3::text IS NULL OR service = $3)`,
      [input.stackId, input.scanId ?? null, input.service ?? null],
    );
    const n = r.rowCount ?? 0;
    if (input.scanId && n === 0) throw new HttpError(404, "candidate_not_found", "Comparaison introuvable ou déjà fermée.");
    if (n > 0) await audit(this.pool, input.actor, "candidate-scan.dismiss", `${input.stackId}${input.service ? "/" + input.service : ""}${input.scanId ? "@" + input.scanId : ""} (${n})`, "success");
    return n;
  }

  async begin(input: { stackId: string; service: string; tag: string; actor: string }): Promise<{ row: CandidateRow; created: boolean }> {
    if (!TAG.test(input.tag)) throw new HttpError(400, "invalid_tag", "Étiquette invalide.");
    const stack = await this.pool.query<{ host_id: string }>("SELECT host_id FROM stacks WHERE id = $1", [input.stackId]);
    if (!stack.rows[0]) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    const hostId = stack.rows[0].host_id;
    const images = await loadUsedImages(this.pool, { stackId: input.stackId });
    const used = images.flatMap((i) => i.usedBy).find((u) => u.service === input.service);
    if (!used) throw new HttpError(404, "service_not_found", "Service introuvable ou jamais déployé : aucune image observée.");
    const parsed = parseImageRef(used.ref);
    if (!parsed) throw new HttpError(422, "unsupported_ref", "Référence d'image non comparable (identifiant brut).");
    if (parsed.digest) throw new HttpError(422, "pinned_image", "Image épinglée par digest : indiquez la version à comparer en modifiant le Compose.");
    const ref = withTag(used.ref, input.tag);
    if (ref === used.ref) throw new HttpError(400, "same_image", "C'est la version actuellement déployée.");

    const recent = await this.pool.query<Db>(
      `SELECT ${COLUMNS} FROM candidate_scans
        WHERE stack_id = $1 AND service = $2 AND ref = $3 AND status IN ('pulling', 'scanning', 'succeeded')
          AND dismissed_at IS NULL AND created_at > now() - make_interval(hours => $4) ORDER BY created_at DESC LIMIT 1`,
      [input.stackId, input.service, ref, REUSE_HOURS],
    );
    if (recent.rows[0]) return { row: toRow(recent.rows[0]), created: false };

    const active = await this.pool.query("SELECT 1 FROM candidate_scans WHERE status IN ('pulling', 'scanning')");
    if ((active.rowCount ?? 0) >= MAX_ACTIVE) throw new HttpError(429, "too_many_comparisons", "Deux comparaisons sont déjà en cours : patientez.");
    if (!this.transport.isOnline(hostId)) throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne.");

    const { rows } = await this.pool.query<Db>(
      `INSERT INTO candidate_scans (stack_id, service, host_id, ref, base_ref, status, requested_by)
       VALUES ($1, $2, $3, $4, $5, 'pulling', $6) RETURNING ${COLUMNS}`,
      [input.stackId, input.service, hostId, ref, used.ref, input.actor],
    );
    const row = toRow(rows[0] as Db);
    await audit(this.pool, input.actor, "candidate-scan.start", `${input.service}: ${ref}`, "success");
    const registryAuths = await this.registries.authsFor([ref]);
    const sent = this.transport.send(hostId, {
      type: "image_pull",
      pullId: row.id,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      ref,
      ...(registryAuths.length > 0 ? { registryAuths } : {}),
    });
    if (!sent) await this.fail(row.id, "Agent hors ligne : téléchargement non envoyé.");
    return { row: (await this.get(row.id)) ?? row, created: true };
  }

  private async fail(id: string, error: string): Promise<void> {
    await this.pool.query("UPDATE candidate_scans SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status IN ('pulling', 'scanning')", [id, error.slice(0, 500)]);
  }

  /** Résultat du téléchargement : on lance le scan de l'image obtenue. */
  async onPullResult(hostId: string, msg: { pullId: string; status: "succeeded" | "failed"; error?: string; imageId?: string; platform?: string }): Promise<void> {
    const row = await this.get(msg.pullId);
    if (!row || row.hostId !== hostId || row.status !== "pulling") return;
    if (msg.status === "failed" || !msg.imageId) return this.fail(row.id, msg.error ?? "Téléchargement impossible.");
    try {
      const { scan } = await this.scans.request({
        imageId: msg.imageId,
        platform: msg.platform ?? "",
        hostId,
        imageRef: row.ref,
        trigger: "manual",
        requestedBy: row.requestedBy,
        candidate: true,
      });
      await this.pool.query("UPDATE candidate_scans SET status = 'scanning', image_id = $2, platform = $3, scan_id = $4 WHERE id = $1", [row.id, msg.imageId, msg.platform ?? "", scan.id]);
    } catch (err) {
      await this.fail(row.id, err instanceof HttpError ? err.message : "Scan impossible à lancer.");
    }
  }

  /** Suit les scans, retire les images téléchargées une fois le scan terminé, abandonne les téléchargements perdus. */
  async tick(): Promise<void> {
    await this.pool.query(
      `UPDATE candidate_scans SET status = 'failed', error = 'Délai dépassé : le téléchargement n''a pas abouti.', finished_at = now()
        WHERE status = 'pulling' AND created_at < now() - make_interval(mins => $1)`,
      [PULL_TIMEOUT_MIN],
    );
    const scanning = await this.pool.query<Db>(`SELECT ${COLUMNS} FROM candidate_scans WHERE status = 'scanning'`);
    for (const r of scanning.rows) {
      const scan = r.scan_id ? await this.scans.get(r.scan_id) : null;
      if (!scan) await this.fail(r.id, "Scan introuvable.");
      else if (scan.status === "succeeded") await this.pool.query("UPDATE candidate_scans SET status = 'succeeded', finished_at = now() WHERE id = $1", [r.id]);
      else if (scan.status === "failed") await this.fail(r.id, scan.error ?? "Échec du scan.");
    }
    // Nettoyage : l'image téléchargée n'a plus d'usage (Docker refuse de retirer une image utilisée par un conteneur).
    const toClean = await this.pool.query<{ id: string; host_id: string; image_id: string }>(
      "SELECT id, host_id, image_id FROM candidate_scans WHERE status IN ('succeeded', 'failed') AND image_id IS NOT NULL AND cleaned_at IS NULL",
    );
    for (const c of toClean.rows) {
      if (this.transport.isOnline(c.host_id)) this.transport.send(c.host_id, { type: "image_remove", imageId: c.image_id });
      await this.pool.query("UPDATE candidate_scans SET cleaned_at = now() WHERE id = $1", [c.id]);
    }
  }
}
