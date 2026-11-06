import {
  AgentMessageSchema,
  DEFAULT_METRICS_INTERVAL_SEC,
  HEARTBEAT_INTERVAL_SEC,
  INVENTORY_INTERVAL_SEC,
  OFFLINE_AFTER_SEC,
  PROTOCOL_VERSION,
  type ConsoleMessage,
  type Inventory,
  type MetricSample,
  type OperationResultSchema,
} from "@infra/shared";
import type { z } from "zod";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { removeBootstrapFile } from "./bootstrap.js";
import { randomToken, safeEqualHex, sha256 } from "./crypto.js";
import { audit, type Pool } from "./db.js";

const HELLO_TIMEOUT_MS = 10_000;

/** Retours des agents vers le service d'opérations. */
export interface GatewayHandlers {
  onLog(hostId: string, operationId: string, text: string): Promise<void>;
  onResult(hostId: string, msg: z.infer<typeof OperationResultSchema>): Promise<void>;
  onDisconnect(hostId: string): Promise<void>;
  onLogChunk(hostId: string, streamId: string, lines: string[]): void;
  onLogEnd(hostId: string, streamId: string, reason: string): void;
  onMetrics(hostId: string, samples: MetricSample[]): Promise<void>;
}

interface Connection {
  socket: WebSocket;
  lastMessageAt: number;
}

/**
 * Passerelle des agents : connexions WebSocket sortantes des agents vers la
 * console. Seuls les messages typés du protocole sont acceptés.
 */
