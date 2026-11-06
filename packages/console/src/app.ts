import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  ChangeCredentialsSchema,
  LoginRequestSchema,
  MAX_MESSAGE_BYTES,
  OFFLINE_AFTER_SEC,
  SetupRequestSchema,
  type HostSummary,
} from "@infra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { z, ZodError } from "zod";
import { createRestorationKey } from "./restoration.js";
import {
  LoginLimiter,
  SESSION_COOKIE,
  createSession,
  destroySession,
  isAuthenticated,
  requireAuth,
} from "./auth.js";
import { ensureBootstrapToken } from "./bootstrap.js";
import type { Config } from "./config.js";
import { hashPassword, randomToken, safeEqualHex, sha256, verifyPassword } from "./crypto.js";
import { audit, type Pool } from "./db.js";
import { AgentGateway } from "./gateway.js";
import { HttpError } from "./http-error.js";
import { OperationsService } from "./operations.js";
import { registerStackRoutes } from "./stack-routes.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
  logger?: boolean;
}

export interface SetupState {
  /** Secret d'initialisation temporaire ; null une fois la console initialisée. */
  token: string | null;
}

export interface BuiltApp {
  app: FastifyInstance;
  setup: SetupState;
  gateway: AgentGateway;
  ops: OperationsService;
}

const apiError = (code: string, message: string) => ({ error: { code, message } });

