import {
  ComposeEditError,
  cleanCompose,
  compareWithObserved,
  detectEnvLiterals,
  proposeGroups,
  detectVariableReferences,
  looksSecret,
  parseDotenv,
  validateCompose,
  type Container,
} from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { Group as ExtractGroup, planCreationExtraction } from "./variable-extract-routes.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const AnalyzeBody = z.object({
  compose: z.string().max(1_000_000),
  /** Valeurs déjà saisies, pour résoudre les ports déclarés avec une variable. */
  variables: z.record(z.string(), z.string().max(4096)).default({}),
  /** Contenu d'un fichier .env : sert à préremplir les variables du Compose (jamais enregistré par cette route). */
  env: z.string().max(200_000).optional(),
  /** Valeurs en clair à passer en variables : renvoie le Compose qui en résulterait (rien n'est enregistré). */
  extract: z.array(ExtractGroup).max(300).optional(),
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
    const parsed = body.env !== undefined ? parseDotenv(body.env) : null;
    const validation = validateCompose(body.compose);
    const envOut = (refs: Set<string>) =>
      parsed
        ? {
            values: parsed.values,
            issues: parsed.issues,
            interpolated: parsed.interpolated,
            // Variables du .env que le Compose ne référence pas (env_file, fichiers de configuration…).
            unused: Object.entries(parsed.values)
              .filter(([name]) => !refs.has(name))
              .map(([name, value]) => ({ name, secret: looksSecret(name, value) })),
          }
        : null;
    if (!validation.ok) return { valid: false, issues: validation.issues, services: [], variables: [], literals: [], groups: [], extracted: null, differences: null, env: envOut(new Set()) };

    let literals: { service: string; key: string; secret: boolean }[] = [];
    // Valeurs écrites en clair dans « environment », regroupées avec un nom de variable proposé : candidates à l'extraction.
    let groups: ReturnType<typeof proposeGroups> = [];
    try {
      const found = detectEnvLiterals(body.compose);
      literals = found.uses.map((u) => ({ service: u.service, key: u.key, secret: looksSecret(u.key, u.value) }));
      const existing = Object.fromEntries(Object.entries({ ...(parsed?.values ?? {}), ...body.variables }).map(([k, value]) => [k, { value, sensitive: false }]));
      groups = proposeGroups(found.uses, existing).map((g) => ({ ...g, id: g.id.replace("\u0000", "/") }));
    } catch (err) {
      if (!(err instanceof ComposeEditError)) throw err;
    }
    let extracted: { compose: string; created: { name: string; sensitive: boolean; reused: boolean; uses: number }[] } | { error: string } | null = null;
    if (body.extract && body.extract.length > 0) {
      try {
        const vars = Object.fromEntries(Object.entries({ ...(parsed?.values ?? {}), ...body.variables }).map(([k, value]) => [k, { value, sensitive: false }]));
        const plan = planCreationExtraction(body.compose, vars, body.extract);
        extracted = { compose: plan.compose, created: plan.created };
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        extracted = { error: err.message };
      }
    }

    const references = detectVariableReferences(body.compose);
    const known = { ...(parsed?.values ?? {}), ...body.variables };
    let differences = null;
    if (body.hostId && body.project) {
      const host = await pool.query<{ inventory: Container[] | null }>("SELECT inventory FROM hosts WHERE id = $1 AND revoked_at IS NULL", [body.hostId]);
      if (!host.rows[0]) throw new HttpError(404, "host_not_found", "Hôte introuvable");
      const containers = (host.rows[0].inventory ?? []).filter((c) => c.composeProject === body.project);
      differences = compareWithObserved(
        body.compose,
        containers.map((c) => ({ service: c.composeService ?? c.names[0] ?? c.id, ports: c.ports, mounts: c.mounts })),
        known,
      );
    }
    return {
      valid: true,
      issues: [],
      services: validation.services,
      // Une valeur fournie par le .env peut elle aussi révéler un secret (longue chaîne générée…).
      variables: references.map((r) => ({ ...r, secret: r.secret || (parsed?.values[r.name] !== undefined && looksSecret(r.name, parsed.values[r.name] as string)) })),
      literals,
      groups,
      extracted,
      differences,
      env: envOut(new Set(references.map((r) => r.name))),
    };
  });
}
