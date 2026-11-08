import {
  ComposeEditError,
  RESERVED_STACK_NAMES,
  editServiceEnvironment,
  editServiceHealthcheck,
  validateHealthcheck,
  validateEnvironmentName,
  validateFilePath,
  validateVariableValue,
  type Container,
} from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { serveLogStream } from "./log-sse.js";
import type { LogStreams } from "./log-streams.js";
import type { OperationsService } from "./operations.js";
import {
  applyVariableChanges,
  changeStack,
  createStack,
  getRevision,
  maskVariables,
} from "./stacks.js";

const VariableInput = z.union([
  z.string(),
  z.object({ value: z.string().optional(), sensitive: z.boolean().optional() }),
]);
const Message = z.string().max(200).optional();
const Expected = z.number().int().positive();

export const CreateBody = z.object({
  name: z.string().min(1).max(63),
  hostId: z.uuid(),
  description: z.string().max(500).default(""),
  compose: z.string(),
  variables: z.record(z.string(), VariableInput).default({}),
  /** Importe un projet Compose déjà présent sur l'hôte au lieu de le refuser. */
  adopt: z.boolean().default(false),
  /** Chiffre le Compose dans la sauvegarde Git. */
  composeSensitive: z.boolean().default(false),
});
export const ComposeBody = z.object({
  expectedRevision: Expected,
  compose: z.string(),
  /** Chiffre (true) ou non (false) le Compose dans la sauvegarde Git ; inchangé si absent. */
  sensitive: z.boolean().optional(),
  message: Message,
});
export const VariablesBody = z.object({
  expectedRevision: Expected,
  set: z.record(z.string(), VariableInput).optional(),
  unset: z.array(z.string()).max(200).optional(),
  message: Message,
});
export const ServiceEnvBody = z.object({
  expectedRevision: Expected,
  set: z.record(z.string(), z.string()).optional(),
  unset: z.array(z.string()).max(200).optional(),
  message: Message,
});
export const HealthcheckBody = z.object({
  expectedRevision: Expected,
  test: z.string().min(1).max(1000),
  interval: z.string().max(16),
  timeout: z.string().max(16),
  retries: z.number().int(),
  startPeriod: z.string().max(16),
  message: Message,
});
export const FileBody = z.object({
  expectedRevision: Expected,
  content: z.string(),
  /** Chiffre (true) ou non (false) ce fichier dans la sauvegarde Git ; inchangé si absent. */
  sensitive: z.boolean().optional(),
  message: Message,
});
export const DeployBody = z
  .object({
    revision: z.number().int().positive().optional(),
    pullImages: z.boolean().optional(),
    forceRecreate: z.boolean().optional(),
  })
  .default({});
const IdParams = z.object({ id: z.uuid() });

/** Ce que les routes de stacks attendent du service de sauvegarde. */
export interface BackupStatusProvider {
  /** « pending » dès qu'un dépôt est configuré : le push est asynchrone, jamais présumé réussi. */
  changeStatus(): Promise<"not_configured" | "pending">;
}

interface StackListRow {
  id: string;
  name: string;
  host_id: string;
  host_name: string;
  description: string;
  current_revision: number;
  deployed_revision: number | null;
  deployed_at: Date | null;
  updated_at: Date;
  inventory: Container[] | null;
  inventory_observed_at: Date | null;
}

