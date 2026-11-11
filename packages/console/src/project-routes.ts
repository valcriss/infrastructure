import type { Container } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Application } from "./applications.js";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { listObservedVersions } from "./observed-versions.js";
import type { ObservedWatcher } from "./observed-watch.js";
import { buildStorage, loadSizes, type StorageService } from "./storage.js";
import { loadUsedImages } from "./images.js";
import { POLICIES } from "./image-tags.js";
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
    observedWatcher: ObservedWatcher;
    storage: StorageService;
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

  // Stockage : montages (volumes nommés, dossiers « bind ») avec leur taille sur le disque, mesurée par l'agent.
  const storageView = async (id: string, name: string): Promise<unknown> => {
    const containers = await observed(id, name);
    const sizes = (await loadSizes(pool, id)).get(id) ?? new Map();
    return { ...buildStorage(containers, sizes), measuring: deps.storage.isMeasuring(id) };
  };

  app.get("/api/v1/hosts/:id/projects/:name/storage", { preHandler: auth }, async (request) => {
    const { id, name } = Params.parse(request.params);
    return storageView(id, name);
  });

  app.post("/api/v1/hosts/:id/projects/:name/storage/measure", { preHandler: auth }, async (request, reply) => {
    const { id, name } = Params.parse(request.params);
    const containers = await observed(id, name);
    // Asynchrone : un dossier volumineux peut demander plusieurs minutes ; le résultat se lit avec GET …/storage.
    await deps.storage.request(id, containers);
    return reply.code(202).send(await storageView(id, name));
  });

  // Historique des changements de version d'image des services (projets non gérés ; conservé après la prise en charge).
  app.get("/api/v1/hosts/:id/projects/:name/versions", { preHandler: auth }, async (request) => {
    const { id, name } = Params.parse(request.params);
    const host = await pool.query("SELECT 1 FROM hosts WHERE id = $1 AND revoked_at IS NULL", [id]);
    if (!host.rows[0]) throw new HttpError(404, "host_not_found", "Hôte introuvable");
    return { versions: await listObservedVersions(pool, id, name) };
  });

  // --- Suivi des mises à jour d'image (mêmes règles que pour une stack gérée) ---------------------------------

  const ServiceParams = Params.extend({ service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/) });
  const PolicyBody = z.object({ policy: z.enum(POLICIES as [string, ...string[]]), pattern: z.string().max(100).nullable().optional() });
  const watcher = deps.observedWatcher;

  app.get("/api/v1/hosts/:id/projects/:name/updates", { preHandler: auth }, async (request) => {
    const { id, name } = Params.parse(request.params);
    await observed(id, name);
    const [images, policies, checks, ignored] = await Promise.all([loadUsedImages(pool, { hostId: id, project: name }), watcher.policies(id, name), watcher.checks(id, name), watcher.ignoredTags(id, name)]);
    const byService = new Map(checks.map((c) => [c.service, c]));
    const seen = new Set<string>();
    const components: unknown[] = [];
    for (const img of images) {
      for (const u of img.usedBy) {
        if (!u.service || seen.has(u.service)) continue;
        seen.add(u.service);
        // Un résultat obtenu pour une autre référence (étiquette modifiée depuis) ne vaut plus.
        const found = byService.get(u.service);
        const c = found && (!found.detail?.ref || found.detail.ref === u.ref) ? found : undefined;
        components.push({
          service: u.service,
          ref: u.ref,
          policy: policies[u.service] ?? { policy: "same_tag", pattern: null },
          ignoredTags: (ignored[u.service] ?? []).map((i) => ({ tag: i.tag, reason: i.reason, createdBy: i.createdBy, createdAt: i.createdAt.toISOString() })),
          check: c
            ? { checkedAt: c.checkedAt.toISOString(), status: c.status, kind: c.kind, detail: c.detail, error: c.error, lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null }
            : null,
        });
      }
    }
    components.sort((a, b) => (a as { service: string }).service.localeCompare((b as { service: string }).service));
    return { checking: watcher.isChecking(id, name), components };
  });

  app.post("/api/v1/hosts/:id/projects/:name/image-checks", { preHandler: auth }, async (request, reply) => {
    const { id, name } = Params.parse(request.params);
    await observed(id, name);
    // Asynchrone : les registres peuvent être lents ; le résultat se lit avec GET …/updates.
    void watcher.checkProject(id, name).catch(() => {});
    return reply.code(202).send({ checking: true });
  });

  app.put("/api/v1/hosts/:id/projects/:name/services/:service/update-policy", { preHandler: auth }, async (request) => {
    const { id, name, service } = ServiceParams.parse(request.params);
    const body = PolicyBody.parse(request.body);
    await watcher.setPolicy(id, name, service, body.policy as never, body.pattern ?? null, request.actor);
    return { service, policy: body.policy, pattern: body.policy === "pattern" ? (body.pattern ?? null) : null };
  });

  app.post("/api/v1/hosts/:id/projects/:name/services/:service/ignored-tags", { preHandler: auth }, async (request, reply) => {
    const { id, name, service } = ServiceParams.parse(request.params);
    const body = z.object({ tag: z.string().min(1).max(128), reason: z.string().max(200).optional() }).parse(request.body);
    await watcher.ignoreTag(id, name, service, body.tag, body.reason?.trim() || null, request.actor);
    return reply.code(201).send({ service, tag: body.tag });
  });

  app.delete("/api/v1/hosts/:id/projects/:name/services/:service/ignored-tags/:tag", { preHandler: auth }, async (request, reply) => {
    const { id, name, service, tag } = ServiceParams.extend({ tag: z.string().min(1).max(128) }).parse(request.params);
    await watcher.unignoreTag(id, name, service, tag, request.actor);
    return reply.code(204).send();
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
