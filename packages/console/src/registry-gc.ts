import { randomUUID } from "node:crypto";
import type { ConsoleMessage, RegistryGcResult } from "@infra/shared";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { getRegistrySettings } from "./registry-app-routes.js";
import { GARBAGE_COLLECT_COMMAND } from "./registry-images.js";

const ACTIVE = ["queued", "preparing", "scanning_before", "patching", "scanning_after", "verifying", "unknown"];
/** Au-delà, le ramasse-miettes est déclaré indéterminé (l'agent a son propre délai de 15 minutes). */
const GC_TIMEOUT_MS = 20 * 60_000;

export interface GcTransport {
  isOnline(hostId: string): boolean;
  send(hostId: string, message: ConsoleMessage): boolean;
}

export interface GcOutcome {
  finishedAt: string;
  requestedBy: string;
  dryRun: boolean;
  status: "succeeded" | "failed" | "unknown";
  error: string | null;
  output: string | null;
  usedBeforeKb: number | null;
  usedAfterKb: number | null;
}

export interface GcState {
  running: { requestId: string; startedAt: string; requestedBy: string; dryRun: boolean } | null;
  last: GcOutcome | null;
  /** Commande à lancer à la main si l'agent de l'hôte du registre ne sait pas le faire. */
  manualCommand: string;
}

/**
 * Ramasse-miettes du registre géré : demandé à l'agent de l'hôte du registre (commande fixe, sans argument libre),
 * jamais pendant un correctif en cours ni en même temps qu'un autre. Pendant son exécution, aucun nouveau correctif
 * ne démarre (le registre ne doit pas recevoir de publication pendant un ramasse-miettes).
 */
export class RegistryGc {
  private running: GcState["running"] = null;
  private hostId: string | null = null;
  private last: GcOutcome | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly transport: GcTransport,
    /** Suspend / reprend le démarrage des correctifs. */
    private readonly hold: (held: boolean) => void,
  ) {}

  close(): void {
    clearTimeout(this.timer);
  }

  state(): GcState {
    return { running: this.running, last: this.last, manualCommand: `docker exec registry-registry-1 ${GARBAGE_COLLECT_COMMAND}` };
  }

  async start(actor: string, dryRun: boolean): Promise<GcState> {
    if (this.running) throw new HttpError(409, "gc_running", "Un ramasse-miettes est déjà en cours.");
    const settings = await getRegistrySettings(this.pool);
    if (!settings) throw new HttpError(409, "registry_not_configured", "Aucune application registry n'est configurée.");
    const host = await this.pool.query<{ capabilities: string[] }>("SELECT capabilities FROM hosts WHERE id = $1 AND revoked_at IS NULL", [settings.hostId]);
    if (!host.rows[0]) throw new HttpError(409, "host_missing", "L'hôte du registre est introuvable.");
    if (!host.rows[0].capabilities.includes("registry.gc")) {
      throw new HttpError(409, "agent_cannot_gc", `L'agent de l'hôte du registre est trop ancien : mettez-le à jour, ou lancez la commande à la main (« ${this.state().manualCommand} »).`);
    }
    if (!this.transport.isOnline(settings.hostId)) throw new HttpError(409, "host_offline", "L'hôte du registre est hors ligne.");
    const active = await this.pool.query("SELECT 1 FROM remediation_jobs WHERE status = ANY($1::text[]) LIMIT 1", [ACTIVE]);
    if ((active.rowCount ?? 0) > 0) throw new HttpError(409, "remediation_active", "Un correctif est en cours ou en attente : le registre ne doit pas recevoir de publication pendant un ramasse-miettes. Réessayez ensuite.");

    const requestId = randomUUID();
    this.hold(true);
    if (!this.transport.send(settings.hostId, { type: "registry_gc", requestId, expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(), dryRun })) {
      this.hold(false);
      throw new HttpError(409, "host_offline", "L'hôte du registre est hors ligne.");
    }
    this.hostId = settings.hostId;
    this.running = { requestId, startedAt: new Date().toISOString(), requestedBy: actor, dryRun };
    this.timer = setTimeout(() => this.finish({ status: "unknown", error: "Aucun retour de l'agent dans le délai prévu : le résultat est indéterminé." }), GC_TIMEOUT_MS);
    this.timer.unref();
    await audit(this.pool, actor, dryRun ? "registry.gc.dry_run" : "registry.gc", settings.host, "success");
    return this.state();
  }

  onResult(hostId: string, msg: RegistryGcResult): void {
    if (!this.running || this.running.requestId !== msg.requestId || this.hostId !== hostId) return;
    this.finish({
      status: msg.status,
      error: msg.error ?? null,
      output: msg.output ?? null,
      usedBeforeKb: msg.usedBeforeKb ?? null,
      usedAfterKb: msg.usedAfterKb ?? null,
    });
  }

  /** Connexion perdue pendant l'opération : le ramasse-miettes a pu aller à son terme. */
  onDisconnect(hostId: string): void {
    if (this.running && this.hostId === hostId) this.finish({ status: "unknown", error: "Connexion à l'agent perdue pendant le ramasse-miettes : le résultat est indéterminé." });
  }

  private finish(r: Partial<GcOutcome> & Pick<GcOutcome, "status">): void {
    const run = this.running;
    if (!run) return;
    clearTimeout(this.timer);
    this.running = null;
    this.hostId = null;
    this.hold(false);
    this.last = {
      finishedAt: new Date().toISOString(),
      requestedBy: run.requestedBy,
      dryRun: run.dryRun,
      status: r.status,
      error: r.error ?? null,
      output: r.output ?? null,
      usedBeforeKb: r.usedBeforeKb ?? null,
      usedAfterKb: r.usedAfterKb ?? null,
    };
  }
}
