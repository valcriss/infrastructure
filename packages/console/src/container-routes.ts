import { RESERVED_STACK_NAMES, type Container } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { hiddenProjects } from "./display.js";
import type { AgentGateway } from "./gateway.js";
import { HttpError } from "./http-error.js";
import { serveLogStream } from "./log-sse.js";
import type { LogStreams } from "./log-streams.js";
import { RANGES, type MetricsStore } from "./metrics-store.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export type ContainerActionName = "start" | "stop" | "restart";

/** Un conteneur d'un hôte, rattaché ou non à une application. */
export interface ContainerRow {
  hostId: string;
  hostName: string;
  hostPresence: "online" | "offline";
  id: string;
  name: string;
  /** Service Compose ; null hors Compose. */
  service: string | null;
  /** Projet Compose ; null pour un conteneur lancé hors Compose. */
  project: string | null;
  /** « managed » : l'application est pilotée par la console ; « observed » : projet Compose non géré ; null : hors Compose. */
  appKind: "managed" | "observed" | null;
  stackId: string | null;
  image: string;
  state: string;
  status: string;
  health: NonNullable<Container["health"]> | null;
  restartCount: number;
  exitCode: number | null;
  startedAt: string | null;
  created: number;
  ports: NonNullable<Container["ports"]>;
  usage: { cpuPercent: number; memBytes: number; memLimitBytes: number } | null;
  /** Conteneur de la console ou de son agent : aucune action de cycle de vie ni terminal. */
  protected: boolean;
}

// --- Actions sur un conteneur : requête / réponse avec l'agent ------------------------------------------

interface Pending {
  hostId: string;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Le délai d'arrêt de Docker est de 10 s ; la marge couvre un redémarrage lent. */
const ACTION_TIMEOUT_MS = 75_000;
/** Une demande non exécutée dans ce délai est refusée par l'agent (rejeu tardif impossible). */
const ACTION_VALIDITY_MS = 90_000;

/** Démarre, arrête ou redémarre un conteneur précis et attend le résultat de l'agent. */
export class ContainerActionService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly gateway: AgentGateway) {}

  run(hostId: string, containerId: string, action: ContainerActionName): Promise<void> {
    return new Promise((resolve, reject) => {
      const actionId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new HttpError(504, "action_timeout", "L'agent n'a pas répondu à temps : vérifiez l'état du conteneur avant de recommencer."));
      }, ACTION_TIMEOUT_MS);
      this.pending.set(actionId, { hostId, resolve, reject, timer });
      const sent = this.gateway.send(hostId, { type: "container_action", actionId, expiresAt: new Date(Date.now() + ACTION_VALIDITY_MS).toISOString(), containerId, action });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(actionId);
        reject(new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne"));
      }
    });
  }

  onResult(hostId: string, msg: { actionId: string; status: "succeeded" | "failed"; error?: string }): void {
    const p = this.pending.get(msg.actionId);
    if (!p || p.hostId !== hostId) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.actionId);
    if (msg.status === "succeeded") p.resolve();
    else p.reject(new HttpError(422, "action_failed", msg.error ?? "Action refusée par l'agent"));
  }

  onHostDisconnect(hostId: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.hostId !== hostId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new HttpError(409, "host_offline", "Connexion avec l'agent perdue : vérifiez l'état du conteneur avant de recommencer."));
    }
  }
}

// --- Routes -----------------------------------------------------------------------------------------------

const Params = z.object({ hostId: z.uuid(), containerId: z.string().regex(/^[0-9a-f]{12,64}$/) });
const ActionParams = Params.extend({ action: z.enum(["start", "stop", "restart"]) });

const isProtectedContainer = (c: Container): boolean => c.composeProject !== undefined && RESERVED_STACK_NAMES.includes(c.composeProject);

