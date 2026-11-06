import {
  MAX_FILES_TOTAL_BYTES,
  MAX_FILE_COUNT,
  MAX_VARIABLES,
  validateCompose,
  validateFilePath,
  validateStackName,
  validateVariableName,
  validateVariableValue,
} from "@infra/shared";
import { Decrypter, Encrypter, armor } from "age-encryption";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { POLICIES, validatePattern, type UpdatePolicy } from "./image-tags.js";
import type { RevisionContent, VariableMap } from "./stacks.js";

/** Règle de suivi des versions d'un composant, sauvegardée avec la stack. */
export interface PolicySpec {
  policy: UpdatePolicy;
  pattern: string | null;
}

/**
 * Format de sauvegarde Git, version 1 (cf. project.md §12).
 *
 *   manifest.yaml                      version du format, installation, révision de configuration
 *   settings/config.yaml               paramètres généraux non sensibles
 *   environments/default.yaml          environnement et hôtes logiques
 *   stacks/<id>/stack.yaml             métadonnées
 *   stacks/<id>/compose.yaml           Compose (absent s'il est chiffré)
 *   stacks/<id>/variables.yaml         variables non sensibles
 *   stacks/<id>/files/<chemin>         fichiers associés non sensibles
 *   secrets/<id>/variables.age         variables sensibles (age)
 *   secrets/<id>/compose.yaml.age      Compose chiffré (age)
 *   secrets/<id>/files/<chemin>.age    fichiers sensibles (age)
 *
 * Les identifiants des chemins sont les identifiants stables des stacks.
 */
export const FORMAT_VERSION = 1;
/** Périmètre géré dans le dépôt : tout le reste (README, etc.) est préservé. */
export const MANAGED_PATHS = ["manifest.yaml", "settings", "environments", "stacks", "secrets"];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ALLOWED = [
  /^manifest\.yaml$/,
  /^settings\/config\.yaml$/,
  /^environments\/default\.yaml$/,
  new RegExp(`^stacks/${UUID}/(stack|variables)\\.yaml$`),
  new RegExp(`^stacks/${UUID}/compose\\.yaml$`),
  new RegExp(`^stacks/${UUID}/files/.+$`),
  new RegExp(`^secrets/${UUID}/variables\\.age$`),
  new RegExp(`^secrets/${UUID}/compose\\.yaml\\.age$`),
  new RegExp(`^secrets/${UUID}/files/.+\\.age$`),
];

export const isAllowedBackupPath = (path: string): boolean => ALLOWED.some((re) => re.test(path));

const MAX_TREE_FILES = 5000;
const MAX_TREE_FILE_BYTES = 1024 * 1024;
const MAX_TREE_BYTES = 50 * 1024 * 1024;

export class BackupFormatError extends Error {}
/** Des secrets chiffrés sont présents mais aucune clé n'a été fournie. */
export class KeyRequiredError extends Error {}
/** La clé fournie ne déchiffre pas les secrets du dépôt. */
export class InvalidKeyError extends Error {}

const yaml = (value: unknown): string => stringify(value, { sortMapEntries: true, lineWidth: 0 });

// --- Export ------------------------------------------------------------------

export interface SnapshotStack {
  id: string;
  name: string;
  hostId: string;
  description: string;
  /** Révision courante de la stack au moment de l'export. */
  revision: number;
  content: RevisionContent;
  /** Règles de suivi des versions d'images, par service (cf. project.md §12 : « règles de suivi »). */
  updatePolicies?: Record<string, PolicySpec>;
}

export interface SnapshotInput {
  installationId: string;
  configRevision: number;
  hosts: { id: string; name: string }[];
  stacks: SnapshotStack[];
}

export interface CacheEntry {
  hmac: string;
  ciphertext: string;
}

/**
 * Chiffre avec la clé publique de restauration. Un secret inchangé garde son
 * texte chiffré (cache HMAC) : sans cela, chaque export réécrirait tous les
 * fichiers `.age` (le chiffrement age est aléatoire) et créerait des commits inutiles.
 */
export class SecretEncryptor {
  readonly used = new Map<string, CacheEntry>();

  constructor(
    private readonly recipient: string,
    private readonly hmac: (value: string) => string,
    private readonly cache: ReadonlyMap<string, CacheEntry>,
  ) {}

  async encrypt(path: string, plaintext: string): Promise<string> {
    const h = this.hmac(`${this.recipient}\0${path}\0${plaintext}`);
    const hit = this.cache.get(path);
    if (hit && hit.hmac === h) {
      this.used.set(path, hit);
      return hit.ciphertext;
    }
    const enc = new Encrypter();
    enc.addRecipient(this.recipient);
    const ciphertext = armor.encode(await enc.encrypt(plaintext));
    const entry = { hmac: h, ciphertext };
    this.used.set(path, entry);
    return ciphertext;
  }
}

