import {
  ComposeEditError,
  applyExtraction,
  detectEnvLiterals,
  proposeGroups,
  resolvedEnvironment,
  validateVariableName,
  type Replacement,
} from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { changeStack, getRevision } from "./stacks.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type VariableMap = Record<string, { value: string; sensitive: boolean }>;

const Group = z.object({
  /** Nom de la variable de stack qui remplace la valeur. */
  name: z.string().min(1).max(128),
  /** Variable chiffrée (valeur masquée, chiffrée dans la sauvegarde Git). */
  encrypted: z.boolean(),
  uses: z.array(z.object({ service: z.string().min(1).max(128), key: z.string().min(1).max(256) })).min(1).max(100),
});
export const ExtractBody = z.object({
  expectedRevision: z.number().int().positive(),
  groups: z.array(Group).min(1).max(300),
  message: z.string().max(200).optional(),
});
type Body = z.infer<typeof ExtractBody>;

const IdParams = z.object({ id: z.uuid() });

interface Plan {
  compose: string;
  variables: VariableMap;
  created: { name: string; sensitive: boolean; reused: boolean; uses: number }[];
}

/**
 * Transforme les valeurs choisies en variables de stack. Tout est recalculé ici à partir du Compose enregistré (le
 * navigateur n'envoie que des noms et des emplacements, jamais de valeurs) et vérifié : mêmes valeurs pour tous les
 * usages d'une variable, noms uniques, pas de collision avec une variable existante de valeur différente, et
 * environnement résolu strictement identique avant et après.
 */
export function planExtraction(compose: string, existing: VariableMap, body: Body): Plan {
  const names = new Set<string>();
  for (const g of body.groups) {
    const problem = validateVariableName(g.name);
    if (problem) throw new HttpError(400, "invalid_variable_name", `${g.name} : ${problem}`);
    if (names.has(g.name)) throw new HttpError(400, "duplicate_name", `Le nom « ${g.name} » est utilisé par plusieurs groupes : un nom ne peut désigner qu'une valeur.`);
    names.add(g.name);
  }
  let literals;
  try {
    literals = detectEnvLiterals(compose).uses;
  } catch (err) {
    if (err instanceof ComposeEditError) throw new HttpError(422, "unsupported_compose_structure", err.message);
    throw err;
  }
  const at = new Map(literals.map((u) => [`${u.service}\u0000${u.key}`, u]));
  const replacements: Replacement[] = [];
  const variables: VariableMap = { ...existing };
  const created: Plan["created"] = [];
  const claimed = new Set<string>();

  for (const g of body.groups) {
    let value: string | undefined;
    for (const use of g.uses) {
      const k = `${use.service}\u0000${use.key}`;
      const found = at.get(k);
      if (!found) throw new HttpError(409, "value_changed", `${use.service} / ${use.key} n'est plus une valeur littérale du Compose : rechargez la proposition.`);
      if (claimed.has(k)) throw new HttpError(400, "duplicate_use", `${use.service} / ${use.key} apparaît dans plusieurs groupes.`);
      claimed.add(k);
      if (value !== undefined && value !== found.value) {
        throw new HttpError(400, "value_mismatch", `La variable ${g.name} regrouperait des valeurs différentes (${use.service} / ${use.key}) : séparez-les.`);
      }
      value = found.value;
      replacements.push({ service: use.service, key: use.key, name: g.name });
    }
    const current = existing[g.name];
    const reused = current !== undefined && current.value === value && current.sensitive === g.encrypted;
    if (current && !reused) {
      throw new HttpError(409, "name_taken", `Une variable « ${g.name} » existe déjà avec une autre valeur ou un autre réglage de chiffrement : choisissez un autre nom.`);
    }
    if (!reused) variables[g.name] = { value: value as string, sensitive: g.encrypted };
    created.push({ name: g.name, sensitive: g.encrypted, reused, uses: g.uses.length });
  }

  let next: string;
  try {
    next = applyExtraction(compose, replacements);
  } catch (err) {
    if (err instanceof ComposeEditError) throw new HttpError(422, "unsupported_compose_structure", err.message);
    throw err;
  }
  // Garde-fou : le Compose résolu doit donner exactement la même configuration qu'avant.
  const plain = (m: VariableMap): Record<string, string> => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.value]));
  if (JSON.stringify(resolvedEnvironment(next, plain(variables))) !== JSON.stringify(resolvedEnvironment(compose, plain(existing)))) {
    throw new HttpError(422, "extraction_not_equivalent", "L'extraction changerait la configuration résolue : annulée, rien n'a été modifié.");
  }
  return { compose: next, variables, created };
}

export function registerVariableExtractRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard }): void {
  const { pool, auth } = deps;

  const current = async (id: string) => {
    const stack = await pool.query<{ current_revision: number }>("SELECT current_revision FROM stacks WHERE id = $1", [id]);
    if (!stack.rows[0]) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    const rev = await getRevision(pool, id, stack.rows[0].current_revision);
    if (!rev) throw new Error("révision courante introuvable");
    return { number: stack.rows[0].current_revision, rev };
  };

  // Proposition : valeurs littérales de `environment`, regroupées et nommées, avec ce qui est ignoré et pourquoi.
  app.get("/api/v1/stacks/:id/variables/extraction", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { number, rev } = await current(id);
    let detected;
    try {
      detected = detectEnvLiterals(rev.compose);
    } catch (err) {
      if (err instanceof ComposeEditError) throw new HttpError(422, "unsupported_compose_structure", err.message);
      throw err;
    }
    const groups = proposeGroups(detected.uses, rev.variables);
    return {
      revision: number,
      groups: groups.map((g) => ({ ...g, id: g.id.replace("\u0000", "/") })),
      skipped: detected.skipped,
      existing: Object.keys(rev.variables).sort(),
    };
  });

  app.post("/api/v1/stacks/:id/variables/extraction/preview", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = ExtractBody.parse(request.body);
    const { number, rev } = await current(id);
    if (number !== body.expectedRevision) throw new HttpError(409, "revision_conflict", "La stack a une révision plus récente : rechargez la page.");
    const plan = planExtraction(rev.compose, rev.variables, body);
    return { before: rev.compose, after: plan.compose, variables: plan.created };
  });

  app.post("/api/v1/stacks/:id/variables/extraction", { preHandler: auth }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = ExtractBody.parse(request.body);
    let summary: Plan["created"] = [];
    const result = await changeStack(pool, id, body.expectedRevision, request.actor, body.message ?? `Variables extraites du Compose (${body.groups.length})`, (c) => {
      const plan = planExtraction(c.compose, c.variables as VariableMap, body);
      summary = plan.created;
      return { ...c, compose: plan.compose, variables: plan.variables };
    });
    // Les valeurs ne sont jamais écrites dans l'audit : seulement les noms et le nombre d'usages.
    await audit(pool, request.actor, "variables.extract", summary.map((s) => s.name).join(",").slice(0, 400), "success");
    return result;
  });
}
