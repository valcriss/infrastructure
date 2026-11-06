import {
  MAX_FILES_TOTAL_BYTES,
  MAX_FILE_COUNT,
  MAX_VARIABLES,
  validateCompose,
  validateFilePath,
  validateStackName,
  validateVariableName,
  validateVariableValue,
  type Container,
} from "@infra/shared";
import { createHash } from "node:crypto";
import type pg from "pg";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";

export interface VariableValue {
  value: string;
  sensitive: boolean;
}
export type VariableMap = Record<string, VariableValue>;

export interface RevisionContent {
  compose: string;
  variables: VariableMap;
  files: Record<string, string>;
}

export interface RevisionRow extends RevisionContent {
  revision: number;
  digest: string;
  author: string;
  message: string | null;
  createdAt: Date;
}

/** Entrée d'une modification de variable : valeur simple ou objet détaillé. */
export type VariableInput = string | { value?: string; sensitive?: boolean };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function digestOf(content: RevisionContent): string {
  return createHash("sha256").update(JSON.stringify(stable(content))).digest("hex");
}

/** Valide un contenu de révision complet ; lève une HttpError 400 sinon. */
export function assertValidContent(content: RevisionContent): void {
  const compose = validateCompose(content.compose);
  if (!compose.ok) {
    throw new HttpError(400, "invalid_compose", "Fichier Compose invalide", compose.issues);
  }
  const names = Object.keys(content.variables);
  if (names.length > MAX_VARIABLES) {
    throw new HttpError(400, "too_many_variables", `Au maximum ${MAX_VARIABLES} variables`);
  }
  for (const name of names) {
    const err = validateVariableName(name) ?? validateVariableValue(content.variables[name]?.value ?? "");
    if (err) throw new HttpError(400, "invalid_variable", `${name} : ${err}`);
  }
  const paths = Object.keys(content.files);
  if (paths.length > MAX_FILE_COUNT) {
    throw new HttpError(400, "too_many_files", `Au maximum ${MAX_FILE_COUNT} fichiers`);
  }
  let total = 0;
  for (const path of paths) {
    const err = validateFilePath(path);
    if (err) throw new HttpError(400, "invalid_file_path", `${path} : ${err}`);
    total += Buffer.byteLength(content.files[path] ?? "", "utf8");
  }
  if (total > MAX_FILES_TOTAL_BYTES) {
    throw new HttpError(400, "files_too_large", "Les fichiers associés sont trop volumineux");
  }
}

/** Applique des modifications de variables sans toucher aux autres. */
export function applyVariableChanges(
  current: VariableMap,
  set: Record<string, VariableInput> | undefined,
  unset: string[] | undefined,
): VariableMap {
  const next: VariableMap = { ...current };
  for (const [name, input] of Object.entries(set ?? {})) {
    const existing = next[name];
    if (typeof input === "string") {
      // Une valeur simple conserve le caractère sensible existant.
      next[name] = { value: input, sensitive: existing?.sensitive ?? false };
    } else {
      const value = input.value ?? existing?.value;
      if (value === undefined) {
        throw new HttpError(400, "invalid_variable", `${name} : valeur requise pour une nouvelle variable`);
      }
      next[name] = { value, sensitive: input.sensitive ?? existing?.sensitive ?? false };
    }
  }
  for (const name of unset ?? []) delete next[name];
  return next;
}

