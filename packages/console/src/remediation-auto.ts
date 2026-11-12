import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { parseImageRef } from "./image-ref.js";
import { loadUsedImages } from "./images.js";
import type { RemediationService } from "./remediation.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Auteur des correctifs lancés par la planification (distingue les correctifs automatiques des manuels). */
export const AUTO_ACTOR = "planification";
const PASS_EVERY_MS = 10 * 60_000;
/** Trois échecs consécutifs de correctifs automatiques suspendent la planification pendant ce délai. */
const PAUSE_AFTER_FAILURES = 3;
const PAUSE_MS = 24 * 3600_000;
const ACTIVE = ["queued", "preparing", "scanning_before", "patching", "scanning_after", "verifying", "unknown"];

export interface AutoSettings {
  /** Désactivé par défaut : rien ne se prépare tant qu'un administrateur ne l'a pas demandé. */
  enabled: boolean;
  /** Nombre maximal de correctifs préparés automatiquement par période de 24 h. */
  maxPerDay: number;
  /** Images exclues (`registre/dépôt`, sans étiquette) : jamais préparées automatiquement. */
  excluded: string[];
}

export const DEFAULT_AUTO: AutoSettings = { enabled: false, maxPerDay: 3, excluded: [] };

export const AutoSettingsBody = z.object({
  enabled: z.boolean(),
  maxPerDay: z.number().int().min(1).max(20),
  excluded: z.array(z.string().min(1).max(200)).max(100),
});

/** Clé stable d'une image pour les exclusions : `docker.io/library/postgres` (sans étiquette ni digest). */
export function imageKey(ref: string): string | null {
  const p = parseImageRef(ref);
  return p ? `${p.registry}/${p.repository}` : null;
}

export async function getAutoSettings(pool: Pick<Pool, "query">): Promise<AutoSettings> {
  const { rows } = await pool.query<{ value: Partial<AutoSettings> }>("SELECT value FROM app_settings WHERE key = 'remediation_auto'");
  return { ...DEFAULT_AUTO, ...(rows[0]?.value ?? {}) };
}

/** Clé d'une image saisie par un administrateur (exclusion, vérification) : le dépôt, jamais une version. */
export function exclusionKey(raw: string): string {
  const value = raw.trim();
  // Un réglage vise toute l'image (dépôt), jamais une version : une étiquette ou un digest serait trompeur.
  if (value.includes("@") || /:/.test(value.slice(value.lastIndexOf("/") + 1))) throw new HttpError(400, "invalid_setting", `Indiquez l'image sans étiquette ni digest : « ${raw} ».`);
  const key = imageKey(value);
  if (!key) throw new HttpError(400, "invalid_setting", `Image invalide : « ${raw} » (ex. postgres ou ghcr.io/org/app).`);
  return key;
}

