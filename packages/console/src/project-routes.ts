import type { Container } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Application } from "./applications.js";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { serveLogStream } from "./log-sse.js";
import type { LogStreams } from "./log-streams.js";
import { RANGES, type MetricsStore } from "./metrics-store.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const Params = z.object({ id: z.uuid(), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) });

/**
 * Fiche en lecture seule d'un projet Compose d'un hôte, géré ou non par la console : conteneurs (ports, réseaux,
 * montages, libellés Compose), métriques et logs d'un conteneur. Aucune action : une application non gérée
 * ne peut être ni démarrée, ni arrêtée, ni modifiée tant qu'elle n'est pas prise en charge.
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pool;
    auth: Guard;
    metrics: MetricsStore;
    logStreams: LogStreams;
    applications: () => Promise<Application[]>;
    isOnline: (hostId: string) => boolean;
  },
): void {
  const { pool, auth } = deps;

  /** Conteneurs observés du projet (même un projet géré) ; 404 si l'hôte ou le projet est inconnu. */
  async function observed(hostId: string, name: string): Promise<Container[]> {
    const host = await pool.query<{ inventory: Container[] | null }>("SELECT inventory FROM hosts WHERE id = $1 AND revoked_at IS NULL", [hostId]);
    if (!host.rows[0]) throw new HttpError(404, "host_not_found", "Hôte introuvable");
    const containers = (host.rows[0].inventory ?? []).filter((c) => c.composeProject === name);
    if (containers.length === 0) throw new HttpError(404, "project_not_found", "Projet introuvable sur cet hôte");
    return containers;
  }

  app.get("/api/v1/hosts/:id/projects/:name", { preHandler: auth }, async (request) => {
    const { id, name } = Params.parse(request.params);
    const containers = await observed(id, name);
    const application = (await deps.applications()).find((a) => a.hostId === id && a.name === name);
    if (!application) throw new HttpError(404, "project_not_found", "Projet introuvable sur cet hôte");
    return { application, containers };
  });

  app.get("/api/v1/hosts/:id/projects/:name/metrics", { preHandler: auth }, async (request) => {
    const { id, name } = Params.parse(request.params);
    const q = z
      .object({
        range: z.enum(["1h", "6h", "24h", "7d"]).default("1h"),
        service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),
      })
      .parse(request.query);
    await observed(id, name);
    return deps.metrics.series(id, name, RANGES[q.range] as number, q.service);
  });

  // Logs en direct d'un conteneur du projet (Server-Sent Events, mêmes limites que pour une stack).
  app.get("/api/v1/hosts/:id/projects/:name/logs", { preHandler: auth }, async (request, reply) => {
    const { id, name } = Params.parse(request.params);
    const q = z
      .object({
        container: z.string().regex(/^[0-9a-f]{12,64}$/),
        tail: z.coerce.number().int().min(0).max(1000).default(100),
      })
      .parse(request.query);
    const containers = await observed(id, name);
    // Seuls les conteneurs du projet demandé sont accessibles.
    if (!containers.some((c) => c.id.startsWith(q.container) || q.container.startsWith(c.id))) {
      throw new HttpError(404, "container_not_found", "Conteneur introuvable dans ce projet");
    }
    if (!deps.isOnline(id)) throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne : logs indisponibles");
    serveLogStream(request, reply, deps.logStreams, id, { containerId: q.container }, { tail: q.tail });
  });
}
