import { RESERVED_STACK_NAMES, type Container, type RemovalPlanResultSchema } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import type { AgentGateway } from "./gateway.js";
import { HttpError } from "./http-error.js";
import type { OperationsService } from "./operations.js";
import { bumpConfigRevision } from "./stacks.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type Plan = z.infer<typeof RemovalPlanResultSchema>;

const PLAN_TIMEOUT_MS = 60_000;

interface Pending {
  hostId: string;
  resolve: (p: Plan) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Demande à l'agent ce que la suppression d'une application retirerait de l'hôte (lecture seule). */
export class RemovalPlanService {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly gateway: AgentGateway) {}

  plan(hostId: string, stack: { id: string; project: string }): Promise<Plan> {
    return new Promise((resolve, reject) => {
      const planId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(planId);
        reject(new HttpError(504, "plan_timeout", "L'agent n'a pas répondu à temps."));
      }, PLAN_TIMEOUT_MS);
      this.pending.set(planId, { hostId, resolve, reject, timer });
      if (!this.gateway.send(hostId, { type: "removal_plan", planId, stack })) {
        clearTimeout(timer);
        this.pending.delete(planId);
        reject(new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne"));
      }
    });
  }

  onResult(hostId: string, msg: Plan): void {
    const p = this.pending.get(msg.planId);
    if (!p || p.hostId !== hostId) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.planId);
    if (msg.error) p.reject(new HttpError(422, "plan_failed", msg.error));
    else p.resolve(msg);
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

const IdParams = z.object({ id: z.uuid() });
export const DestroyBody = z.object({
  /** Nom exact de l'application : confirmation explicite. */
  confirmName: z.string().min(1).max(63),
  networks: z.boolean(),
  volumes: z.array(z.string().max(255)).max(200),
  images: z.array(z.string().max(300)).max(100),
  workspace: z.boolean(),
});
export const FinalizeBody = z.object({
  confirmName: z.string().min(1).max(63),
  /** Supprimer quand même la configuration alors que l'hôte n'a pas été nettoyé (éléments orphelins laissés sur l'hôte). */
  skipHost: z.boolean().default(false),
});

interface StackRow {
  id: string;
  name: string;
  host_id: string;
  deployed_revision: number | null;
}