export function registerContainerRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; auth: Guard; metrics: MetricsStore; logStreams: LogStreams; actions: ContainerActionService; isOnline: (hostId: string) => boolean },
): void {
  const { pool, auth } = deps;

  /** Conteneur de l'inventaire d'un hôte ; 404 si l'hôte ou le conteneur est inconnu. */
  async function find(hostId: string, containerId: string): Promise<{ host: { id: string; name: string }; container: Container }> {
    const { rows } = await pool.query<{ id: string; name: string; inventory: Container[] | null }>("SELECT id, name, inventory FROM hosts WHERE id = $1 AND revoked_at IS NULL", [hostId]);
    const host = rows[0];
    if (!host) throw new HttpError(404, "host_not_found", "Hôte introuvable");
    const container = (host.inventory ?? []).find((c) => c.id.startsWith(containerId) || containerId.startsWith(c.id));
    if (!container) throw new HttpError(404, "container_not_found", "Conteneur introuvable sur cet hôte");
    return { host: { id: host.id, name: host.name }, container };
  }

  // Tous les conteneurs de tous les hôtes (y compris ceux qui n'appartiennent à aucune application Compose).
  app.get("/api/v1/containers", { preHandler: auth }, async () => {
    const hidden = await hiddenProjects(pool);
    const [hostRows, stackRows] = await Promise.all([
      pool.query<{ id: string; name: string; inventory: Container[] | null }>("SELECT id, name, inventory FROM hosts WHERE revoked_at IS NULL ORDER BY created_at"),
      pool.query<{ id: string; name: string; host_id: string }>("SELECT id, name, host_id FROM stacks"),
    ]);
    const stackOf = new Map(stackRows.rows.map((s) => [`${s.host_id}|${s.name}`, s.id]));
    const containers: ContainerRow[] = [];
    for (const h of hostRows.rows) {
      const online = deps.isOnline(h.id);
      const usage = new Map((online ? await deps.metrics.latest(h.id) : []).map((s) => [s.containerId, s]));
      for (const c of h.inventory ?? []) {
        if (c.composeProject && hidden.includes(c.composeProject)) continue;
        const stackId = c.composeProject ? (stackOf.get(`${h.id}|${c.composeProject}`) ?? null) : null;
        const u = usage.get(c.id);
        containers.push({
          hostId: h.id,
          hostName: h.name,
          hostPresence: online ? "online" : "offline",
          id: c.id,
          name: c.names[0] ?? c.id.slice(0, 12),
          service: c.composeService ?? null,
          project: c.composeProject ?? null,
          appKind: c.composeProject ? (stackId ? "managed" : "observed") : null,
          stackId,
          image: c.image,
          state: c.state,
          status: c.status,
          health: c.health ?? null,
          restartCount: c.restartCount ?? 0,
          exitCode: c.exitCode ?? null,
          startedAt: c.startedAt || null,
          created: c.created,
          ports: c.ports ?? [],
          usage: u && c.state === "running" ? { cpuPercent: Math.round((u.cpuPercent ?? 0) * 100) / 100, memBytes: u.memBytes, memLimitBytes: u.memLimitBytes } : null,
          protected: isProtectedContainer(c),
        });
      }
    }
    return { containers };
  });

  // Logs en direct d'un conteneur (Server-Sent Events, mêmes limites que pour une stack).
  app.get("/api/v1/hosts/:hostId/containers/:containerId/logs", { preHandler: auth }, async (request, reply) => {
    const { hostId, containerId } = Params.parse(request.params);
    const q = z.object({ tail: z.coerce.number().int().min(0).max(1000).default(100) }).parse(request.query);
    const { container } = await find(hostId, containerId);
    if (!deps.isOnline(hostId)) throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne : logs indisponibles");
    serveLogStream(request, reply, deps.logStreams, hostId, { containerId: container.id }, { tail: q.tail });
  });

  // Courbes d'un conteneur (CPU, mémoire, réseau) sur une période.
  app.get("/api/v1/hosts/:hostId/containers/:containerId/metrics", { preHandler: auth }, async (request) => {
    const { hostId, containerId } = Params.parse(request.params);
    const q = z.object({ range: z.enum(["1h", "6h", "24h", "7d"]).default("1h") }).parse(request.query);
    const { container } = await find(hostId, containerId);
    return deps.metrics.series(hostId, null, RANGES[q.range] as number, undefined, container.id);
  });

  // Cycle de vie d'un conteneur isolé : hors Compose, donc un redéploiement de son application le remet dans l'état défini.
  app.post("/api/v1/hosts/:hostId/containers/:containerId/actions/:action", { preHandler: auth }, async (request, reply) => {
    const { hostId, containerId, action } = ActionParams.parse(request.params);
    const { host, container } = await find(hostId, containerId);
    if (isProtectedContainer(container)) throw new HttpError(403, "container_protected", "Ce conteneur fait tourner la console ou son agent : action refusée.");
    const name = container.names[0] ?? container.id.slice(0, 12);
    try {
      await deps.actions.run(hostId, container.id, action);
    } catch (err) {
      await audit(pool, request.actor, `container.${action}`, `${host.name}/${name}`, "failure");
      throw err;
    }
    await audit(pool, request.actor, `container.${action}`, `${host.name}/${name}`, "success");
    return reply.code(202).send({ ok: true });
  });
}
