import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Application } from "./applications.js";
import type { Dashboard } from "./dashboard.js";
import type { Pool } from "./db.js";
import { hiddenProjects } from "./display.js";
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
  deps: { auth: Guard; dashboard: Dashboard; metrics: MetricsStore; pool: Pool; applications: () => Promise<Application[]> },
): void {
  const { auth, dashboard, metrics, pool, applications } = deps;

  // Vue d'ensemble : agents, stacks, conteneurs, utilisation, alertes.
  app.get("/api/v1/dashboard", { preHandler: auth }, async (request) => {
    const q = DashboardQuery.parse(request.query);
    return dashboard.snapshot(q);
  });

  // Applications : stacks gérées et projets Compose observés, avec état, utilisation, images et mises à jour.
  app.get("/api/v1/applications", { preHandler: auth }, async () => ({ applications: await applications() }));

  // Totaux CPU / mémoire / réseau, applications les plus gourmandes et utilisation de chaque hôte.
  app.get("/api/v1/dashboard/overview", { preHandler: auth }, async (request) => {
    const q = MetricsQuery.pick({ range: true }).parse(request.query);
    return metrics.overview(RANGES[q.range] as number, await hiddenProjects(pool));
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
