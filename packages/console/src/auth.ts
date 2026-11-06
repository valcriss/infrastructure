import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { randomToken, sha256 } from "./crypto.js";
import type { Pool } from "./db.js";

export const SESSION_COOKIE = "sid";
const SESSION_TTL_SEC = 12 * 60 * 60;

export async function createSession(
  pool: Pool,
  config: Config,
  reply: FastifyReply,
): Promise<void> {
  const token = randomToken(32);
  await pool.query(
    "INSERT INTO sessions (id_hash, expires_at) VALUES ($1, now() + make_interval(secs => $2))",
    [sha256(token), SESSION_TTL_SEC],
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.secureCookies,
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
}

export async function destroySession(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) await pool.query("DELETE FROM sessions WHERE id_hash = $1", [sha256(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function isAuthenticated(pool: Pool, request: FastifyRequest): Promise<boolean> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return false;
  const { rowCount } = await pool.query(
    "SELECT 1 FROM sessions WHERE id_hash = $1 AND expires_at > now()",
    [sha256(token)],
  );
  return (rowCount ?? 0) > 0;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Identité de l'appelant pour l'audit : « admin » ou « token:<nom> ». */
    actor: string;
  }
}

const unauthorized = (reply: FastifyReply) =>
  reply.code(401).send({ error: { code: "unauthorized", message: "Authentification requise" } });

/** Routes réservées à la session de l'administrateur (jamais accessibles par jeton API). */
export function requireAuth(pool: Pool) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!(await isAuthenticated(pool, request))) {
      await unauthorized(reply);
      return;
    }
    const { rows } = await pool.query<{ username: string }>("SELECT username FROM admin");
    request.actor = rows[0]?.username ?? "admin";
  };
}

export const API_TOKEN_PREFIX = "cdt_";
const LAST_USED_THROTTLE_SEC = 60;

/**
 * Routes d'automatisation : jeton API (`Authorization: Bearer cdt_…`) ou
 * session. Un jeton `read` ne peut effectuer que des requêtes GET/HEAD. Les
 * échecs répétés par adresse sont limités.
 */
export function requireSessionOrToken(pool: Pool, limiter: LoginLimiter) {
  const session = requireAuth(pool);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization;
    if (header === undefined) return session(request, reply);

    const key = `token|${request.ip}`;
    if (limiter.isBlocked(key)) {
      await reply.code(429).send({ error: { code: "too_many_attempts", message: "Trop de tentatives, réessayez plus tard" } });
      return;
    }
    const match = /^Bearer (\S+)$/i.exec(header);
    const row = match
      ? (
          await pool.query<{ id: string; name: string; scope: "read" | "write"; last_used_at: Date | null }>(
            `SELECT id, name, scope, last_used_at FROM api_tokens
             WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
            [sha256(match[1] ?? "")],
          )
        ).rows[0]
      : undefined;
    if (!row) {
      limiter.recordFailure(key);
      await unauthorized(reply);
      return;
    }
    if (row.scope === "read" && !["GET", "HEAD"].includes(request.method)) {
      await reply.code(403).send({ error: { code: "insufficient_scope", message: "Ce jeton est en lecture seule" } });
      return;
    }
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > LAST_USED_THROTTLE_SEC * 1000) {
      await pool.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [row.id]);
    }
    request.actor = `token:${row.name}`;
  };
}

/**
 * Limiteur d'échecs de connexion en mémoire (5 échecs / 15 minutes par
 * couple identifiant + adresse). Suffisant pour un seul processus console.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; since: number }>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (this.now() - entry.since > this.windowMs) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.max;
  }

  recordFailure(key: string): void {
    const entry = this.failures.get(key);
    if (!entry || this.now() - entry.since > this.windowMs) {
      this.failures.set(key, { count: 1, since: this.now() });
    } else {
      entry.count += 1;
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
