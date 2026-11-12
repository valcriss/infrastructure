import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import type { RegistryGc } from "./registry-gc.js";
import type { RegistryImages } from "./registry-images.js";
import { RetentionBody, getRetentionSettings, setRetentionSettings } from "./registry-retention.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const PASS_EVERY_MS = 6 * 3600_000;
const ACTIVE = ["queued", "preparing", "scanning_before", "patching", "scanning_after", "verifying", "unknown"];
/** Auteur des suppressions faites par la règle de rétention automatique. */
export const RETENTION_ACTOR = "rétention";

export interface RetentionRun {
  deleted: { repository: string; tags: string[]; digest: string }[];
  failed: { repository: string; digest: string; reason: string }[];
  /** Candidates laissées pour un prochain passage (plafond atteint). */
  remaining: number;
  /** Ramasse-miettes demandé après la suppression (mode automatique). */
  gcRequested: boolean;
}

/**
 * Rétention du registre : supprime les images que la règle désigne (les N plus récentes d'un dépôt sont conservées),
 * avec toutes les protections de la suppression manuelle (révision courante ou déployée, conteneur en cours, correctif
 * actif, anciennes révisions) recalculées au moment du passage. Mode « propose » : seulement sur demande d'un
 * administrateur ; mode « auto » : périodiquement, avec un plafond par passage, jamais pendant un correctif.
 */
export class RegistryRetention {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly images: Pick<RegistryImages, "list" | "remove">,
    private readonly gc: Pick<RegistryGc, "start">,
    private readonly log: { error(obj: unknown, msg?: string): void } = { error: () => {} },
  ) {}

  start(everyMs = PASS_EVERY_MS): void {
    this.timer = setInterval(() => void this.autoPass().catch((e: unknown) => this.log.error(e, "rétention du registre")), everyMs);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Passage périodique : ne fait rien hors mode « auto », ni pendant un correctif. */
  async autoPass(): Promise<RetentionRun | null> {
    const settings = await getRetentionSettings(this.pool);
    if (settings.mode !== "auto") return null;
    const active = await this.pool.query("SELECT 1 FROM remediation_jobs WHERE status = ANY($1::text[]) LIMIT 1", [ACTIVE]);
    if ((active.rowCount ?? 0) > 0) return null;
    return this.apply(RETENTION_ACTOR, true);
  }

  /** Supprime les images candidates (dans la limite du plafond). `withGc` : demande ensuite le ramasse-miettes. */
  async apply(actor: string, withGc: boolean): Promise<RetentionRun> {
    const run: RetentionRun = { deleted: [], failed: [], remaining: 0, gcRequested: false };
    if (this.running) return run;
    this.running = true;
    try {
      const settings = await getRetentionSettings(this.pool);
      const view = await this.images.list();
      if (!view.reachable || settings.mode === "off") return run;
      const candidates = view.repositories.flatMap((r) => r.images.filter((i) => i.retention.candidate).map((i) => ({ repository: r.repository, img: i })));
      run.remaining = Math.max(0, candidates.length - settings.maxDeletesPerPass);
      for (const c of candidates.slice(0, settings.maxDeletesPerPass)) {
        try {
          // Jamais de confirmation implicite : une image référencée par d'anciennes révisions n'est pas candidate.
          await this.images.remove({ repository: c.repository, digest: c.img.digest }, actor, view);
          run.deleted.push({ repository: c.repository, tags: c.img.tags, digest: c.img.digest });
        } catch (err) {
          run.failed.push({ repository: c.repository, digest: c.img.digest, reason: err instanceof Error ? err.message : "échec" });
        }
      }
      if (run.deleted.length > 0) {
        await audit(this.pool, actor, "registry.retention", `${run.deleted.length} supprimée(s), ${run.failed.length} en échec`, run.failed.length === 0 ? "success" : "failure");
        if (withGc) {
          try {
            await this.gc.start(actor, false);
            run.gcRequested = true;
          } catch {
            /* agent ancien, hôte hors ligne… : l'espace sera libéré au prochain ramasse-miettes manuel */
          }
        }
      }
      return run;
    } finally {
      this.running = false;
    }
  }
}

export const GcBody = z.object({ dryRun: z.boolean().default(false) });

/** Réglages de rétention, suppression des candidates, ramasse-miettes (écritures : administrateur, règle de /settings). */
export function registerRegistryMaintenanceRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard; retention: RegistryRetention; gc: RegistryGc }): void {
  const { pool, auth, retention, gc } = deps;

  app.get("/api/v1/settings/registry/retention", { preHandler: auth }, async () => ({ settings: await getRetentionSettings(pool), gc: gc.state() }));

  app.put("/api/v1/settings/registry/retention", { preHandler: auth }, async (request) => {
    const before = await getRetentionSettings(pool);
    const next = await setRetentionSettings(pool, RetentionBody.parse(request.body));
    if (before.mode !== next.mode) await audit(pool, request.actor, "registry.retention.mode", next.mode, "success");
    return { settings: next, gc: gc.state() };
  });

  // Supprime maintenant les images que la règle propose (confirmation explicite d'un administrateur, pas de ramasse-miettes).
  app.post("/api/v1/settings/registry/retention/apply", { preHandler: auth }, async (request) => retention.apply(request.actor, false));

  app.get("/api/v1/settings/registry/gc", { preHandler: auth }, async () => gc.state());
  app.post("/api/v1/settings/registry/gc", { preHandler: auth }, async (request, reply) => {
    const body = GcBody.parse(request.body ?? {});
    return reply.code(202).send(await gc.start(request.actor, body.dryRun));
  });
}