export class AgentGateway {
  private readonly connections = new Map<string, Connection>();
  private readonly reaper: NodeJS.Timeout;
  private handlers: GatewayHandlers | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly sharedDir: string,
    private readonly log: FastifyBaseLogger,
    private readonly metricsIntervalSec: number = DEFAULT_METRICS_INTERVAL_SEC,
  ) {
    this.reaper = setInterval(() => this.reapIdle(), 5_000);
    this.reaper.unref();
  }

  setHandlers(handlers: GatewayHandlers): void {
    this.handlers = handlers;
  }

  isOnline(hostId: string): boolean {
    return this.connections.has(hostId);
  }

  /** Envoie une commande typée à l'agent ; faux si l'hôte n'est pas connecté. */
  send(hostId: string, message: ConsoleMessage): boolean {
    const conn = this.connections.get(hostId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) return false;
    conn.socket.send(JSON.stringify(message));
    return true;
  }

  disconnect(hostId: string): void {
    this.connections.get(hostId)?.socket.close(1008, "revoked");
    this.connections.delete(hostId);
  }

  close(): void {
    clearInterval(this.reaper);
    for (const { socket } of this.connections.values()) socket.close(1001, "shutdown");
    this.connections.clear();
  }

  private reapIdle(): void {
    const limit = Date.now() - OFFLINE_AFTER_SEC * 1000;
    for (const [id, c] of this.connections) {
      if (c.lastMessageAt < limit) {
        this.log.warn({ hostId: id }, "agent silencieux, connexion fermée");
        c.socket.terminate();
        this.connections.delete(id);
      }
    }
  }

  private sendTo(socket: WebSocket, message: ConsoleMessage): void {
    socket.send(JSON.stringify(message));
  }

  private fail(
    socket: WebSocket,
    code: "bad_request" | "unauthorized" | "protocol_mismatch" | "revoked",
    message: string,
  ): void {
    this.sendTo(socket, { type: "error", code, message });
    socket.close(1008, code);
  }

  handle(socket: WebSocket): void {
    let hostId: string | null = null;
    const helloTimer = setTimeout(() => {
      if (!hostId) this.fail(socket, "bad_request", "hello attendu");
    }, HELLO_TIMEOUT_MS);

    socket.on("message", (raw, isBinary) => {
      void (async () => {
        if (isBinary) return this.fail(socket, "bad_request", "messages JSON uniquement");
        let json: unknown;
        try {
          json = JSON.parse(raw.toString());
        } catch {
          return this.fail(socket, "bad_request", "JSON invalide");
        }
        const parsed = AgentMessageSchema.safeParse(json);
        if (!parsed.success) return this.fail(socket, "bad_request", "message non reconnu");
        const msg = parsed.data;

        if (hostId === null) {
          if (msg.type !== "hello") return this.fail(socket, "unauthorized", "hello attendu");
          if (msg.protocol !== PROTOCOL_VERSION) {
            return this.fail(socket, "protocol_mismatch", `protocole ${PROTOCOL_VERSION} requis`);
          }
          const result = await this.authenticate(msg);
          if (!result.ok) return this.fail(socket, result.code, result.message);
          clearTimeout(helloTimer);
          hostId = result.hostId;
          this.connections.get(hostId)?.socket.close(1000, "replaced");
          this.connections.set(hostId, { socket, lastMessageAt: Date.now() });
          await this.pool.query(
            `UPDATE hosts SET last_seen_at = now(), agent_version = $2, capabilities = $3
             WHERE id = $1`,
            [hostId, msg.agentVersion, JSON.stringify(msg.capabilities)],
          );
          this.sendTo(socket, {
            type: "welcome",
            protocol: PROTOCOL_VERSION,
            agentId: hostId,
            ...(result.credentials ? { credentials: result.credentials } : {}),
            heartbeatIntervalSec: HEARTBEAT_INTERVAL_SEC,
            inventoryIntervalSec: INVENTORY_INTERVAL_SEC,
            metricsIntervalSec: this.metricsIntervalSec,
          });
          return;
        }

        const conn = this.connections.get(hostId);
        if (conn?.socket !== socket) return; // connexion remplacée
        conn.lastMessageAt = Date.now();

        switch (msg.type) {
          case "heartbeat":
            await this.pool.query("UPDATE hosts SET last_seen_at = now() WHERE id = $1", [hostId]);
            break;
          case "inventory":
            await this.storeInventory(hostId, msg.inventory);
            break;
          case "metrics":
            await this.handlers?.onMetrics(hostId, msg.samples);
            break;
          case "operation_log":
            await this.handlers?.onLog(hostId, msg.operationId, msg.text);
            break;
          case "operation_result":
            await this.handlers?.onResult(hostId, msg);
            break;
          case "log_chunk":
            this.handlers?.onLogChunk(hostId, msg.streamId, msg.lines);
            break;
          case "log_end":
            this.handlers?.onLogEnd(hostId, msg.streamId, msg.reason);
            break;
          case "hello":
            this.fail(socket, "bad_request", "hello déjà reçu");
            break;
        }
      })().catch((err: unknown) => {
        this.log.error({ err }, "erreur de traitement d'un message agent");
        socket.close(1011, "internal");
      });
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (hostId) {
        if (this.connections.get(hostId)?.socket === socket) this.connections.delete(hostId);
        // Aucune reconnexion déjà établie : les opérations en cours deviennent « inconnues ».
        if (!this.connections.has(hostId)) {
          void this.handlers?.onDisconnect(hostId).catch((err: unknown) =>
            this.log.error({ err }, "erreur lors de la perte de connexion d'un agent"),
          );
        }
      }
    });
    socket.on("error", (err) => this.log.warn({ err }, "erreur de socket agent"));
  }

  private async storeInventory(hostId: string, inventory: Inventory): Promise<void> {
    await this.pool.query(
      // L'horodatage d'observation est celui de la console : il ne dépend pas de l'horloge de l'hôte.
      `UPDATE hosts SET inventory = $2, inventory_observed_at = now(),
              docker_version = $3, host_info = $4, last_seen_at = now()
       WHERE id = $1`,
      [hostId, JSON.stringify(inventory.containers), inventory.dockerVersion, inventory.hostInfo ? JSON.stringify(inventory.hostInfo) : null],
    );
  }

  private async authenticate(
    msg: Extract<ReturnType<typeof AgentMessageSchema.parse>, { type: "hello" }>,
  ): Promise<
    | { ok: true; hostId: string; credentials?: { agentId: string; secret: string } }
    | { ok: false; code: "unauthorized" | "revoked"; message: string }
  > {
    if (msg.auth.kind === "credentials") {
      const { rows } = await this.pool.query<{ secret_hash: string; revoked_at: Date | null }>(
        "SELECT secret_hash, revoked_at FROM hosts WHERE id = $1",
        [msg.auth.agentId],
      );
      const host = rows[0];
      if (!host || !safeEqualHex(host.secret_hash, sha256(msg.auth.secret))) {
        return { ok: false, code: "unauthorized", message: "identifiants invalides" };
      }
      if (host.revoked_at) return { ok: false, code: "revoked", message: "agent révoqué" };
      return { ok: true, hostId: msg.auth.agentId };
    }

    // Enrôlement : le jeton est consommé de façon atomique (usage unique).
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const used = await client.query<{ host_name: string | null; purpose: string }>(
        `UPDATE enrollment_tokens SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING host_name, purpose`,
        [sha256(msg.auth.token)],
      );
      const token = used.rows[0];
      if (!token) {
        await client.query("ROLLBACK");
        return { ok: false, code: "unauthorized", message: "jeton d'enrôlement invalide" };
      }
      const secret = randomToken(32);
      const created = await client.query<{ id: string }>(
        `INSERT INTO hosts (name, secret_hash, agent_version, capabilities, last_seen_at)
         VALUES ($1, $2, $3, $4, now()) RETURNING id`,
        [
          token.host_name ?? msg.hostname,
          sha256(secret),
          msg.agentVersion,
          JSON.stringify(msg.capabilities),
        ],
      );
      await client.query("COMMIT");
      const hostId = created.rows[0]?.id;
      if (!hostId) throw new Error("création d'hôte sans identifiant");
      if (token.purpose === "bootstrap") await removeBootstrapFile(this.sharedDir);
      await audit(this.pool, "agent", "host.enroll", hostId, "success");
      return { ok: true, hostId, credentials: { agentId: hostId, secret } };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
