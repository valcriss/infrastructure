import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { API_TOKEN_PREFIX } from "./auth.js";
import { randomToken, sha256 } from "./crypto.js";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";

const MAX_ACTIVE_TOKENS = 50;

export const CreateTokenBody = z.object({
  name: z.string().trim().min(1).max(64),
  scope: z.enum(["read", "write"]).default("write"),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

/**
 * Gestion des jetons API. Réservée à la session de l'administrateur : un jeton
 * ne peut ni en créer d'autres ni en révoquer, pour qu'un jeton compromis ne
 * puisse pas se perpétuer.
 */
export function registerTokenRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void> },
): void {
  const { pool, auth } = deps;

  app.post("/api/v1/api-tokens", { preHandler: auth }, async (request, reply) => {
    const body = CreateTokenBody.parse(request.body);
    const active = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM api_tokens WHERE revoked_at IS NULL",
    );
    if ((active.rows[0]?.n ?? 0) >= MAX_ACTIVE_TOKENS) {
      throw new HttpError(409, "too_many_tokens", `Au maximum ${MAX_ACTIVE_TOKENS} jetons actifs`);
    }
    const token = API_TOKEN_PREFIX + randomToken(32);
    const { rows } = await pool.query<{ id: string; expires_at: Date | null }>(
      `INSERT INTO api_tokens (name, scope, token_hash, prefix, expires_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5::int) END)
       RETURNING id, expires_at`,
      [body.name, body.scope, sha256(token), token.slice(0, 12), body.expiresInDays ?? null],
    );
    const row = rows[0];
    await audit(pool, request.actor, "api-token.create", row?.id ?? null, "success");
    // Le jeton n'est affiché qu'ici, une seule fois.
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send({
      id: row?.id,
      name: body.name,
      scope: body.scope,
      token,
      expiresAt: row?.expires_at?.toISOString() ?? null,
    });
  });

  app.get("/api/v1/api-tokens", { preHandler: auth }, async () => {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      scope: string;
      prefix: string;
      created_at: Date;
      expires_at: Date | null;
      last_used_at: Date | null;
      revoked_at: Date | null;
    }>("SELECT id, name, scope, prefix, created_at, expires_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at DESC");
    return {
      tokens: rows.map((r) => ({
        id: r.id,
        name: r.name,
        scope: r.scope,
        prefix: r.prefix,
        createdAt: r.created_at.toISOString(),
        expiresAt: r.expires_at?.toISOString() ?? null,
        lastUsedAt: r.last_used_at?.toISOString() ?? null,
        revokedAt: r.revoked_at?.toISOString() ?? null,
      })),
    };
  });

  app.delete("/api/v1/api-tokens/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const res = await pool.query(
      "UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [id],
    );
    if ((res.rowCount ?? 0) === 0) throw new HttpError(404, "token_not_found", "Jeton introuvable ou déjà révoqué");
    await audit(pool, request.actor, "api-token.revoke", id, "success");
    return reply.code(204).send();
  });
}