async function withTx<T>(pool: Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface RevisionDbRow {
  revision: number;
  compose: string;
  variables: VariableMap;
  files: Record<string, string>;
  digest: string;
  author: string;
  message: string | null;
  created_at: Date;
}

const toRevision = (r: RevisionDbRow): RevisionRow => ({
  revision: r.revision,
  compose: r.compose,
  variables: r.variables,
  files: r.files,
  digest: r.digest,
  author: r.author,
  message: r.message,
  createdAt: r.created_at,
});

export async function getRevision(
  db: Pick<pg.Pool, "query">,
  stackId: string,
  revision: number,
): Promise<RevisionRow | null> {
  const { rows } = await db.query<RevisionDbRow>(
    `SELECT revision, compose, variables, files, digest, author, message, created_at
     FROM stack_revisions WHERE stack_id = $1 AND revision = $2`,
    [stackId, revision],
  );
  return rows[0] ? toRevision(rows[0]) : null;
}

export interface CreateStackInput {
  name: string;
  hostId: string;
  description: string;
  compose: string;
  variables: Record<string, VariableInput>;
  /** Reprend un projet Compose existant non géré (import d'une stack observée). */
  adopt?: boolean;
  author: string;
}

export async function createStack(pool: Pool, input: CreateStackInput): Promise<{ id: string }> {
  const nameError = validateStackName(input.name);
  if (nameError) throw new HttpError(400, "invalid_name", nameError);

  const content: RevisionContent = {
    compose: input.compose,
    variables: applyVariableChanges({}, input.variables, undefined),
    files: {},
  };
  assertValidContent(content);

  return withTx(pool, async (c) => {
    const host = await c.query<{ inventory: Container[] | null }>(
      "SELECT inventory FROM hosts WHERE id = $1 AND revoked_at IS NULL",
      [input.hostId],
    );
    if (!host.rows[0]) throw new HttpError(404, "host_not_found", "Hôte introuvable");

    // Évite de prendre le contrôle d'un projet Compose existant non géré, sauf
    // import explicite (adopt) d'un projet qui existe réellement sur l'hôte.
    const exists = (host.rows[0].inventory ?? []).some((ct) => ct.composeProject === input.name);
    if (input.adopt && !exists) {
      throw new HttpError(400, "project_not_observed", `Aucun projet Compose « ${input.name} » n'a été observé sur cet hôte.`);
    }
    if (exists && !input.adopt) {
      throw new HttpError(
        409,
        "project_exists_on_host",
        `Un projet Compose « ${input.name} » existe déjà sur cet hôte et n'est pas géré : choisissez un autre nom.`,
      );
    }

    let id: string;
    try {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO stacks (name, host_id, description, current_revision, adopt_pending)
         VALUES ($1, $2, $3, 1, $4) RETURNING id`,
        [input.name, input.hostId, input.description, input.adopt === true],
      );
      id = ins.rows[0]?.id ?? "";
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        throw new HttpError(409, "name_taken", "Une stack porte déjà ce nom");
      }
      throw err;
    }
    await c.query(
      `INSERT INTO stack_revisions (stack_id, revision, compose, variables, files, digest, author, message)
       VALUES ($1, 1, $2, $3, $4, $5, $6, 'Création')`,
      [id, content.compose, JSON.stringify(content.variables), JSON.stringify(content.files), digestOf(content), input.author],
    );
    await audit(c, input.author, "stack.create", id, "success");
    return { id };
  });
}

export interface ChangeResult {
  revision: number;
  /** Faux si le contenu était identique : aucune révision n'a été créée. */
  changed: boolean;
}

/**
 * Crée une nouvelle révision à partir de la révision courante, avec contrôle
 * de concurrence optimiste : `expectedRevision` doit être la révision courante.
 */
export async function changeStack(
  pool: Pool,
  stackId: string,
  expectedRevision: number,
  author: string,
  message: string,
  mutate: (current: RevisionContent) => RevisionContent,
): Promise<ChangeResult> {
  return withTx(pool, async (c) => {
    const stack = await c.query<{ current_revision: number }>(
      "SELECT current_revision FROM stacks WHERE id = $1 FOR UPDATE",
      [stackId],
    );
    const row = stack.rows[0];
    if (!row) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    if (row.current_revision !== expectedRevision) {
      throw new HttpError(409, "revision_conflict", "La stack a été modifiée entre-temps", {
        currentRevision: row.current_revision,
      });
    }
    const current = await getRevision(c, stackId, row.current_revision);
    if (!current) throw new Error("révision courante introuvable");

    const next = mutate({ compose: current.compose, variables: current.variables, files: current.files });
    assertValidContent(next);
    const digest = digestOf(next);
    if (digest === current.digest) return { revision: current.revision, changed: false };

    const revision = current.revision + 1;
    await c.query(
      `INSERT INTO stack_revisions (stack_id, revision, compose, variables, files, digest, author, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [stackId, revision, next.compose, JSON.stringify(next.variables), JSON.stringify(next.files), digest, author, message],
    );
    await c.query("UPDATE stacks SET current_revision = $2, updated_at = now() WHERE id = $1", [stackId, revision]);
    await audit(c, author, "stack.revision", `${stackId}@${revision}`, "success");
    return { revision, changed: true };
  });
}

/** Représentation API d'une variable : la valeur sensible n'est jamais renvoyée. */
export function maskVariables(variables: VariableMap): { name: string; value: string | null; sensitive: boolean }[] {
  return Object.entries(variables)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, v]) => ({ name, value: v.sensitive ? null : v.value, sensitive: v.sensitive }));
}