export async function setAutoSettings(pool: Pool, input: AutoSettings): Promise<AutoSettings> {
  const excluded: string[] = [];
  for (const raw of input.excluded) {
    const key = exclusionKey(raw);
    if (!excluded.includes(key)) excluded.push(key);
  }
  const next: AutoSettings = { enabled: input.enabled, maxPerDay: input.maxPerDay, excluded };
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('remediation_auto', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}

export interface AutoState {
  settings: AutoSettings;
  /** Correctifs automatiques créés sur les dernières 24 h. */
  usedToday: number;
  /** Suspension après des échecs répétés : date de reprise, ou null. */
  pausedUntil: string | null;
  lastPassAt: string | null;
  lastPassStarted: number;
}

export interface PassResult {
  started: number;
  /** Raison pour laquelle rien n'a été examiné : disabled, paused, daily_limit. */
  skipped: "disabled" | "paused" | "daily_limit" | null;
}

/**
 * Préparation planifiée des correctifs, SANS déploiement : pour une image utilisée par une application gérée, devenue
 * éligible, un correctif est préparé (au plus une fois par contenu d'image) dans la limite d'un plafond par 24 h, avec
 * une pause après des échecs répétés. Le résultat est un correctif « validé / partiel / refusé » à relire : il n'est
 * jamais appliqué à une application ni déployé automatiquement.
 */
export class RemediationAuto {
  private timer: NodeJS.Timeout | undefined;
  private lastPassAt: Date | null = null;
  private lastPassStarted = 0;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly remediation: Pick<RemediationService, "eligibility" | "create">,
    private readonly isOnline: (hostId: string) => boolean,
    private readonly log: { error(obj: unknown, msg?: string): void } = { error: () => {} },
  ) {}

  start(everyMs = PASS_EVERY_MS): void {
    this.timer = setInterval(() => void this.pass().catch((e: unknown) => this.log.error(e, "préparation planifiée des correctifs")), everyMs);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  private async pausedUntil(now: number): Promise<number | null> {
    const { rows } = await this.pool.query<{ status: string; finished_at: Date | null }>(
      `SELECT status, finished_at FROM remediation_jobs
        WHERE requested_by = $1 AND NOT (status = ANY($2::text[])) ORDER BY created_at DESC LIMIT $3`,
      [AUTO_ACTOR, ACTIVE, PAUSE_AFTER_FAILURES],
    );
    if (rows.length < PAUSE_AFTER_FAILURES || !rows.every((r) => r.status === "failed")) return null;
    const until = (rows[0]?.finished_at?.getTime() ?? 0) + PAUSE_MS;
    return until > now ? until : null;
  }

  async state(now = Date.now()): Promise<AutoState> {
    const settings = await getAutoSettings(this.pool);
    const used = await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM remediation_jobs WHERE requested_by = $1 AND created_at > now() - interval '24 hours'", [AUTO_ACTOR]);
    const paused = await this.pausedUntil(now);
    return {
      settings,
      usedToday: used.rows[0]?.n ?? 0,
      pausedUntil: paused ? new Date(paused).toISOString() : null,
      lastPassAt: this.lastPassAt?.toISOString() ?? null,
      lastPassStarted: this.lastPassStarted,
    };
  }

  /** Un passage : prépare les correctifs des images éligibles, dans les limites fixées. */
  async pass(now = Date.now()): Promise<PassResult> {
    if (this.running) return { started: 0, skipped: null };
    this.running = true;
    try {
      const result = await this.passWith(await this.state(now));
      this.lastPassAt = new Date(now);
      this.lastPassStarted = result.started;
      return result;
    } finally {
      this.running = false;
    }
  }

  private async passWith(state: AutoState): Promise<PassResult> {
    if (!state.settings.enabled) return { started: 0, skipped: "disabled" };
    if (state.pausedUntil) return { started: 0, skipped: "paused" };
    let budget = state.settings.maxPerDay - state.usedToday;
    if (budget <= 0) return { started: 0, skipped: "daily_limit" };

    const candidates: { imageId: string; platform: string; fixable: number }[] = [];
    for (const img of await loadUsedImages(this.pool)) {
      if (!img.platform) continue;
      // Seules les images d'applications gérées sont concernées (comme les scans planifiés).
      const user = img.usedBy.find((u) => u.stackId !== null && this.isOnline(u.hostId));
      if (!user) continue;
      const key = imageKey(user.ref);
      if (key && state.settings.excluded.includes(key)) continue;
      // Au plus une préparation automatique par contenu d'image : un échec ou un refus n'est jamais retenté en boucle.
      const known = await this.pool.query("SELECT 1 FROM remediation_jobs WHERE image_id = $1 AND platform = $2 LIMIT 1", [img.imageId, img.platform]);
      if ((known.rowCount ?? 0) > 0) continue;
      try {
        const report = await this.remediation.eligibility(img.imageId, img.platform);
        if (report.canStart) candidates.push({ imageId: img.imageId, platform: img.platform, fixable: report.fixableOs });
      } catch {
        /* image disparue entre-temps */
      }
    }
    // Les images qui ont le plus de CVE corrigeables d'abord.
    candidates.sort((a, b) => b.fixable - a.fixable);

    let started = 0;
    for (const c of candidates) {
      if (budget <= 0) break;
      try {
        const { created } = await this.remediation.create({ imageId: c.imageId, platform: c.platform, requestedBy: AUTO_ACTOR });
        if (created) {
          started++;
          budget--;
        }
      } catch {
        /* plus éligible, hôte hors ligne… : prochain passage */
      }
    }
    return { started, skipped: null };
  }
}

/** Réglages de la préparation planifiée (lecture : tout utilisateur ; écriture et lancement immédiat : administrateur). */
export function registerRemediationAutoRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard; auto: RemediationAuto }): void {
  const { pool, auth, auto } = deps;

  app.get("/api/v1/settings/remediation", { preHandler: auth }, async () => auto.state());

  app.put("/api/v1/settings/remediation", { preHandler: auth }, async (request) => {
    const before = await getAutoSettings(pool);
    const next = await setAutoSettings(pool, AutoSettingsBody.parse(request.body));
    if (before.enabled !== next.enabled) await audit(pool, request.actor, next.enabled ? "remediation.auto.enable" : "remediation.auto.disable", "settings", "success");
    return auto.state();
  });

  // Passage immédiat (sans attendre le prochain passage périodique) : mêmes limites, mêmes garde-fous.
  app.post("/api/v1/settings/remediation/run", { preHandler: auth }, async (request) => {
    const result = await auto.pass();
    await audit(pool, request.actor, "remediation.auto.run", `${result.started} lancé(s)`, "success");
    return { ...result, state: await auto.state() };
  });
}