/** Construit le contenu complet du dépôt (chemin → texte), déterministe. */
export async function buildSnapshot(input: SnapshotInput, enc: SecretEncryptor): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  files.set("manifest.yaml", yaml({ formatVersion: FORMAT_VERSION, installationId: input.installationId, configRevision: input.configRevision }));
  files.set("settings/config.yaml", yaml({}));
  files.set(
    "environments/default.yaml",
    yaml({ id: "default", type: "standalone", hosts: [...input.hosts].sort((a, b) => a.id.localeCompare(b.id)) }),
  );

  for (const s of [...input.stacks].sort((a, b) => a.id.localeCompare(b.id))) {
    const c = s.content;
    const sensitiveVars = Object.entries(c.variables).filter(([, v]) => v.sensitive);
    const plainVars = Object.entries(c.variables).filter(([, v]) => !v.sensitive);
    files.set(
      `stacks/${s.id}/stack.yaml`,
      yaml({
        id: s.id,
        name: s.name,
        hostId: s.hostId,
        description: s.description,
        sourceRevision: s.revision,
        ...(c.composeSensitive ? { composeEncrypted: true } : {}),
        ...(c.sensitiveFiles.length > 0 ? { sensitiveFiles: [...c.sensitiveFiles].sort() } : {}),
        ...(sensitiveVars.length > 0 ? { sensitiveVariables: sensitiveVars.map(([n]) => n).sort() } : {}),
        ...(s.updatePolicies && Object.keys(s.updatePolicies).length > 0
          ? { updatePolicies: Object.fromEntries(Object.entries(s.updatePolicies).sort(([a], [b]) => a.localeCompare(b))) }
          : {}),
      }),
    );
    if (c.composeSensitive) {
      files.set(`secrets/${s.id}/compose.yaml.age`, await enc.encrypt(`secrets/${s.id}/compose.yaml.age`, c.compose));
    } else {
      files.set(`stacks/${s.id}/compose.yaml`, c.compose);
    }
    files.set(`stacks/${s.id}/variables.yaml`, yaml(Object.fromEntries(plainVars.map(([n, v]) => [n, v.value]))));
    if (sensitiveVars.length > 0) {
      const path = `secrets/${s.id}/variables.age`;
      files.set(path, await enc.encrypt(path, yaml(Object.fromEntries(sensitiveVars.map(([n, v]) => [n, v.value])))));
    }
    for (const [rel, body] of Object.entries(c.files)) {
      if (c.sensitiveFiles.includes(rel)) {
        const path = `secrets/${s.id}/files/${rel}.age`;
        files.set(path, await enc.encrypt(path, body));
      } else {
        files.set(`stacks/${s.id}/files/${rel}`, body);
      }
    }
  }
  return files;
}

// --- Lecture et validation ----------------------------------------------------

/**
 * Lit les chemins gérés d'un dépôt cloné. Les liens symboliques, fichiers
 * spéciaux et volumes excessifs sont refusés (le dépôt n'est pas de confiance).
 */
