import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Dashboard } from "./dashboard.js";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { RANGES, type MetricsStore } from "./metrics-store.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const DashboardQuery = z.object({
  hostId: z.uuid().optional(),
  stackId: z.uuid().optional(),
});

export const MetricsQuery = z.object({
  range: z.enum(["1h", "6h", "24h", "7d"]).default("1h"),
  service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),
});

export function registerDashboardRoutes(
  app: FastifyInstance,
  deps: { auth: Guard; dashboard: Dashboard; metrics: MetricsStore; pool: Pool },
): void {
  const { auth, dashboard, metrics, pool } = deps;

  // Vue d'ensemble : agents, stacks, conteneurs, utilisation, alertes.
  app.get("/api/v1/dashboard", { preHandler: auth }, async (request) => {
    const q = DashboardQuery.parse(request.query);
    return dashboard.snapshot(q);
  });

  // Métriques d'une stack : CPU, mémoire, réseau par conteneur, rétention bornée.
  app.get("/api/v1/stacks/:id/metrics", { preHandler: auth }, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const q = MetricsQuery.parse(request.query);
    const { rows } = await pool.query<{ name: string; host_id: string }>("SELECT name, host_id FROM stacks WHERE id = $1", [id]);
    const stack = rows[0];
    if (!stack) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    return metrics.series(stack.host_id, stack.name, RANGES[q.range] as number, q.service);
  });
}