// Hash factice : égalise le temps de réponse quand l'identifiant est inconnu.
const DUMMY_HASH =
  "$argon2id$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export async function buildApp({ config, pool, logger = false }: AppDeps): Promise<BuiltApp> {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  const limiter = new LoginLimiter();
  const auth = requireAuth(pool);

  const adminExists = async (): Promise<boolean> =>
    ((await pool.query("SELECT 1 FROM admin")).rowCount ?? 0) > 0;

  const setup: SetupState = { token: (await adminExists()) ? null : randomToken(24) };
  const gateway = new AgentGateway(pool, config.sharedDir, app.log);

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  app.addHook("onClose", async () => gateway.close());

  // Défense CSRF en plus de SameSite=Strict : refuse les requêtes modifiantes
  // dont l'en-tête Origin ne correspond pas à l'hôte demandé.
  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* origine invalide */
    }
    if (originHost !== request.headers.host) {
      await reply.code(403).send(apiError("forbidden_origin", "Origine refusée"));
    }
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
  });

  app.setErrorHandler(async (err: Error & { statusCode?: number }, _request, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: "Requête invalide",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send(apiError("bad_request", err.message));
    }
    app.log.error({ err }, "erreur interne");
    return reply.code(500).send(apiError("internal_error", "Erreur interne"));
  });

  // --- Statut public minimal ------------------------------------------------
  app.get("/status", async () => ({ status: "ok", initialized: setup.token === null }));

  // --- Initialisation (une seule fois) --------------------------------------
  app.post("/api/v1/setup", async (request, reply) => {
    if (setup.token === null) {
      return reply.code(404).send(apiError("not_found", "Introuvable"));
    }
    const body = SetupRequestSchema.parse(request.body);
    if (!safeEqualHex(sha256(body.setupToken), sha256(setup.token))) {
      await audit(pool, "anonymous", "setup", null, "failure");
      return reply.code(403).send(apiError("invalid_setup_token", "Secret d'initialisation invalide"));
    }
    const passwordHash = await hashPassword(body.password);
    const restoration = await createRestorationKey();
    try {
      // La clé primaire `singleton` garantit un seul administrateur, même si
      // deux requêtes concurrentes passent la vérification ci-dessus.
      await pool.query(
        "INSERT INTO admin (username, password_hash, restoration_recipient) VALUES ($1, $2, $3)",
        [body.username, passwordHash, restoration.recipient],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        setup.token = null;
        return reply.code(409).send(apiError("already_initialized", "Déjà initialisée"));
      }
      throw err;
    }
    setup.token = null;
    await audit(pool, body.username, "setup", null, "success");
    await ensureBootstrapToken(pool, config.sharedDir);
    await createSession(pool, config, reply);
    // La clé privée de restauration n'est montrée qu'ici, une seule fois.
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send({
      username: body.username,
      restorationKey: restoration.identity,
      restorationRecipient: restoration.recipient,
    });
  });

  // --- Session ----------------------------------------------------------------
  app.post("/api/v1/session", async (request, reply) => {
    const body = LoginRequestSchema.parse(request.body);
    const key = `${body.username.toLowerCase()}|${request.ip}`;
    if (limiter.isBlocked(key)) {
      return reply.code(429).send(apiError("too_many_attempts", "Trop de tentatives, réessayez plus tard"));
    }
    const { rows } = await pool.query<{ username: string; password_hash: string }>(
      "SELECT username, password_hash FROM admin",
    );
    const admin = rows[0];
    const ok = await verifyPassword(body.password, admin?.password_hash ?? DUMMY_HASH);
    if (!admin || admin.username !== body.username || !ok) {
      limiter.recordFailure(key);
      await audit(pool, body.username, "login", null, "failure");
      return reply.code(401).send(apiError("invalid_credentials", "Identifiants invalides"));
    }
    limiter.reset(key);
    await createSession(pool, config, reply);
    await audit(pool, admin.username, "login", null, "success");
    return { username: admin.username };
  });

  app.get("/api/v1/session", async (request, reply) => {
    if (!(await isAuthenticated(pool, request))) {
      return reply.code(401).send(apiError("unauthorized", "Authentification requise"));
    }
    const { rows } = await pool.query<{ username: string }>("SELECT username FROM admin");
    return { username: rows[0]?.username };
  });

  // --- Compte administrateur ----------------------------------------------------
  app.get("/api/v1/admin/restoration-key", { preHandler: auth }, async () => {
    const { rows } = await pool.query<{ restoration_recipient: string | null }>(
      "SELECT restoration_recipient FROM admin",
    );
    return { recipient: rows[0]?.restoration_recipient ?? null };
  });

  app.put("/api/v1/admin/credentials", { preHandler: auth }, async (request, reply) => {
    const body = ChangeCredentialsSchema.parse(request.body);
    const key = `credentials|${request.ip}`;
    if (limiter.isBlocked(key)) {
      return reply.code(429).send(apiError("too_many_attempts", "Trop de tentatives, réessayez plus tard"));
    }
    const { rows } = await pool.query<{ username: string; password_hash: string }>(
      "SELECT username, password_hash FROM admin",
    );
    const admin = rows[0];
    if (!admin || !(await verifyPassword(body.currentPassword, admin.password_hash))) {
      limiter.recordFailure(key);
      await audit(pool, "admin", "credentials.change", null, "failure");
      return reply.code(403).send(apiError("invalid_credentials", "Mot de passe actuel invalide"));
    }
    limiter.reset(key);
    const username = body.newUsername ?? admin.username;
    const passwordHash = body.newPassword ? await hashPassword(body.newPassword) : admin.password_hash;
    await pool.query(
      "UPDATE admin SET username = $1, password_hash = $2, updated_at = now()",
      [username, passwordHash],
    );
    // Toute autre session est révoquée ; seule la session courante est conservée.
    const current = request.cookies[SESSION_COOKIE];
    await pool.query("DELETE FROM sessions WHERE id_hash <> $1", [sha256(current ?? "")]);
    await audit(pool, username, "credentials.change", null, "success");
    return { username };
  });

  app.delete("/api/v1/session", async (request, reply) => {
    await destroySession(pool, request, reply);
    return reply.code(204).send();
  });

  // --- Hôtes et agents ------------------------------------------------------
  interface HostRow {
    id: string;
    name: string;
    agent_version: string | null;
    capabilities: string[];
    last_seen_at: Date | null;
    docker_version: string | null;
    inventory_observed_at: Date | null;
    inventory: unknown[] | null;
  }

  const toSummary = (row: HostRow): HostSummary => {
    const online = gateway.isOnline(row.id);
    return {
      id: row.id,
      name: row.name,
      agentVersion: row.agent_version,
      capabilities: row.capabilities,
      // Hors ligne = dernier état connu, pas « arrêté » (cf. project.md §6).
      presence: online ? "online" : "offline",
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      dockerVersion: row.docker_version,
      inventoryObservedAt: row.inventory_observed_at?.toISOString() ?? null,
      containerCount: row.inventory ? row.inventory.length : null,
    };
  };

  const HOST_COLUMNS = `id, name, agent_version, capabilities, last_seen_at, docker_version,
                        inventory_observed_at, inventory`;

  app.get("/api/v1/hosts", { preHandler: auth }, async () => {
    const { rows } = await pool.query<HostRow>(
      `SELECT ${HOST_COLUMNS} FROM hosts WHERE revoked_at IS NULL ORDER BY created_at`,
    );
    return { offlineAfterSec: OFFLINE_AFTER_SEC, hosts: rows.map(toSummary) };
  });

  const IdParams = z.object({ id: z.uuid() });

  app.get("/api/v1/hosts/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { rows } = await pool.query<HostRow>(
      `SELECT ${HOST_COLUMNS} FROM hosts WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send(apiError("not_found", "Hôte introuvable"));
    return { ...toSummary(row), containers: row.inventory ?? [] };
  });

  app.delete("/api/v1/hosts/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const res = await pool.query(
      "UPDATE hosts SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [id],
    );
    if ((res.rowCount ?? 0) === 0) {
      return reply.code(404).send(apiError("not_found", "Hôte introuvable"));
    }
    gateway.disconnect(id);
    await audit(pool, "admin", "host.revoke", id, "success");
    return reply.code(204).send();
  });

  const EnrollBody = z.object({ hostName: z.string().min(1).max(128).optional() }).default({});

  app.post("/api/v1/agents/enrollment-tokens", { preHandler: auth }, async (request, reply) => {
    const body = EnrollBody.parse(request.body ?? {});
    const token = randomToken(32);
    const { rows } = await pool.query<{ expires_at: Date }>(
      `INSERT INTO enrollment_tokens (token_hash, purpose, host_name, expires_at)
       VALUES ($1, 'manual', $2, now() + interval '1 hour') RETURNING expires_at`,
      [sha256(token), body.hostName ?? null],
    );
    await audit(pool, "admin", "enrollment-token.create", null, "success");
    // Le jeton n'est affiché qu'une seule fois ; seule son empreinte est stockée.
    return reply.code(201).send({ token, expiresAt: rows[0]?.expires_at.toISOString() });
  });

  const ops = new OperationsService(pool, gateway);
  gateway.setHandlers(ops);
  app.addHook("onClose", async () => ops.close());
  registerStackRoutes(app, { pool, auth, ops, isOnline: (id) => gateway.isOnline(id) });

  app.get("/agent/ws", { websocket: true }, (socket) => gateway.handle(socket));

  // --- Frontend statique ------------------------------------------------------
  if (config.webDir && existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir });
    app.setNotFoundHandler(async (request, reply) => {
      const path = request.url.split("?")[0] ?? "";
      if (request.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/agent/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send(apiError("not_found", "Introuvable"));
    });
  }

  return { app, setup, gateway, ops };
}
