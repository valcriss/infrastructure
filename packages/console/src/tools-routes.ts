import { RESERVED_STACK_NAMES, type Container } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Pool } from "./db.js";
import type { AgentGateway } from "./gateway.js";
import { HttpError } from "./http-error.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface ToolsResult {
  tools: string[];
  packageManager: string | null;
  /** Tous les gestionnaires de paquets présents. */
  packageManagers: string[];
  /** Distribution (alpine, debian…), si lisible. */
  os: string | null;
  /** Utilisateur du conteneur ; vide = root. */
  user: string;
  shell: boolean;
}

interface Pending {
  hostId: string;
  resolve: (r: ToolsResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const PROBE_TIMEOUT_MS = 20_000;

/** Demande à l'agent quels outils existent dans un conteneur (curl, wget, node…), en lecture seule. */
export class ToolProbeService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly gateway: AgentGateway) {}

  probe(hostId: string, containerId: string): Promise<ToolsResult> {
    return new Promise((resolve, reject) => {
      const probeId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(probeId);
        reject(new HttpError(504, "probe_timeout", "L'agent n'a pas répondu à temps."));
      }, PROBE_TIMEOUT_MS);
      this.pending.set(probeId, { hostId, resolve, reject, timer });
      if (!this.gateway.send(hostId, { type: "tools_probe", probeId, containerId })) {
        clearTimeout(timer);
        this.pending.delete(probeId);
        reject(new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne"));
      }
    });
  }

  onResult(hostId: string, msg: { probeId: string; error?: string; tools: string[]; packageManager?: string; packageManagers?: string[]; os?: string; user: string; shell: boolean }): void {
    const p = this.pending.get(msg.probeId);
    if (!p || p.hostId !== hostId) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.probeId);
    if (msg.error) p.reject(new HttpError(422, "probe_failed", msg.error));
    else {
      const packageManagers = msg.packageManagers ?? (msg.packageManager ? [msg.packageManager] : []);
      p.resolve({ tools: msg.tools, packageManager: msg.packageManager ?? null, packageManagers, os: msg.os ?? null, user: msg.user, shell: msg.shell });
    }
  }

  onHostDisconnect(hostId: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.hostId !== hostId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new HttpError(409, "host_offline", "Connexion avec l'agent perdue"));
    }
  }
}

const Params = z.object({ hostId: z.uuid(), containerId: z.string().regex(/^[0-9a-f]{12,64}$/) });

export function registerToolRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard; service: ToolProbeService }): void {
  const { pool, auth, service } = deps;

  // Lecture seule côté conteneur : l'agent teste la présence d'outils (`command -v`). Réservé aux opérateurs.
  app.post("/api/v1/hosts/:hostId/containers/:containerId/tools", { preHandler: auth }, async (request) => {
    const { hostId, containerId } = Params.parse(request.params);
    const { rows } = await pool.query<{ inventory: Container[] | null }>("SELECT inventory FROM hosts WHERE id = $1 AND revoked_at IS NULL", [hostId]);
    if (!rows[0]) throw new HttpError(404, "host_not_found", "Hôte introuvable");
    const container = (rows[0].inventory ?? []).find((c) => c.id.startsWith(containerId) || containerId.startsWith(c.id));
    if (!container) throw new HttpError(404, "container_not_found", "Conteneur introuvable sur cet hôte");
    if (container.state !== "running") throw new HttpError(409, "container_not_running", "Le conteneur n'est pas en cours d'exécution");
    if (container.composeProject && RESERVED_STACK_NAMES.includes(container.composeProject)) {
      throw new HttpError(403, "container_protected", "Conteneur de la console ou de l'agent : sonde refusée.");
    }
    return service.probe(hostId, container.id);
  });
}
