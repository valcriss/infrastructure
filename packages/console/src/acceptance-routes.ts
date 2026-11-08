import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { repoKey } from "./vuln-summary.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const DAYS = [7, 30, 90, 180, 365] as const;

export const AcceptBody = z.object({
  cve: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,60}$/, "Identifiant de vulnérabilité invalide"),
  /** Une référence de l'image concernée : la portée devient son dépôt. Absente : toutes les images. */
  imageRef: z.string().max(300).optional(),
  justification: z.string().trim().min(10, "Expliquez pourquoi ce risque est accepté (10 caractères minimum)").max(500),
  days: z.number().int().refine((d) => (DAYS as readonly number[]).includes(d), "Durée : 7, 30, 90, 180 ou 365 jours"),
});

interface Row {
  id: string;
  cve: string;
  repository: string | null;
  justification: string;
  expires_at: Date;
  created_by: string;
  created_at: Date;
}

/** Risques acceptés : une vulnérabilité qu'on ne compte plus jusqu'à une date limite, avec sa justification. */
export function registerAcceptanceRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard }): void {
  const { pool, auth } = deps;

  app.get("/api/v1/vulnerability-acceptances", { preHandler: auth }, async () => {
    const { rows } = await pool.query<Row>(
      `SELECT id, cve, repository, justification, expires_at, created_by, created_at
         FROM vulnerability_acceptances WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 500`,
    );
    return {
      acceptances: rows.map((r) => ({
        id: r.id,
        cve: r.cve,
        repository: r.repository,
        justification: r.justification,
        expiresAt: r.expires_at.toISOString(),
        expired: r.expires_at.getTime() <= Date.now(),
        createdBy: r.created_by,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  app.post("/api/v1/vulnerability-acceptances", { preHandler: auth }, async (request, reply) => {
    const body = AcceptBody.parse(request.body);
    const repository = body.imageRef ? repoKey(body.imageRef) : null;
    const cve = body.cve.toUpperCase();
    const dup = await pool.query(
      "SELECT 1 FROM vulnerability_acceptances WHERE cve = $1 AND repository IS NOT DISTINCT FROM $2 AND revoked_at IS NULL AND expires_at > now()",
      [cve, repository],
    );
    if ((dup.rowCount ?? 0) > 0) throw new HttpError(409, "already_accepted", "Ce risque est déjà accepté pour cette portée.");
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO vulnerability_acceptances (cve, repository, justification, expires_at, created_by)
       VALUES ($1, $2, $3, now() + make_interval(days => $4), $5) RETURNING id`,
      [cve, repository, body.justification, body.days, request.actor],
    );
    await audit(pool, request.actor, "vulnerability.accept", `${cve} (${repository ?? "toutes les images"})`, "success");
    return reply.code(201).send({ id: rows[0]?.id });
  });

  app.delete("/api/v1/vulnerability-acceptances/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const res = await pool.query("UPDATE vulnerability_acceptances SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL", [id, request.actor]);
    if ((res.rowCount ?? 0) === 0) throw new HttpError(404, "acceptance_not_found", "Risque accepté introuvable");
    await audit(pool, request.actor, "vulnerability.unaccept", id, "success");
    return reply.code(204).send();
  });
}
