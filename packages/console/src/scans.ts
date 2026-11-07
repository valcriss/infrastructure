import type { ScanMessage, ScanResult, SeverityCounts, Vulnerability } from "@infra/shared";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { loadUsedImages, type ImageUser } from "./images.js";
import { getSecuritySettings } from "./settings.js";

/** Un seul scan à la fois, tous hôtes confondus : la file est strictement séquentielle (et l'usage disque borné). */
const MAX_RUNNING_TOTAL = 1;
/** Un scan « en cours » plus longtemps que ça est perdu (l'agent abandonne lui-même après 20 minutes). */
const SCAN_TIMEOUT_MIN = 25;
const KEEP_PER_IMAGE = 5;
/** Verrou consultatif PostgreSQL qui sérialise le démarrage des scans (limites par hôte et globale). */
const PUMP_LOCK = 7_305_001;
/** Un scan en attente sur un hôte hors ligne depuis plus longtemps que ça est abandonné. */
const STALE_PENDING_MIN = 10;

export interface ScanTransport {
  isOnline(hostId: string): boolean;
  send(hostId: string, message: ScanMessage): boolean;
}

export interface ScanRow {
  id: string;
  imageId: string;
  platform: string;
  hostId: string;
  imageRef: string;
  status: "pending" | "running" | "succeeded" | "failed";
  trigger: "manual" | "scheduled";
  requestedBy: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  trivyVersion: string | null;
  dbVersion: number | null;
  dbUpdatedAt: Date | null;
  dbDownloadedAt: Date | null;
  os: { family: string; name: string; eosl: boolean | null } | null;
  counts: SeverityCounts | null;
  total: number | null;
  truncated: boolean;
}

interface DbRow {
  id: string;
  image_id: string;
  platform: string;
  host_id: string;
  image_ref: string;
  status: ScanRow["status"];
  trigger: ScanRow["trigger"];
  requested_by: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  trivy_version: string | null;
  db_version: number | null;
  db_updated_at: Date | null;
  db_downloaded_at: Date | null;
  os_family: string | null;
  os_name: string | null;
  os_eosl: boolean | null;
  counts: SeverityCounts | null;
  total: number | null;
  truncated: boolean;
}

const COLUMNS = `id, image_id, platform, host_id, image_ref, status, trigger, requested_by, created_at, started_at,
  finished_at, error, trivy_version, db_version, db_updated_at, db_downloaded_at, os_family, os_name, os_eosl,
  counts, total, truncated`;

const toRow = (r: DbRow): ScanRow => ({
  id: r.id,
  imageId: r.image_id,
  platform: r.platform,
  hostId: r.host_id,
  imageRef: r.image_ref,
  status: r.status,
  trigger: r.trigger,
  requestedBy: r.requested_by,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  error: r.error,
  trivyVersion: r.trivy_version,
  dbVersion: r.db_version,
  dbUpdatedAt: r.db_updated_at,
  dbDownloadedAt: r.db_downloaded_at,
  os: r.os_family ? { family: r.os_family, name: r.os_name ?? "", eosl: r.os_eosl } : null,
  counts: r.counts,
  total: r.total,
  truncated: r.truncated,
});

export interface ScanRequest {
  imageId: string;
  platform: string;
  hostId: string;
  imageRef: string;
  trigger: "manual" | "scheduled";
  requestedBy: string;
}

/**
 * Scans de vulnérabilités. Un résultat s'applique à un contenu d'image
 * (identifiant + plateforme) quel que soit l'hôte ; un seul scan est actif
 * par contenu, un seul tourne à la fois par hôte et trois au plus au total.
 * Un scan n'a pas d'effet de bord : en cas de perte de l'agent il est
 * simplement marqué en échec et peut être relancé.
 */