export function registerStackRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pool;
    auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    ops: OperationsService;
    logStreams: LogStreams;
    backup: BackupStatusProvider;
    isOnline: (hostId: string) => boolean;
  },
): void {
  const { pool, auth, ops } = deps;
  const backupInfo = async () => ({ status: await deps.backup.changeStatus() });

  const summarize = (r: StackListRow) => {
    const mine = (r.inventory ?? []).filter((c) => c.composeProject === r.name);
    return {
      id: r.id,
      name: r.name,
      hostId: r.host_id,
      hostName: r.host_name,
      hostPresence: deps.isOnline(r.host_id) ? "online" : "offline",
      description: r.description,
      currentRevision: r.current_revision,
      deployedRevision: r.deployed_revision,
      // Configuration enregistrée mais pas (encore) déployée.
      pendingDeploy: r.deployed_revision !== r.current_revision,
      deployedAt: r.deployed_at?.toISOString() ?? null,
      updatedAt: r.updated_at.toISOString(),
      // État observé lors du dernier inventaire ; absent si l'hôte n'a rien remonté.
      observed: r.inventory_observed_at
        ? {
            total: mine.length,
            running: mine.filter((c) => c.state === "running").length,
            observedAt: r.inventory_observed_at.toISOString(),
          }
        : null,
    };
  };

  const STACK_SELECT = `SELECT s.id, s.name, s.host_id, h.name AS host_name, s.description,
           s.current_revision, s.deployed_revision, s.deployed_at, s.updated_at,
           h.inventory, h.inventory_observed_at
      FROM stacks s JOIN hosts h ON h.id = s.host_id`;

  const loadStack = async (id: string): Promise<StackListRow> => {
    const { rows } = await pool.query<StackListRow>(`${STACK_SELECT} WHERE s.id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    return rows[0];
  };

  app.get("/api/v1/stacks", { preHandler: auth }, async () => {
    const { rows } = await pool.query<StackListRow>(`${STACK_SELECT} ORDER BY s.name`);
    return { stacks: rows.map(summarize) };
  });

  app.post("/api/v1/stacks", { preHandler: auth }, async (request, reply) => {
    const body = CreateBody.parse(request.body);
    const { id } = await createStack(pool, { ...body, author: request.actor });
    return reply.code(201).send({ id, revision: 1, backup: await backupInfo() });
  });

  // Projets Compose observés sur un hôte : gérés par une stack ou à importer.
  app.get("/api/v1/hosts/:id/projects", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const host = await pool.query<{ inventory: Container[] | null; inventory_observed_at: Date | null }>(
      "SELECT inventory, inventory_observed_at FROM hosts WHERE id = $1 AND revoked_at IS NULL",
      [id],
    );
    if (!host.rows[0]) throw new HttpError(404, "host_not_found", "Hôte introuvable");
    const managed = await pool.query<{ id: string; name: string }>("SELECT id, name FROM stacks WHERE host_id = $1", [id]);
    const byName = new Map(managed.rows.map((r) => [r.name, r.id]));
    const projects = new Map<string, Container[]>();
    for (const c of host.rows[0].inventory ?? []) {
      if (!c.composeProject) continue;
      projects.set(c.composeProject, [...(projects.get(c.composeProject) ?? []), c]);
    }
    return {
      observedAt: host.rows[0].inventory_observed_at?.toISOString() ?? null,
      projects: [...projects.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, containers]) => ({
          name,
          managedStackId: byName.get(name) ?? null,
          // Les projets de la console elle-même ne sont jamais importables.
          importable: !byName.has(name) && !RESERVED_STACK_NAMES.includes(name),
          total: containers.length,
          running: containers.filter((c) => c.state === "running").length,
          services: [...new Map(containers.map((c) => [c.composeService ?? c.names[0] ?? "?", c.image])).entries()].map(
            ([service, image]) => ({ service, image }),
          ),
        })),
    };
  });

  app.get("/api/v1/stacks/:id", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const stack = await loadStack(id);
    const rev = await getRevision(pool, id, stack.current_revision);
    if (!rev) throw new Error("révision courante introuvable");
    const mine = (stack.inventory ?? []).filter((c) => c.composeProject === stack.name);
    return {
      ...summarize(stack),
      compose: rev.compose,
      variables: maskVariables(rev.variables),
      files: Object.keys(rev.files).sort(),
      sensitiveFiles: [...rev.sensitiveFiles].sort(),
      composeSensitive: rev.composeSensitive,
      containers: mine,
    };
  });

  app.put("/api/v1/stacks/:id/compose", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = ComposeBody.parse(request.body);
    const result = await changeStack(pool, id, body.expectedRevision, request.actor, body.message ?? "Compose modifié", (c) => ({
      ...c,
      compose: body.compose,
      composeSensitive: body.sensitive ?? c.composeSensitive,
    }));
    return { ...result, backup: await backupInfo() };
  });

  app.patch("/api/v1/stacks/:id/variables", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = VariablesBody.parse(request.body);
    const result = await changeStack(pool, id, body.expectedRevision, request.actor, body.message ?? "Variables modifiées", (c) => ({
      ...c,
      variables: applyVariableChanges(c.variables, body.set, body.unset),
    }));
    return { ...result, backup: await backupInfo() };
  });

  // Variables d'environnement d'un service : édition du YAML en préservant sa forme.
  // Les valeurs écrites ici restent dans le texte du Compose (non masquées) :
  // les secrets doivent passer par les variables de stack sensibles (`${NOM}`).
  app.patch("/api/v1/stacks/:id/services/:service/environment", { preHandler: auth }, async (request) => {
    const params = IdParams.extend({ service: z.string().min(1).max(128) }).parse(request.params);
    const body = ServiceEnvBody.parse(request.body);
    for (const [name, value] of [...Object.entries(body.set ?? {}), ...(body.unset ?? []).map((n) => [n, ""] as const)]) {
      const err = validateEnvironmentName(name) ?? validateVariableValue(value);
      if (err) throw new HttpError(400, "invalid_variable", `${name} : ${err}`);
    }
    const result = await changeStack(
      pool,
      params.id,
      body.expectedRevision,
      request.actor,
      body.message ?? `Environnement du service ${params.service} modifié`,
      (c) => {
        try {
          return { ...c, compose: editServiceEnvironment(c.compose, params.service, body.set ?? {}, body.unset ?? []) };
        } catch (err) {
          if (err instanceof ComposeEditError) {
            throw new HttpError(
              err.code === "service_not_found" ? 404 : 422,
              err.code === "service_not_found" ? "service_not_found" : "unsupported_compose_structure",
              err.message,
            );
          }
          throw err;
        }
      },
    );
    return { ...result, backup: await backupInfo() };
  });

  // Healthcheck d'un service : aperçu du Compose modifié, puis enregistrement d'une révision.
  const healthcheckEdit = (compose: string, service: string, body: z.infer<typeof HealthcheckBody>): string => {
    const err = validateHealthcheck(body);
    if (err) throw new HttpError(400, "invalid_healthcheck", err);
    try {
      return editServiceHealthcheck(compose, service, body);
    } catch (e) {
      if (e instanceof ComposeEditError) {
        throw new HttpError(
          e.code === "service_not_found" ? 404 : 422,
          e.code === "service_not_found" ? "service_not_found" : "unsupported_compose_structure",
          e.message,
        );
      }
      throw e;
    }
  };
  const ServiceParams = IdParams.extend({ service: z.string().min(1).max(128) });

  app.post("/api/v1/stacks/:id/services/:service/healthcheck/preview", { preHandler: auth }, async (request) => {
    const params = ServiceParams.parse(request.params);
    const body = HealthcheckBody.parse(request.body);
    const stack = await loadStack(params.id);
    if (stack.current_revision !== body.expectedRevision) {
      throw new HttpError(409, "revision_conflict", "La stack a une révision plus récente : rechargez la page.");
    }
    const rev = await getRevision(pool, params.id, stack.current_revision);
    if (!rev) throw new Error("révision courante introuvable");
    return { before: rev.compose, after: healthcheckEdit(rev.compose, params.service, body) };
  });

  app.patch("/api/v1/stacks/:id/services/:service/healthcheck", { preHandler: auth }, async (request) => {
    const params = ServiceParams.parse(request.params);
    const body = HealthcheckBody.parse(request.body);
    const result = await changeStack(
      pool,
      params.id,
      body.expectedRevision,
      request.actor,
      body.message ?? `Healthcheck du service ${params.service} ajouté`,
      (c) => ({ ...c, compose: healthcheckEdit(c.compose, params.service, body) }),
    );
    return { ...result, backup: await backupInfo() };
  });

  const filePath = (request: FastifyRequest): string => {
    const path = (request.params as { "*": string })["*"];
    const err = validateFilePath(path);
    if (err) throw new HttpError(400, "invalid_file_path", err);
    return path;
  };

  app.put("/api/v1/stacks/:id/files/*", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const path = filePath(request);
    const body = FileBody.parse(request.body);
    const result = await changeStack(pool, id, body.expectedRevision, request.actor, body.message ?? `Fichier ${path} enregistré`, (c) => ({
      ...c,
      files: { ...c.files, [path]: body.content },
      sensitiveFiles:
        body.sensitive === undefined
          ? c.sensitiveFiles
          : body.sensitive
            ? [...new Set([...c.sensitiveFiles, path])]
            : c.sensitiveFiles.filter((p) => p !== path),
    }));
    return { ...result, backup: await backupInfo() };
  });

  app.delete("/api/v1/stacks/:id/files/*", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const path = filePath(request);
    const { expectedRevision } = z.object({ expectedRevision: z.coerce.number().int().positive() }).parse(request.query);
    const result = await changeStack(pool, id, expectedRevision, request.actor, `Fichier ${path} supprimé`, (c) => {
      const files = { ...c.files };
      delete files[path];
      return { ...c, files, sensitiveFiles: c.sensitiveFiles.filter((p) => p !== path) };
    });
    return { ...result, backup: await backupInfo() };
  });

  app.get("/api/v1/stacks/:id/revisions", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    await loadStack(id);
    const { rows } = await pool.query<{ revision: number; digest: string; author: string; message: string | null; created_at: Date }>(
      `SELECT revision, digest, author, message, created_at FROM stack_revisions
       WHERE stack_id = $1 ORDER BY revision DESC`,
      [id],
    );
    return {
      revisions: rows.map((r) => ({
        revision: r.revision,
        digest: r.digest,
        author: r.author,
        message: r.message,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  app.get("/api/v1/stacks/:id/revisions/:revision", { preHandler: auth }, async (request) => {
    const params = IdParams.extend({ revision: z.coerce.number().int().positive() }).parse(request.params);
    const rev = await getRevision(pool, params.id, params.revision);
    if (!rev) throw new HttpError(404, "revision_not_found", "Révision introuvable");
    return {
      revision: rev.revision,
      digest: rev.digest,
      author: rev.author,
      message: rev.message,
      createdAt: rev.createdAt.toISOString(),
      compose: rev.compose,
      variables: maskVariables(rev.variables),
      files: rev.files,
      sensitiveFiles: [...rev.sensitiveFiles].sort(),
      composeSensitive: rev.composeSensitive,
    };
  });

  // --- Opérations --------------------------------------------------------------
  const idempotencyKey = (request: FastifyRequest): string | undefined => {
    const raw = request.headers["idempotency-key"];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 128) {
      throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key invalide");
    }
    return raw;
  };

  const accepted = async (
    reply: FastifyReply,
    operation: { id: string; status: string },
    created: boolean,
  ) => {
    const url = `/api/v1/operations/${operation.id}`;
    reply.header("Location", url);
    return reply.code(created ? 202 : 200).send({ operationId: operation.id, status: operation.status, url });
  };

  app.post("/api/v1/stacks/:id/deploy", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = DeployBody.parse(request.body ?? {});
    const key = idempotencyKey(request);
    const { operation, created } = await ops.create({
      type: "deploy",
      stackId: id,
      requestedBy: request.actor,
      ...(body.revision !== undefined ? { revision: body.revision } : {}),
      ...(body.pullImages !== undefined ? { pullImages: body.pullImages } : {}),
      ...(body.forceRecreate !== undefined ? { forceRecreate: body.forceRecreate } : {}),
      ...(key ? { idempotencyKey: key } : {}),
    });
    return accepted(reply, operation, created);
  });

  for (const type of ["stop", "start"] as const) {
    app.post(`/api/v1/stacks/:id/${type}`, { preHandler: auth }, async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      const key = idempotencyKey(request);
      const { operation, created } = await ops.create({
        type,
        stackId: id,
        requestedBy: request.actor,
        ...(key ? { idempotencyKey: key } : {}),
      });
      return accepted(reply, operation, created);
    });
  }

  // --- Logs en direct (Server-Sent Events) ------------------------------------------
  // Événements : `lines` (tableau de lignes), `end` (raison), commentaires `: ping`.
  app.get("/api/v1/stacks/:id/logs", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const q = z
      .object({
        service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),
        tail: z.coerce.number().int().min(0).max(1000).default(100),
      })
      .parse(request.query);
    const stack = await loadStack(id);
    if (!deps.isOnline(stack.host_id)) {
      throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne : logs indisponibles");
    }

    serveLogStream(request, reply, deps.logStreams, stack.host_id, { stack: { id, project: stack.name } }, { tail: q.tail, ...(q.service ? { service: q.service } : {}) });
  });

  app.get("/api/v1/operations", { preHandler: auth }, async (request) => {
    const q = z
      .object({ stackId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(request.query);
    return { operations: await ops.list(q.stackId ?? null, q.limit) };
  });

  app.get("/api/v1/operations/:id", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const op = await ops.get(id);
    if (!op) throw new HttpError(404, "operation_not_found", "Opération introuvable");
    return op;
  });
}
