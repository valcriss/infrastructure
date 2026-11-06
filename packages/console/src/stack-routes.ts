import { validateFilePath, type Container } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";
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

const CreateBody = z.object({
  name: z.string().min(1).max(63),
  hostId: z.uuid(),
  description: z.string().max(500).default(""),
  compose: z.string(),
  variables: z.record(z.string(), VariableInput).default({}),
});
const ComposeBody = z.object({ expectedRevision: Expected, compose: z.string(), message: Message });
const VariablesBody = z.object({
  expectedRevision: Expected,
  set: z.record(z.string(), VariableInput).optional(),
  unset: z.array(z.string()).max(200).optional(),
  message: Message,
});
const FileBody = z.object({ expectedRevision: Expected, content: z.string(), message: Message });
const DeployBody = z
  .object({
    revision: z.number().int().positive().optional(),
    pullImages: z.boolean().optional(),
    forceRecreate: z.boolean().optional(),
  })
  .default({});
const IdParams = z.object({ id: z.uuid() });

/** Dans cette première version, aucune sauvegarde Git n'existe encore (Phase 3). */
const BACKUP = { status: "not_configured" } as const;

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
    isOnline: (hostId: string) => boolean;
  },
): void {
  const { pool, auth, ops } = deps;

  const actor = async (): Promise<string> =>
    (await pool.query<{ username: string }>("SELECT username FROM admin")).rows[0]?.username ?? "admin";

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
    const { id } = await createStack(pool, { ...body, author: await actor() });
    return reply.code(201).send({ id, revision: 1, backup: BACKUP });
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
      containers: mine,
    };
  });

  app.put("/api/v1/stacks/:id/compose", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = ComposeBody.parse(request.body);
    const result = await changeStack(pool, id, body.expectedRevision, await actor(), body.message ?? "Compose modifié", (c) => ({
      ...c,
      compose: body.compose,
    }));
    return { ...result, backup: BACKUP };
  });

  app.patch("/api/v1/stacks/:id/variables", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = VariablesBody.parse(request.body);
    const result = await changeStack(pool, id, body.expectedRevision, await actor(), body.message ?? "Variables modifiées", (c) => ({
      ...c,
      variables: applyVariableChanges(c.variables, body.set, body.unset),
    }));
    return { ...result, backup: BACKUP };
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
    const result = await changeStack(pool, id, body.expectedRevision, await actor(), body.message ?? `Fichier ${path} enregistré`, (c) => ({
      ...c,
      files: { ...c.files, [path]: body.content },
    }));
    return { ...result, backup: BACKUP };
  });

  app.delete("/api/v1/stacks/:id/files/*", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const path = filePath(request);
    const { expectedRevision } = z.object({ expectedRevision: z.coerce.number().int().positive() }).parse(request.query);
    const result = await changeStack(pool, id, expectedRevision, await actor(), `Fichier ${path} supprimé`, (c) => {
      const files = { ...c.files };
      delete files[path];
      return { ...c, files };
    });
    return { ...result, backup: BACKUP };
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
      requestedBy: await actor(),
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
        requestedBy: await actor(),
        ...(key ? { idempotencyKey: key } : {}),
      });
      return accepted(reply, operation, created);
    });
  }

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