export class ScanService {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly transport: ScanTransport,
    private readonly log: { warn(msg: string): void; error(obj: unknown, msg?: string): void } = { warn: () => {}, error: () => {} },
  ) {}

  start(tickMs = 60_000): void {
    this.timer = setInterval(() => void this.tick().catch((e: unknown) => this.log.error(e, "boucle de scans")), tickMs);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Au démarrage de la console, les scans qui tournaient sont perdus (sans conséquence : on les relance). */
  async markInterrupted(): Promise<void> {
    await this.pool.query(
      `UPDATE image_scans SET status = 'failed', finished_at = now(),
              error = 'Console redémarrée pendant le scan : relancez-le.' WHERE status = 'running'`,
    );
  }

  async get(id: string): Promise<ScanRow | null> {
    const { rows } = await this.pool.query<DbRow>(`SELECT ${COLUMNS} FROM image_scans WHERE id = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** Scan le plus récent d'un contenu d'image (actif, sinon terminé). */
  async latest(imageId: string, platform: string): Promise<ScanRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT ${COLUMNS} FROM image_scans WHERE image_id = $1 AND platform = $2 ORDER BY created_at DESC LIMIT 1`,
      [imageId, platform],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** Dernière tentative et dernier succès de chaque contenu d'image, en deux requêtes. */
  async latestAll(): Promise<Map<string, { attempt: ScanRow; ok: ScanRow | null }>> {
    const [attempts, successes] = await Promise.all([
      this.pool.query<DbRow>(`SELECT DISTINCT ON (image_id, platform) ${COLUMNS} FROM image_scans ORDER BY image_id, platform, created_at DESC`),
      this.pool.query<DbRow>(`SELECT DISTINCT ON (image_id, platform) ${COLUMNS} FROM image_scans WHERE status = 'succeeded' ORDER BY image_id, platform, finished_at DESC`),
    ]);
    const ok = new Map(successes.rows.map((r) => [`${r.image_id}|${r.platform}`, toRow(r)]));
    return new Map(attempts.rows.map((r) => [`${r.image_id}|${r.platform}`, { attempt: toRow(r), ok: ok.get(`${r.image_id}|${r.platform}`) ?? null }]));
  }

  async vulnerabilities(scanId: string): Promise<Vulnerability[]> {
    const { rows } = await this.pool.query<{ vulnerabilities: Vulnerability[] | null }>(
      "SELECT vulnerabilities FROM image_scans WHERE id = $1",
      [scanId],
    );
    return rows[0]?.vulnerabilities ?? [];
  }

  /** Dernier scan réussi : sert d'état de référence même si une nouvelle tentative a échoué ensuite. */
  async latestSucceeded(imageId: string, platform: string | null): Promise<ScanRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `SELECT ${COLUMNS} FROM image_scans WHERE image_id = $1 AND ($2::text IS NULL OR platform = $2) AND status = 'succeeded'
       ORDER BY finished_at DESC LIMIT 1`,
      [imageId, platform],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async request(input: ScanRequest): Promise<{ scan: ScanRow; created: boolean }> {
    const active = await this.pool.query<DbRow>(
      `SELECT ${COLUMNS} FROM image_scans WHERE image_id = $1 AND platform = $2 AND status IN ('pending', 'running')`,
      [input.imageId, input.platform],
    );
    const existing = active.rows[0];
    if (existing) {
      const stuck = existing.status === "pending" && existing.host_id !== input.hostId && !this.transport.isOnline(existing.host_id) && this.transport.isOnline(input.hostId);
      if (!stuck) return { scan: toRow(existing), created: false };
      // Le scan en attente est sur un hôte hors ligne : il bloquerait ce contenu pour tous les autres hôtes.
      await this.pool.query(
        "UPDATE image_scans SET status = 'failed', finished_at = now(), error = 'Hôte hors ligne : scan repris sur un autre hôte.' WHERE id = $1 AND status = 'pending'",
        [existing.id],
      );
    }
    if (!this.transport.isOnline(input.hostId)) {
      throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne : le scan n'a pas été lancé.");
    }
    let row: DbRow | undefined;
    try {
      row = (
        await this.pool.query<DbRow>(
          `INSERT INTO image_scans (image_id, platform, host_id, image_ref, status, trigger, requested_by)
           VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING ${COLUMNS}`,
          [input.imageId, input.platform, input.hostId, input.imageRef.slice(0, 300), input.trigger, input.requestedBy],
        )
      ).rows[0];
    } catch (err) {
      // Course avec une autre demande pour le même contenu : on reprend le scan existant.
      if ((err as { code?: string }).code === "23505") {
        const again = await this.pool.query<DbRow>(
          `SELECT ${COLUMNS} FROM image_scans WHERE image_id = $1 AND platform = $2 AND status IN ('pending', 'running')`,
          [input.imageId, input.platform],
        );
        if (again.rows[0]) return { scan: toRow(again.rows[0]), created: false };
      }
      throw err;
    }
    if (!row) throw new Error("scan non créé");
    await audit(this.pool, input.requestedBy, "scan.request", row.id, "success");
    await this.pumpAny();
    const fresh = await this.get(row.id);
    return { scan: fresh ?? toRow(row), created: true };
  }

  /** Démarre le prochain scan en attente d'un hôte, s'il n'en exécute pas déjà un. */
  async pump(hostId: string): Promise<boolean> {
    if (!this.transport.isOnline(hostId)) return false;
    let next: { id: string; image_id: string; image_ref: string } | undefined;
    // Les scans en attente dont l'image n'existe plus sur l'hôte (stack mise à jour entre-temps) sont abandonnés :
    // on passe aussitôt au suivant au lieu de bloquer la file ou de scanner une image qui n'est plus utilisée.
    for (let attempt = 0; attempt < 200; attempt++) {
      next = await this.startNext(hostId);
      if (!next) return false;
      if (!(await this.imageGone(hostId, next.image_id))) break;
      await this.pool.query(
        "UPDATE image_scans SET status = 'failed', finished_at = now(), error = 'Image retirée de l''hôte (application mise à jour ?) : scan abandonné.' WHERE id = $1",
        [next.id],
      );
      next = undefined;
    }
    if (!next) return false;
    const sent = this.transport.send(hostId, { type: "scan", scanId: next.id, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), imageId: next.image_id, imageRef: next.image_ref });
    if (!sent) {
      await this.pool.query(
        "UPDATE image_scans SET status = 'failed', finished_at = now(), error = 'Agent hors ligne : scan non envoyé.' WHERE id = $1",
        [next.id],
      );
    }
    return true;
  }

  /** Passe le plus ancien scan en attente de l'hôte à « en cours », sous verrou (un seul à la fois, hôtes confondus). */
  private async startNext(hostId: string): Promise<{ id: string; image_id: string; image_ref: string } | undefined> {
    // Sans verrou, deux appels simultanés voient tous deux « aucun scan en cours » et en démarrent chacun un.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [PUMP_LOCK]);
      const { rows } = await client.query<{ id: string; image_id: string; image_ref: string }>(
        `UPDATE image_scans SET status = 'running', started_at = now()
          WHERE id = (SELECT id FROM image_scans WHERE host_id = $1 AND status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            AND NOT EXISTS (SELECT 1 FROM image_scans WHERE host_id = $1 AND status = 'running')
            AND (SELECT count(*) FROM image_scans WHERE status = 'running') < $2
          RETURNING id, image_id, image_ref`,
        [hostId, MAX_RUNNING_TOTAL],
      );
      await client.query("COMMIT");
      return rows[0];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Vrai si la dernière liste d'images de l'hôte ne contient plus cette image (liste absente = agent ancien : on ne sait pas). */
  private async imageGone(hostId: string, imageId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ images: { id: string }[] | null }>("SELECT images FROM hosts WHERE id = $1", [hostId]);
    const images = rows[0]?.images;
    return Array.isArray(images) && !images.some((i) => i.id === imageId);
  }

  /** Démarre le plus ancien scan en attente de la file globale (hôtes en ligne), s'il n'y en a pas déjà un en cours. */
  async pumpAny(): Promise<void> {
    const { rows } = await this.pool.query<{ host_id: string }>("SELECT host_id FROM image_scans WHERE status = 'pending' GROUP BY host_id ORDER BY min(created_at)");
    for (const r of rows) {
      if (this.transport.isOnline(r.host_id) && (await this.pump(r.host_id))) return;
    }
  }

  /** File d'attente : scans en attente dans l'ordre de démarrage, nombre de scans en cours et description de celui qui tourne. */
  async queue(): Promise<{
    pending: { id: string; imageId: string; platform: string }[];
    running: number;
    current: { id: string; imageRef: string; hostId: string; startedAt: string } | null;
  }> {
    const [pending, running] = await Promise.all([
      this.pool.query<{ id: string; image_id: string; platform: string }>("SELECT id, image_id, platform FROM image_scans WHERE status = 'pending' ORDER BY created_at"),
      this.pool.query<{ id: string; image_ref: string; host_id: string; started_at: Date | null }>("SELECT id, image_ref, host_id, started_at FROM image_scans WHERE status = 'running' ORDER BY started_at"),
    ]);
    const cur = running.rows[0];
    return {
      pending: pending.rows.map((r) => ({ id: r.id, imageId: r.image_id, platform: r.platform })),
      running: running.rows.length,
      current: cur ? { id: cur.id, imageRef: cur.image_ref, hostId: cur.host_id, startedAt: (cur.started_at ?? new Date()).toISOString() } : null,
    };
  }

  /** Retire les scans encore en attente (ils n'ont pas commencé : l'image retrouve son état précédent). Un scan en cours va à son terme. */
  async cancelPending(actor: string, what: "pending" | "running" | "all" = "pending"): Promise<{ removed: number; interrupted: number }> {
    const res = what === "running" ? { rowCount: 0 } : await this.pool.query("DELETE FROM image_scans WHERE status = 'pending'");
    let interrupted = 0;
    if (what !== "pending") {
      // Déblocage manuel : le scan « en cours » est déclaré perdu (son résultat éventuel sera ignoré) et la file reprend.
      const r = await this.pool.query("UPDATE image_scans SET status = 'failed', finished_at = now(), error = 'Interrompu par l''administrateur : relancez le scan.' WHERE status = 'running'");
      interrupted = r.rowCount ?? 0;
    }
    await audit(this.pool, actor, "scan.cancel-queue", `${res.rowCount ?? 0}+${interrupted}`, "success");
    return { removed: res.rowCount ?? 0, interrupted };
  }

  async onResult(hostId: string, msg: ScanResult): Promise<void> {
    const ok = msg.status === "succeeded";
    const { rows } = await this.pool.query<{ image_id: string; platform: string }>(
      `UPDATE image_scans SET status = $3, finished_at = now(), error = $4,
              trivy_version = $5, db_version = $6, db_updated_at = $7, db_downloaded_at = $8,
              os_family = $9, os_name = $10, os_eosl = $11, counts = $12, total = $13, truncated = $14, vulnerabilities = $15
        WHERE id = $1 AND host_id = $2 AND status = 'running'
        RETURNING image_id, platform`,
      [
        msg.scanId,
        hostId,
        ok ? "succeeded" : "failed",
        ok ? null : (msg.error ?? "Échec du scan").slice(0, 1000),
        msg.trivy?.version ?? null,
        msg.trivy?.dbVersion ?? null,
        msg.trivy?.dbUpdatedAt ?? null,
        msg.trivy?.dbDownloadedAt ?? null,
        msg.os?.family ?? null,
        msg.os?.name ?? null,
        msg.os?.eosl ?? null,
        ok && msg.counts ? JSON.stringify(msg.counts) : null,
        ok ? (msg.total ?? 0) : null,
        ok ? (msg.truncated ?? false) : false,
        ok && msg.vulnerabilities ? JSON.stringify(msg.vulnerabilities) : null,
      ],
    );
    const done = rows[0];
    if (done) {
      // Historique borné : on garde les derniers résultats de chaque contenu.
      await this.pool.query(
        `DELETE FROM image_scans WHERE id IN (
           SELECT id FROM image_scans WHERE image_id = $1 AND platform = $2 AND status IN ('succeeded', 'failed')
           ORDER BY created_at DESC OFFSET $3)
         -- Le dernier résultat réussi reste toujours disponible, même après une longue série d'échecs.
         AND id NOT IN (SELECT id FROM image_scans WHERE image_id = $1 AND platform = $2 AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1)`,
        [done.image_id, done.platform, KEEP_PER_IMAGE],
      );
    }
    await this.pumpAny();
  }

  async onDisconnect(hostId: string): Promise<void> {
    await this.pool.query(
      `UPDATE image_scans SET status = 'failed', finished_at = now(),
              error = 'Connexion à l''agent perdue pendant le scan : relancez-le.' WHERE host_id = $1 AND status = 'running'`,
      [hostId],
    );
  }

  /** Planification : relance les scans périmés (la base de vulnérabilités évolue) et traite les files d'attente. */
  async tick(): Promise<void> {
    // Chaque étape est isolée : l'échec d'une (planification, base momentanément indisponible…) ne doit jamais
    // empêcher de faire avancer la file, sans quoi elle resterait bloquée tant que l'erreur dure.
    const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        this.log.error(err, `scans : ${name}`);
      }
    };
    await step("scans perdus", () =>
      this.pool.query(
        `UPDATE image_scans SET status = 'failed', finished_at = now(), error = 'Délai dépassé : relancez le scan.'
          WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)`,
        [SCAN_TIMEOUT_MIN],
      ),
    );
    await step("scans abandonnés", () => this.abandonStalePending());
    await step("file d'attente", () => this.pumpAny());
    await step("planification", async () => {
      const { scanIntervalHours } = await getSecuritySettings(this.pool);
      if (scanIntervalHours > 0) await this.scheduledPass(scanIntervalHours);
    });
    await step("file d'attente (après planification)", () => this.pumpAny());
  }

  /** Abandonne les scans en attente depuis un moment sur un hôte hors ligne (ou révoqué) : ils bloqueraient l'image. */
  private async abandonStalePending(): Promise<void> {
    const pending = await this.pool.query<{ host_id: string }>("SELECT DISTINCT host_id FROM image_scans WHERE status = 'pending'");
    const offline = pending.rows.map((r) => r.host_id).filter((id) => !this.transport.isOnline(id));
    if (offline.length === 0) return;
    await this.pool.query(
      `UPDATE image_scans SET status = 'failed', finished_at = now(), error = 'Hôte hors ligne : scan abandonné, relancez-le.'
        WHERE status = 'pending' AND host_id = ANY($1::uuid[]) AND created_at < now() - make_interval(mins => $2)`,
      [offline, STALE_PENDING_MIN],
    );
  }

  async scheduledPass(intervalHours: number, now = Date.now()): Promise<number> {
    let requested = 0;
    // Une seule requête pour tous les contenus d'image, au lieu d'une par image.
    const latest = await this.latestAll();
    for (const img of await loadUsedImages(this.pool)) {
      // Seules les images de stacks gérées sont scannées automatiquement.
      const users = img.usedBy.filter((u: ImageUser) => u.stackId !== null && this.transport.isOnline(u.hostId));
      const user = users[0];
      if (!user) continue;
      const last = latest.get(`${img.imageId}|${img.platform}`)?.attempt ?? null;
      if (last && (last.status === "pending" || last.status === "running")) continue;
      const age = last?.finishedAt ? now - last.finishedAt.getTime() : Number.POSITIVE_INFINITY;
      // Un échec est retenté au plus tard après une heure, un succès après la période configurée.
      const due = !last || age > (last.status === "failed" ? Math.min(intervalHours, 1) : intervalHours) * 3600_000;
      if (!due) continue;
      try {
        await this.request({ imageId: img.imageId, platform: img.platform, hostId: user.hostId, imageRef: user.ref, trigger: "scheduled", requestedBy: "planification" });
        requested++;
      } catch {
        /* hôte hors ligne entre-temps : prochain passage */
      }
    }
    return requested;
  }
}
