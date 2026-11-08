import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { randomToken, sha256 } from "./crypto.js";
import type { Pool } from "./db.js";
import { hasRole, requiredRole, type Role } from "./permissions.js";

export const SESSION_COOKIE = "sid";
const SESSION_TTL_SEC = 12 * 60 * 60;

export interface AuthUser {
  id: string;
  email: string;
  /** Ancien identifiant (compte d'origine) ; sert d'acteur d'audit quand il existe. */
  username: string | null;
  displayName: string;
  role: Role;
  terminalAllowed: boolean;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  /** Mot de passe défini ? (un compte à clés d'accès seules n'en a pas) */
  hasPassword: boolean;
  /** Dernier deuxième facteur présenté dans cette session (code, clé d'accès). */
  mfaAt: Date | null;
  authMethod: string;
}

/** Nom affiché dans l'audit : identifiant historique s'il existe, sinon l'e-mail. */
export const actorOf = (u: Pick<AuthUser, "email" | "username">): string => u.username ?? u.email;

export interface SessionOptions {
  userId: string;
  /** `password`, `passkey`… */
  method: string;
  /** Un deuxième facteur a-t-il été présenté à la connexion ? */
  mfa: boolean;
}

export async function createSession(pool: Pool, config: Config, reply: FastifyReply, opts: SessionOptions): Promise<void> {
  const token = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (id_hash, expires_at, user_id, auth_method, mfa_at)
     VALUES ($1, now() + make_interval(secs => $2), $3, $4, CASE WHEN $5::boolean THEN now() END)`,
    [sha256(token), SESSION_TTL_SEC, opts.userId, opts.method, opts.mfa],
  );
  await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [opts.userId]);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.secureCookies,
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
}

export async function destroySession(pool: Pool, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) await pool.query("DELETE FROM sessions WHERE id_hash = $1", [sha256(token)]);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

interface UserRow {
  id: string;
  email: string;
  username: string | null;
  display_name: string;
  role: Role;
  terminal_allowed: boolean;
  must_change_password: boolean;
  totp_enabled: boolean;
  password_hash: string | null;
  mfa_at: Date | null;
  auth_method: string;
}

/** Utilisateur actif de la session courante, ou null (cookie absent, expiré, compte désactivé). */
export async function sessionUser(pool: Pool, request: FastifyRequest): Promise<AuthUser | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const { rows } = await pool.query<UserRow>(
    `SELECT u.id, u.email, u.username, u.display_name, u.role, u.terminal_allowed, u.must_change_password,
            u.totp_enabled, u.password_hash, s.mfa_at, s.auth_method
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    terminalAllowed: r.terminal_allowed,
    mustChangePassword: r.must_change_password,
    totpEnabled: r.totp_enabled,
    hasPassword: r.password_hash !== null,
    mfaAt: r.mfa_at,
    authMethod: r.auth_method,
  };
}

export async function isAuthenticated(pool: Pool, request: FastifyRequest): Promise<boolean> {
  return (await sessionUser(pool, request)) !== null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Identité de l'appelant pour l'audit : identifiant ou e-mail, ou « token:<nom> ». */
    actor: string;
    /** Utilisateur de la session ; absent pour un jeton API. */
    user?: AuthUser;
  }
}

const reject = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });
const unauthorized = (reply: FastifyReply) => reject(reply, 401, "unauthorized", "Authentification requise");

// Un compte au mot de passe provisoire ne peut rien faire d'autre que le changer ou se déconnecter.
const PASSWORD_CHANGE_ALLOWED = /^\/api\/v1\/(admin\/credentials|session|me\/profile)$/;

/** Routes de session (utilisateur connecté) : applique le rôle minimal de la route. */
export function requireAuth(pool: Pool) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = await sessionUser(pool, request);
    if (!user) {
      await unauthorized(reply);
      return;
    }
    const url = request.routeOptions.url ?? request.url;
    if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.test(url)) {
      await reject(reply, 403, "password_change_required", "Vous devez d'abord changer votre mot de passe provisoire");
      return;
    }
    const need = requiredRole(request.method, url);
    if (!hasRole(user.role, need)) {
      await reject(reply, 403, "forbidden", "Droits insuffisants pour cette action");
      return;
    }
    request.user = user;
    request.actor = actorOf(user);
  };
}

export const API_TOKEN_PREFIX = "cdt_";
const LAST_USED_THROTTLE_SEC = 60;

/**
 * Routes d'automatisation : jeton API (`Authorization: Bearer cdt_…`) ou
 * session. Un jeton `read` ne peut effectuer que des requêtes GET/HEAD et vaut
 * « lecteur » ; un jeton `write` vaut « opérateur » : jamais d'action d'administration.
 * Les échecs répétés par adresse sont limités.
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
    const need = requiredRole(request.method, request.routeOptions.url ?? request.url);
    if (!hasRole(row.scope === "write" ? "operator" : "viewer", need)) {
      await reject(reply, 403, "insufficient_scope", "Ce jeton ne permet pas cette action");
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