export function registerRemovalRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; auth: Guard; ops: OperationsService; plans: RemovalPlanService; isOnline: (hostId: string) => boolean },
): void {
  const { pool, auth, ops, plans } = deps;

  const load = async (id: string): Promise<StackRow> => {
    const { rows } = await pool.query<StackRow>("SELECT id, name, host_id, deployed_revision FROM stacks WHERE id = $1", [id]);
    const s = rows[0];
    if (!s) throw new HttpError(404, "stack_not_found", "Application introuvable");
    if (RESERVED_STACK_NAMES.includes(s.name)) throw new HttpError(403, "stack_protected", "La console et son agent ne peuvent pas être supprimés depuis leur propre interface.");
    return s;
  };

  /** Conteneurs du projet d'après le dernier inventaire de l'hôte. */
  const inventoryOf = async (s: StackRow): Promise<Container[]> => {
    const { rows } = await pool.query<{ inventory: Container[] | null }>("SELECT inventory FROM hosts WHERE id = $1", [s.host_id]);
    return (rows[0]?.inventory ?? []).filter((c) => c.composeProject === s.name);
  };

  const confirm = (s: StackRow, typed: string): void => {
    if (typed !== s.name) throw new HttpError(422, "name_mismatch", "Le nom saisi ne correspond pas au nom de l'application.");
  };

  // Ce que la suppression retirerait : côté hôte (agent) et côté console. Lecture seule.
  app.post("/api/v1/stacks/:id/removal-plan", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const s = await load(id);
    const count = async (sql: string): Promise<number> => Number((await pool.query<{ n: string }>(sql, [id])).rows[0]?.n ?? 0);
    const consoleSide = {
      revisions: await count("SELECT count(*) AS n FROM stack_revisions WHERE stack_id = $1"),
      operations: await count("SELECT count(*) AS n FROM operations WHERE stack_id = $1"),
      imageChecks: await count("SELECT (SELECT count(*) FROM image_checks WHERE stack_id = $1) + (SELECT count(*) FROM candidate_scans WHERE stack_id = $1) + (SELECT count(*) FROM image_policies WHERE stack_id = $1) AS n"),
    };
    const active = await count("SELECT count(*) AS n FROM operations WHERE stack_id = $1 AND status IN ('pending', 'running')");
    let host: (Plan & { available: true }) | { available: false; reason: string };
    if (!deps.isOnline(s.host_id)) {
      host = { available: false, reason: "L'agent de l'hôte est hors ligne : seuls les éléments de la console peuvent être supprimés." };
    } else {
      host = { ...(await plans.plan(s.host_id, { id: s.id, project: s.name })), available: true };
    }
    return { stack: { id: s.id, name: s.name, deployed: s.deployed_revision !== null }, busy: active > 0, host, console: consoleSide };
  });

  // Retire de l'hôte les éléments cochés : opération suivie comme un déploiement (journal, statut). Réservé aux administrateurs.
  app.post("/api/v1/stacks/:id/destroy", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = DestroyBody.parse(request.body);
    const s = await load(id);
    confirm(s, body.confirmName);
    if ((await inventoryOf(s)).some((c) => c.state === "running")) {
      throw new HttpError(409, "stack_running", "Un conteneur de l'application est en marche : arrêtez-la avant de la supprimer.");
    }
    const key = request.headers["idempotency-key"];
    const { operation, created } = await ops.create({
      type: "destroy",
      stackId: id,
      requestedBy: request.actor,
      removal: { networks: body.networks, volumes: body.volumes, images: body.images, workspace: body.workspace },
      ...(typeof key === "string" && key.length > 0 && key.length <= 128 ? { idempotencyKey: key } : {}),
    });
    const url = `/api/v1/operations/${operation.id}`;
    reply.header("Location", url);
    return reply.code(created ? 202 : 200).send({ operationId: operation.id, status: operation.status, url });
  });

  // Supprime l'application de la console (configuration, révisions, historique). Réservé aux administrateurs.
  // N'a lieu qu'une fois l'hôte nettoyé (dernière opération « destroy » réussie, ou rien à nettoyer) ou sur demande explicite.
  app.delete("/api/v1/stacks/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = FinalizeBody.parse(request.body);
    const s = await load(id);
    confirm(s, body.confirmName);

    const active = await pool.query("SELECT 1 FROM operations WHERE stack_id = $1 AND status IN ('pending', 'running')", [id]);
    if ((active.rowCount ?? 0) > 0) throw new HttpError(409, "stack_busy", "Une opération est en cours sur cette application.");
    const inventory = await inventoryOf(s);
    if (inventory.some((c) => c.state === "running")) throw new HttpError(409, "stack_running", "Un conteneur de l'application est en marche : arrêtez-la avant de la supprimer.");

    const last = await pool.query<{ type: string; status: string }>("SELECT type, status FROM operations WHERE stack_id = $1 ORDER BY created_at DESC LIMIT 1", [id]);
    const hostCleaned = last.rows[0]?.type === "destroy" && last.rows[0].status === "succeeded";
    const nothingOnHost = s.deployed_revision === null && inventory.length === 0;
    if (!hostCleaned && !nothingOnHost && !body.skipHost) {
      throw new HttpError(409, "host_not_cleaned", "Des éléments de l'application existent encore sur l'hôte : retirez-les d'abord, ou confirmez la suppression de la seule configuration.");
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM operations WHERE stack_id = $1", [id]);
      await client.query("DELETE FROM stacks WHERE id = $1", [id]);
      await bumpConfigRevision(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await audit(pool, request.actor, "stack.delete", `${s.name}${body.skipHost && !hostCleaned ? " (hôte non nettoyé)" : ""}`, "success");
    return reply.code(204).send();
  });
}
