import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { LoginLimiter } from "./auth.js";
import { verifyPassword } from "./crypto.js";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { getRevision } from "./stacks.js";
import { buildStackExport } from "./stack-export.js";
import { sessionInfo } from "./user-routes.js";
import type { Config } from "./config.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const ExportBody = z
  .object({
    /** Inclure les valeurs sensibles : administrateurs seulement, avec confirmation du mot de passe. */
    includeSecrets: z.boolean().default(false),
    /** Mot de passe de l'administrateur (confirmation) ; absent pour un compte sans mot de passe (deuxième facteur récent exigé). */
    password: z.string().max(256).optional(),
  })
  .default({ includeSecrets: false });

/**
 * Export d'une stack en ZIP : Compose, `.env` et fichiers associés de la révision ACTIVE (déployée). Les valeurs
 * sensibles ne sont incluses que sur demande d'un administrateur qui confirme son mot de passe.
 */
export function registerExportRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard; limiter: LoginLimiter; config: Config }): void {
  const { pool, auth, limiter, config } = deps;

  app.post("/api/v1/stacks/:id/export", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = ExportBody.parse(request.body ?? {});
    const user = request.user;
    if (!user) throw new HttpError(401, "unauthorized", "Authentification requise");

    const stack = await pool.query<{ name: string; current_revision: number; deployed_revision: number | null; deployed_at: Date | null }>(
      "SELECT name, current_revision, deployed_revision, deployed_at FROM stacks WHERE id = $1",
      [id],
    );
    const row = stack.rows[0];
    if (!row) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    if (row.deployed_revision === null) {
      throw new HttpError(409, "never_deployed", "Cette stack n'a jamais été déployée : il n'y a pas de révision active à exporter.");
    }

    if (body.includeSecrets) {
      if (user.role !== "admin") throw new HttpError(403, "forbidden", "Seul un administrateur peut exporter les valeurs sensibles.");
      const key = `export|${user.id}`;
      if (limiter.isBlocked(key)) throw new HttpError(429, "too_many_attempts", "Trop de tentatives, réessayez plus tard");
      const { rows } = await pool.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
      const hash = rows[0]?.password_hash;
      // Compte sans mot de passe (clé d'accès seule) : un deuxième facteur présenté récemment tient lieu de confirmation.
      const confirmed = hash ? Boolean(body.password) && (await verifyPassword(body.password as string, hash)) : sessionInfo(user, config).mfaRecent;
      if (!confirmed) {
        limiter.recordFailure(key);
        await audit(pool, request.actor, "stack.export", `${row.name} (avec secrets)`, "failure");
        throw hash
          ? new HttpError(403, "invalid_credentials", "Mot de passe incorrect.")
          : new HttpError(403, "step_up_required", "Confirmez d'abord votre identité avec un deuxième facteur.");
      }
      limiter.reset(key);
    }

    const rev = await getRevision(pool, id, row.deployed_revision);
    if (!rev) throw new HttpError(404, "revision_not_found", "La révision active est introuvable.");
    const out = buildStackExport({
      stackName: row.name,
      revision: row.deployed_revision,
      deployedAt: row.deployed_at,
      newerRevision: row.current_revision > row.deployed_revision ? row.current_revision : null,
      exportedBy: request.actor,
      exportedAt: new Date(),
      includeSecrets: body.includeSecrets,
      compose: rev.compose,
      variables: rev.variables,
      files: rev.files,
      sensitiveFiles: [...rev.sensitiveFiles],
    });
    // Jamais de valeur dans l'audit : seulement la stack, la révision et le mode.
    await audit(pool, request.actor, "stack.export", `${row.name} r${row.deployed_revision} (${body.includeSecrets ? "avec secrets" : "sans secrets"})`, "success");
    reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename="${out.filename}"`)
      .header("X-Export-Omitted-Variables", String(out.omitted.variables.length))
      .type("application/zip");
    return reply.send(Buffer.from(out.zip));
  });
}