export async function readWorkTree(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let total = 0;

  const walk = async (rel: string): Promise<void> => {
    const abs = join(root, rel);
    let st;
    try {
      st = await lstat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (st.isSymbolicLink()) throw new BackupFormatError(`Lien symbolique refusé dans le dépôt : ${rel}`);
    if (st.isDirectory()) {
      for (const name of (await readdir(abs)).sort()) await walk(`${rel}/${name}`);
      return;
    }
    if (!st.isFile()) throw new BackupFormatError(`Fichier spécial refusé dans le dépôt : ${rel}`);
    if (st.size > MAX_TREE_FILE_BYTES) throw new BackupFormatError(`Fichier trop volumineux : ${rel}`);
    total += st.size;
    if (files.size >= MAX_TREE_FILES || total > MAX_TREE_BYTES) {
      throw new BackupFormatError("Le dépôt de sauvegarde est trop volumineux.");
    }
    files.set(rel, await readFile(abs, "utf8"));
  };

  for (const top of MANAGED_PATHS) await walk(top);
  return files;
}

const Uuid = z.uuid();
const Manifest = z.object({
  formatVersion: z.number().int().min(1),
  installationId: Uuid,
  configRevision: z.number().int().min(0),
});
const Environment = z.object({
  id: z.string(),
  type: z.string(),
  hosts: z.array(z.object({ id: Uuid, name: z.string().min(1).max(255) }).strict()).max(1000),
});
const StackMeta = z
  .object({
    id: Uuid,
    name: z.string(),
    hostId: Uuid,
    description: z.string().max(500),
    sourceRevision: z.number().int().min(1),
    composeEncrypted: z.boolean().optional(),
    sensitiveFiles: z.array(z.string()).max(MAX_FILE_COUNT).optional(),
    sensitiveVariables: z.array(z.string()).max(MAX_VARIABLES).optional(),
    updatePolicies: z
      .record(
        z.string().min(1).max(128),
        z.object({ policy: z.enum(POLICIES as [UpdatePolicy, ...UpdatePolicy[]]), pattern: z.string().max(100).nullable().optional() }).strict(),
      )
      .optional(),
  })
  .strict();
const StringMap = z.record(z.string(), z.string());

export interface ParsedStack {
  id: string;
  name: string;
  hostId: string;
  description: string;
  sourceRevision: number;
  content: RevisionContent;
  updatePolicies: Record<string, PolicySpec>;
}

export interface ParsedBackup {
  installationId: string;
  configRevision: number;
  hosts: { id: string; name: string }[];
  stacks: ParsedStack[];
  /** Le dépôt contient des fichiers chiffrés (une clé de restauration est nécessaire). */
  hasSecrets: boolean;
}

function parseYaml(path: string, text: string): unknown {
  try {
    // Pas d'alias : ces fichiers n'en ont pas besoin, et ils évitent les amplifications.
    return parse(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch (err) {
    throw new BackupFormatError(`${path} : YAML invalide (${(err as Error).message.split("\n")[0]})`);
  }
}

function check<T>(path: string, schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new BackupFormatError(`${path} : ${r.error.issues[0]?.path.join(".") || "contenu"} — ${r.error.issues[0]?.message}`);
  }
  return r.data;
}

/** Valide l'intégralité d'une sauvegarde et en déchiffre les secrets. */
export async function parseSnapshot(files: Map<string, string>, identity: string | null): Promise<ParsedBackup> {
  for (const path of files.keys()) {
    if (!ALLOWED.some((re) => re.test(path))) {
      throw new BackupFormatError(`Fichier inattendu dans le périmètre de sauvegarde : ${path}`);
    }
  }
  const get = (path: string): string => {
    const text = files.get(path);
    if (text === undefined) throw new BackupFormatError(`Fichier manquant : ${path}`);
    return text;
  };

  const manifest = check("manifest.yaml", Manifest, parseYaml("manifest.yaml", get("manifest.yaml")));
  if (manifest.formatVersion > FORMAT_VERSION) {
    throw new BackupFormatError(
      `Format de sauvegarde ${manifest.formatVersion} plus récent que celui supporté (${FORMAT_VERSION}) : mettez la console à jour.`,
    );
  }
  const env = check("environments/default.yaml", Environment, parseYaml("environments/default.yaml", get("environments/default.yaml")));

  const hasSecrets = [...files.keys()].some((p) => p.endsWith(".age"));
  let decrypter: Decrypter | null = null;
  if (hasSecrets) {
    if (!identity) throw new KeyRequiredError("La clé de restauration est nécessaire pour déchiffrer ce dépôt.");
    decrypter = new Decrypter();
    try {
      decrypter.addIdentity(identity.trim());
    } catch {
      throw new InvalidKeyError("Clé de restauration invalide (format AGE-SECRET-KEY-… attendu).");
    }
  }
  const decrypt = async (path: string): Promise<string> => {
    try {
      return await (decrypter as Decrypter).decrypt(armor.decode(get(path)), "text");
    } catch {
      throw new InvalidKeyError("La clé de restauration ne permet pas de déchiffrer ce dépôt.");
    }
  };

  const idSet = new Set<string>();
  for (const p of files.keys()) {
    const m = /^(?:stacks|secrets)\/([^/]+)\//.exec(p);
    if (m?.[1]) idSet.add(m[1]);
  }
  const ids = [...idSet].sort();
  const stacks: ParsedStack[] = [];

  for (const id of ids) {
    const metaPath = `stacks/${id}/stack.yaml`;
    const meta = check(metaPath, StackMeta, parseYaml(metaPath, get(metaPath)));
    if (meta.id !== id) throw new BackupFormatError(`${metaPath} : l'identifiant ne correspond pas au dossier`);
    const nameError = validateStackName(meta.name);
    if (nameError) throw new BackupFormatError(`${metaPath} : ${nameError}`);

    // Compose
    const compose = meta.composeEncrypted ? await decrypt(`secrets/${id}/compose.yaml.age`) : get(`stacks/${id}/compose.yaml`);
    const validated = validateCompose(compose);
    if (!validated.ok) {
      throw new BackupFormatError(`Compose de « ${meta.name} » invalide : ${validated.issues[0]?.message ?? "erreur"}`);
    }

    // Variables
    const variables: VariableMap = {};
    const plain = check(`stacks/${id}/variables.yaml`, StringMap, parseYaml("variables.yaml", get(`stacks/${id}/variables.yaml`)) ?? {});
    for (const [name, value] of Object.entries(plain)) variables[name] = { value, sensitive: false };
    const sensitiveNames = [...(meta.sensitiveVariables ?? [])].sort();
    if (sensitiveNames.length > 0) {
      const secret = check(
        `secrets/${id}/variables.age`,
        StringMap,
        parseYaml("variables.age", await decrypt(`secrets/${id}/variables.age`)) ?? {},
      );
      if (Object.keys(secret).sort().join("\0") !== sensitiveNames.join("\0")) {
        throw new BackupFormatError(`secrets/${id}/variables.age : variables sensibles incohérentes avec stack.yaml`);
      }
      for (const [name, value] of Object.entries(secret)) {
        if (name in variables) throw new BackupFormatError(`Variable « ${name} » présente en clair et chiffrée`);
        variables[name] = { value, sensitive: true };
      }
    } else if (files.has(`secrets/${id}/variables.age`)) {
      throw new BackupFormatError(`secrets/${id}/variables.age : fichier non déclaré dans stack.yaml`);
    }
    if (Object.keys(variables).length > MAX_VARIABLES) throw new BackupFormatError(`« ${meta.name} » : trop de variables`);
    for (const [name, v] of Object.entries(variables)) {
      const err = validateVariableName(name) ?? validateVariableValue(v.value);
      if (err) throw new BackupFormatError(`« ${meta.name} » variable ${name} : ${err}`);
    }

    // Fichiers associés
    const stackFiles: Record<string, string> = {};
    const sensitiveFiles = [...(meta.sensitiveFiles ?? [])];
    for (const path of files.keys()) {
      const plainPrefix = `stacks/${id}/files/`;
      const secretPrefix = `secrets/${id}/files/`;
      if (path.startsWith(plainPrefix)) {
        const rel = path.slice(plainPrefix.length);
        const err = validateFilePath(rel);
        if (err) throw new BackupFormatError(`${path} : ${err}`);
        if (sensitiveFiles.includes(rel)) throw new BackupFormatError(`${path} : fichier déclaré sensible mais présent en clair`);
        stackFiles[rel] = get(path);
      } else if (path.startsWith(secretPrefix)) {
        const rel = path.slice(secretPrefix.length, -".age".length);
        const err = validateFilePath(rel);
        if (err) throw new BackupFormatError(`${path} : ${err}`);
        if (!sensitiveFiles.includes(rel)) throw new BackupFormatError(`${path} : fichier chiffré non déclaré dans stack.yaml`);
        stackFiles[rel] = await decrypt(path);
      }
    }
    for (const rel of sensitiveFiles) {
      if (!(rel in stackFiles)) throw new BackupFormatError(`Fichier sensible déclaré mais absent : ${rel}`);
    }
    const names = Object.keys(stackFiles);
    if (names.length > MAX_FILE_COUNT) throw new BackupFormatError(`« ${meta.name} » : trop de fichiers`);
    if (names.reduce((n, p) => n + Buffer.byteLength(stackFiles[p] ?? "", "utf8"), 0) > MAX_FILES_TOTAL_BYTES) {
      throw new BackupFormatError(`« ${meta.name} » : fichiers trop volumineux`);
    }

    const updatePolicies: Record<string, PolicySpec> = {};
    for (const [service, p] of Object.entries(meta.updatePolicies ?? {})) {
      if (p.policy === "pattern") {
        const err = validatePattern(p.pattern ?? "");
        if (err) throw new BackupFormatError(`${metaPath} : règle de suivi de « ${service} » invalide (${err})`);
      }
      updatePolicies[service] = { policy: p.policy, pattern: p.policy === "pattern" ? (p.pattern ?? null) : null };
    }

    stacks.push({
      id,
      updatePolicies,
      name: meta.name,
      hostId: meta.hostId,
      description: meta.description,
      sourceRevision: meta.sourceRevision,
      content: { compose, variables, files: stackFiles, sensitiveFiles: sensitiveFiles.sort(), composeSensitive: meta.composeEncrypted === true },
    });
  }

  const nameSeen = new Set<string>();
  for (const s of stacks) {
    if (nameSeen.has(s.name)) throw new BackupFormatError(`Nom de stack en double dans la sauvegarde : ${s.name}`);
    nameSeen.add(s.name);
  }

  return { installationId: manifest.installationId, configRevision: manifest.configRevision, hosts: env.hosts, stacks, hasSecrets };
}
