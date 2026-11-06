import { redact, type OperationResultSchema, type RunMessage } from "@infra/shared";
import type { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { getRevision } from "./stacks.js";

export type OperationType = "deploy" | "stop" | "start";
export type OperationStatus = "pending" | "running" | "succeeded" | "failed" | "unknown";
type OperationResult = z.infer<typeof OperationResultSchema>;

const MAX_LOG_CHARS = 256 * 1024;
/** Une opération « running » plus ancienne est considérée de résultat inconnu. */
const OPERATION_TIMEOUT_MS = 20 * 60 * 1000;

/** Ce que la passerelle des agents offre au service d'opérations. */
export interface AgentTransport {
  isOnline(hostId: string): boolean;
  send(hostId: string, message: RunMessage): boolean;
}

export interface OperationView {
  id: string;
  type: OperationType;
  stackId: string;
  hostId: string;
  revision: number | null;
  status: OperationStatus;
  options: unknown;
  requestedBy: string;
  error: string | null;
  result: unknown;
  log: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface OperationRow {
  id: string;
  type: OperationType;
  stack_id: string;
  host_id: string;
  revision: number | null;
  status: OperationStatus;
  options: unknown;
  requested_by: string;
  error: string | null;
  result: unknown;
  log: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const COLUMNS = `id, type, stack_id, host_id, revision, status, options, requested_by, error,
                 result, log, created_at, started_at, finished_at`;

const toView = (r: OperationRow): OperationView => ({
  id: r.id,
  type: r.type,
  stackId: r.stack_id,
  hostId: r.host_id,
  revision: r.revision,
  status: r.status,
  options: r.options,
  requestedBy: r.requested_by,
  error: r.error,
  result: r.result,
  log: r.log,
  createdAt: r.created_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null,
  finishedAt: r.finished_at?.toISOString() ?? null,
});

export interface CreateOperationInput {
  type: OperationType;
  stackId: string;
  /** Pour `deploy` : révision à appliquer ; défaut = révision courante. */
  revision?: number;
  pullImages?: boolean;
  forceRecreate?: boolean;
  requestedBy: string;
  idempotencyKey?: string;
}

export class OperationsService {
  /** Valeurs sensibles par opération, pour masquer la sortie côté console aussi. */
  private readonly secrets = new Map<string, string[]>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly pool: Pool,
    private readonly transport: AgentTransport,
  ) {
    this.sweeper = setInterval(() => void this.sweepTimeouts().catch(() => {}), 30_000);
    this.sweeper.unref();
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  /**
   * Au démarrage de la console, toute opération active a un résultat inconnu :
   * elle n'est jamais rejouée automatiquement.
   */
  async markInterruptedUnknown(): Promise<void> {
    await this.pool.query(
      `UPDATE operations SET status = 'unknown', finished_at = now(),
              error = 'Console redémarrée pendant l''opération : résultat inconnu'
       WHERE status IN ('pending', 'running')`,
    );
  }

  private async sweepTimeouts(): Promise<void> {
    await this.pool.query(
      `UPDATE operations SET status = 'unknown', finished_at = now(),
              error = 'Délai dépassé : résultat inconnu'
       WHERE status = 'running' AND started_at < now() - make_interval(secs => $1)`,
      [OPERATION_TIMEOUT_MS / 1000],
    );
  }

  async get(id: string): Promise<OperationView | null> {
    const { rows } = await this.pool.query<OperationRow>(
      `SELECT ${COLUMNS} FROM operations WHERE id = $1`,
      [id],
    );
    return rows[0] ? toView(rows[0]) : null;
  }

  async list(stackId: string | null, limit: number): Promise<Omit<OperationView, "log">[]> {
    const { rows } = await this.pool.query<OperationRow>(
      `SELECT ${COLUMNS} FROM operations WHERE ($1::uuid IS NULL OR stack_id = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [stackId, limit],
    );
    return rows.map((r) => {
      const { log: _log, ...rest } = toView(r);
      return rest;
    });
  }

  async create(input: CreateOperationInput): Promise<{ operation: OperationView; created: boolean }> {
    if (input.idempotencyKey) {
      const { rows } = await this.pool.query<OperationRow>(
        `SELECT ${COLUMNS} FROM operations WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const existing = rows[0];
      if (existing) {
        if (existing.stack_id !== input.stackId || existing.type !== input.type) {
          throw new HttpError(422, "idempotency_key_reused", "Clé d'idempotence déjà utilisée pour une autre commande");
        }
        return { operation: toView(existing), created: false };
      }
    }

    const stack = await this.pool.query<{ name: string; host_id: string; current_revision: number }>(
      "SELECT name, host_id, current_revision FROM stacks WHERE id = $1",
      [input.stackId],
    );
    const s = stack.rows[0];
    if (!s) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    if (!this.transport.isOnline(s.host_id)) {
      throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne : l'état réel est inconnu, rien n'a été lancé");
    }

    let payload: RunMessage["revision"];
    let revisionNumber: number | null = null;
    const secretValues: string[] = [];
    if (input.type === "deploy") {
      revisionNumber = input.revision ?? s.current_revision;
      const rev = await getRevision(this.pool, input.stackId, revisionNumber);
      if (!rev) throw new HttpError(404, "revision_not_found", "Révision introuvable");
      const variables: Record<string, string> = {};
      const sensitive: string[] = [];
      for (const [name, v] of Object.entries(rev.variables)) {
        variables[name] = v.value;
        if (v.sensitive) {
          sensitive.push(name);
          secretValues.push(v.value);
        }
      }
      payload = { number: rev.revision, compose: rev.compose, variables, sensitive, files: rev.files };
    }

    const options = { pullImages: input.pullImages ?? false, forceRecreate: input.forceRecreate ?? false };
    let id: string;
    try {
      const ins = await this.pool.query<{ id: string }>(
        `INSERT INTO operations (type, stack_id, host_id, revision, status, options, requested_by, idempotency_key)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7) RETURNING id`,
        [input.type, input.stackId, s.host_id, revisionNumber, JSON.stringify(options), input.requestedBy, input.idempotencyKey ?? null],
      );
      id = ins.rows[0]?.id ?? "";
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === "23505" && e.constraint === "operations_active_per_stack") {
        throw new HttpError(409, "stack_busy", "Une opération est déjà en cours sur cette stack");
      }
      throw err;
    }

    this.secrets.set(id, secretValues);
    const message: RunMessage = {
      type: "run",
      operationId: id,
      action: input.type,
      stack: { id: input.stackId, project: s.name },
      ...(payload ? { revision: payload } : {}),
      ...(input.type === "deploy" ? { options } : {}),
    };

    if (!this.transport.send(s.host_id, message)) {
      await this.pool.query(
        `UPDATE operations SET status = 'failed', finished_at = now(),
                error = 'Agent hors ligne : commande non envoyée' WHERE id = $1`,
        [id],
      );
      this.secrets.delete(id);
      throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne : rien n'a été lancé");
    }
    await this.pool.query("UPDATE operations SET status = 'running', started_at = now() WHERE id = $1", [id]);
    await audit(this.pool, input.requestedBy, `operation.${input.type}`, id, "success");
    const op = await this.get(id);
    if (!op) throw new Error("opération introuvable après création");
    return { operation: op, created: true };
  }

  // --- Retours de l'agent ---------------------------------------------------

  async onLog(hostId: string, operationId: string, text: string): Promise<void> {
    const clean = redact(text, this.secrets.get(operationId) ?? []);
    // Taille bornée : on garde le début ; la fin est perdue au-delà de la limite.
    await this.pool.query(
      `UPDATE operations SET log = substr(log || $3, 1, $4)
       WHERE id = $1 AND host_id = $2 AND status IN ('running', 'unknown')`,
      [operationId, hostId, clean, MAX_LOG_CHARS],
    );
  }

  async onResult(hostId: string, msg: OperationResult): Promise<void> {
    const { rows } = await this.pool.query<{ type: OperationType; stack_id: string; revision: number | null }>(
      `UPDATE operations
          SET status = $3, finished_at = now(), error = $4, result = $5
        WHERE id = $1 AND host_id = $2 AND status IN ('running', 'unknown')
        RETURNING type, stack_id, revision`,
      [
        msg.operationId,
        hostId,
        msg.status,
        redact(msg.error ?? "", this.secrets.get(msg.operationId) ?? []) || null,
        JSON.stringify({ images: msg.images ?? [], services: msg.services ?? [] }),
      ],
    );
    this.secrets.delete(msg.operationId);
    const op = rows[0];
    if (!op) return; // inconnue, d'un autre hôte ou déjà terminée : ignorée
    if (op.type === "deploy" && msg.status === "succeeded" && op.revision !== null) {
      await this.pool.query(
        "UPDATE stacks SET deployed_revision = $2, deployed_at = now() WHERE id = $1",
        [op.stack_id, op.revision],
      );
    }
  }

  /** Perte de connexion : le résultat des opérations en cours est inconnu. */
  async onDisconnect(hostId: string): Promise<void> {
    await this.pool.query(
      `UPDATE operations SET status = 'unknown', finished_at = now(),
              error = 'Connexion à l''agent perdue : résultat inconnu, rien n''est rejoué automatiquement'
       WHERE host_id = $1 AND status = 'running'`,
      [hostId],
    );
  }
}
