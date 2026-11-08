import {
  ComposeEditError,
  cleanCompose,
  compareWithObserved,
  detectEnvLiterals,
  detectVariableReferences,
  looksSecret,
  validateCompose,
  type Container,
} from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const AnalyzeBody = z.object({
  compose: z.string().max(1_000_000),
  /** Valeurs déjà saisies, pour résoudre les ports déclarés avec une variable. */
  variables: z.record(z.string(), z.string().max(4096)).default({}),
  /** Projet observé à comparer (import) : hôte + nom du projet Compose. */
  hostId: z.uuid().optional(),
  project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/).optional(),
});

export const CleanBody = z.object({ compose: z.string().max(1_000_000) });

/**
 * Analyse un Compose avant son enregistrement : erreurs avec leur ligne, variables à renseigner (obligatoires ou avec
 * valeur par défaut, secrets probables), valeurs écrites en clair, et — pour un import — écarts avec les conteneurs
 * observés. Ne modifie rien et ne renvoie jamais les variables d'environnement des conteneurs.
 */
export function registerComposeAnalyzeRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard }): void {
  const { pool, auth } = deps;

  // « Nettoyer le contenu » : calcule le Compose sans commentaires ni `version`, aéré. Ne modifie rien : l'interface
  // affiche un aperçu puis applique le résultat au brouillon.
  app.post("/api/v1/compose/clean", { preHandler: auth }, async (request) => {
    const body = CleanBody.parse(request.body);
    try {
      return cleanCompose(body.compose);
    } catch (err) {
      if (err instanceof ComposeEditError) throw new HttpError(422, "unsupported_compose_structure", err.message);
      throw err;
    }
  });

  app.post("/api/v1/compose/analyze", { preHandler: auth }, async (request) => {
    const body = AnalyzeBody.parse(request.body);
    const validation = validateCompose(body.compose);
    if (!validation.ok) return { valid: false, issues: validation.issues, services: [], variables: [], literals: [], differences: null };

    let literals: { service: string; key: string; secret: boolean }[] = [];
    try {
      literals = detectEnvLiterals(body.compose).uses.map((u) => ({ service: u.service, key: u.key, secret: looksSecret(u.key, u.value) }));
    } catch (err) {
      if (!(err instanceof ComposeEditError)) throw err;
    }

    let differences = null;
    if (body.hostId && body.project) {
      const host = await pool.query<{ inventory: Container[] | null }>("SELECT inventory FROM hosts WHERE id = $1 AND revoked_at IS NULL", [body.hostId]);
      if (!host.rows[0]) throw new HttpError(404, "host_not_found", "Hôte introuvable");
      const containers = (host.rows[0].inventory ?? []).filter((c) => c.composeProject === body.project);
      differences = compareWithObserved(
        body.compose,
        containers.map((c) => ({ service: c.composeService ?? c.names[0] ?? c.id, ports: c.ports, mounts: c.mounts })),
        body.variables,
      );
    }
    return {
      valid: true,
      issues: [],
      services: validation.services,
      variables: detectVariableReferences(body.compose),
      literals,
      differences,
    };
  });
}
