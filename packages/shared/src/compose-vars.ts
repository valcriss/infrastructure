import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Document, Scalar } from "yaml";
import { ComposeEditError, detectStyle } from "./compose-edit.js";
import { validateVariableName, validateVariableValue } from "./stack.js";

/** Une valeur écrite en clair dans la section `environment` d'un service. */
export interface EnvUse {
  service: string;
  /** Nom de la variable d'environnement du conteneur (inchangé par l'extraction). */
  key: string;
  /** Valeur réelle (les `$$` du Compose sont ramenés à `$`). */
  value: string;
  form: "map" | "list";
}

export interface SkippedEnv {
  service: string;
  key?: string;
  reason: string;
}

/** Vrai si la valeur contient une interpolation Compose (`$VAR`, `${VAR}`) ; `$$` est un `$` échappé. */
export const hasInterpolation = (value: string): boolean => /\$/.test(value.replaceAll("$$", ""));

/** Valeur Compose → valeur réelle (`$$` → `$`). */
export const unescapeDollar = (value: string): string => value.replaceAll("$$", "$");

type EnvLocation = { form: "map"; node: Scalar } | { form: "list"; node: Scalar; key: string };

interface Scanned {
  use: EnvUse;
  location: EnvLocation;
}

function parse(text: string): Document {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new ComposeEditError("unsupported_structure", "Le Compose actuel n'est pas un YAML valide.");
  return doc;
}

/** Parcourt les `environment` littéraux de tous les services (dictionnaire ou liste `CLE=valeur`). */
function scan(doc: Document): { found: Scanned[]; skipped: SkippedEnv[] } {
  const found: Scanned[] = [];
  const skipped: SkippedEnv[] = [];
  const services = doc.get("services", true);
  if (!isMap(services)) return { found, skipped };
  for (const pair of services.items) {
    const service = isScalar(pair.key) ? String(pair.key.value) : null;
    const svc = pair.value;
    if (service === null || !isMap(svc)) continue;
    if (svc.has("<<")) {
      skipped.push({ service, reason: "clé de fusion « << » : service ignoré" });
      continue;
    }
    const env = svc.get("environment", true);
    if (env === undefined || env === null) continue;
    if (isAlias(env)) {
      skipped.push({ service, reason: "« environment » utilise un alias YAML : service ignoré" });
      continue;
    }
    const take = (key: string, raw: string, location: EnvLocation): void => {
      if (hasInterpolation(raw)) return; // déjà une variable (ou une expression) : rien à extraire
      const value = unescapeDollar(raw);
      if (value === "") return;
      const problem = validateVariableValue(value);
      if (problem) {
        skipped.push({ service, key, reason: problem });
        return;
      }
      found.push({ use: { service, key, value, form: location.form }, location });
    };
    if (isMap(env)) {
      for (const p of env.items) {
        const key = isScalar(p.key) ? String(p.key.value) : null;
        if (key === null) continue;
        if (isAlias(p.value)) {
          skipped.push({ service, key, reason: "alias YAML" });
          continue;
        }
        // Un nombre ou un booléen est repris tel quel sous forme de texte (ce que Docker transmet au conteneur).
        if (isScalar(p.value) && p.value.value !== null && p.value.value !== undefined) take(key, String(p.value.value), { form: "map", node: p.value });
      }
    } else if (isSeq(env)) {
      for (const item of env.items) {
        if (!isScalar(item) || typeof item.value !== "string") continue;
        const eq = item.value.indexOf("=");
        if (eq <= 0) continue; // « CLE » seule : valeur héritée de l'hôte
        take(item.value.slice(0, eq), item.value.slice(eq + 1), { form: "list", node: item, key: item.value.slice(0, eq) });
      }
    }
  }
  return { found, skipped };
}

/** Valeurs littérales d'`environment` qu'on pourrait transformer en variables, et ce qui a été ignoré (avec la raison). */
export function detectEnvLiterals(text: string): { uses: EnvUse[]; skipped: SkippedEnv[] } {
  const { found, skipped } = scan(parse(text));
  return { uses: found.map((f) => f.use), skipped };
}

// --- Secrets ------------------------------------------------------------------------------------------------

const SECRET_NAME = /(PASS(WORD|WD)?|PWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE|CREDENTIAL|SALT|AUTH[_-]?(USER|PASS|KEY|TOKEN)|SIGNING|ENCRYPTION)/i;
const SECRET_VALUE = [
  /^AKIA[0-9A-Z]{16}$/, // clé d'accès AWS
  /^(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub
  /^glpat-[A-Za-z0-9_-]{10,}/, // GitLab
  /^xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack
  /^sk[-_](live|test)?[-_]?[A-Za-z0-9]{16,}/, // Stripe, OpenAI…
  /:\/\/[^/\s:@]+:[^@\s]+@/, // URL avec identifiants
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // jeton JWT
];

/** Heuristique : le nom ou la forme de la valeur évoque un secret (mot de passe, jeton, clé…). */
export function looksSecret(key: string, value: string): boolean {
  if (SECRET_NAME.test(key)) return true;
  if (SECRET_VALUE.some((r) => r.test(value))) return true;
  // Longue chaîne mêlant lettres et chiffres sans espace : probablement générée.
  return value.length >= 24 && /^[A-Za-z0-9+/=_-]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

// --- Regroupement et nommage -------------------------------------------------------------------------------

/** Nom de variable de stack depuis une clé : `mail__options__host` → `MAIL_OPTIONS_HOST` (pas de double underscore). */
export function variableNameFor(key: string): string {
  let name = key
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (name === "") name = "VAR";
  if (/^\d/.test(name)) name = `V_${name}`;
  return name.slice(0, 120);
}

export interface ExtractGroup {
  id: string;
  /** Nom proposé, unique dans la proposition et face aux variables existantes. */
  name: string;
  value: string;
  /** Ressemble à un secret : à chiffrer, coché par défaut. */
  secret: boolean;
  /** Utilisée à plusieurs endroits (services ou clés) : une seule variable les alimenterait toutes. */
  shared: boolean;
  /** Une variable de ce nom existe déjà avec la même valeur : elle sera réutilisée, pas recréée. */
  reuse: boolean;
  uses: { service: string; key: string }[];
}

const TRIVIAL = new Set(["true", "false", "yes", "no", "on", "off", "null", "none", "production", "development", "prod", "dev", "test", "localhost", "utc", "root", "admin"]);
/** Valeur assez distinctive pour être regroupée entre clés différentes ; sinon seulement entre usages de la même clé. */
const distinctive = (value: string): boolean => value.length >= 6 && !TRIVIAL.has(value.toLowerCase()) && !/^\d+$/.test(value);

export interface ExistingVariable {
  value: string;
  sensitive: boolean;
}

/**
 * Regroupe les valeurs identiques (même variable pour tous leurs usages) et propose des noms uniques :
 * jamais deux noms identiques pour deux valeurs différentes. Une collision est levée en préfixant par le service,
 * puis par un suffixe numérique.
 */
export function proposeGroups(uses: EnvUse[], existing: Record<string, ExistingVariable> = {}): ExtractGroup[] {
  const byKey = new Map<string, EnvUse[]>();
  for (const u of uses) {
    const secret = looksSecret(u.key, u.value);
    const k = secret || distinctive(u.value) ? `v:${u.value}` : `k:${u.key}\u0000${u.value}`;
    byKey.set(k, [...(byKey.get(k) ?? []), u]);
  }
  const taken = new Set(Object.keys(existing));
  const groups: ExtractGroup[] = [];
  const ordered = [...byKey.values()].sort((a, b) => (a[0]?.service ?? "").localeCompare(b[0]?.service ?? "") || (a[0]?.key ?? "").localeCompare(b[0]?.key ?? ""));
  for (const members of ordered) {
    const first = members[0] as EnvUse;
    const secret = members.some((m) => looksSecret(m.key, m.value));
    // Nom de base : la clé la plus fréquente du groupe ; à égalité, la plus courte (souvent la plus générique), puis l'ordre alphabétique.
    const counts = new Map<string, number>();
    for (const m of members) counts.set(m.key, (counts.get(m.key) ?? 0) + 1);
    const key =
      [...counts.entries()].sort((a, b) => b[1] - a[1] || variableNameFor(a[0]).length - variableNameFor(b[0]).length || a[0].localeCompare(b[0]))[0]?.[0] ?? first.key;
    const base = variableNameFor(key);
    const current = existing[base];
    let name = base;
    let reuse = false;
    if (current && current.value === first.value && current.sensitive === secret) {
      reuse = true;
    } else {
      if (taken.has(name)) name = variableNameFor(`${first.service}_${base}`);
      for (let i = 2; taken.has(name); i++) name = `${variableNameFor(`${first.service}_${base}`)}_${i}`;
      taken.add(name);
    }
    const sites = members.map((m) => ({ service: m.service, key: m.key }));
    groups.push({
      id: `${first.service}\u0000${first.key}`,
      name,
      value: first.value,
      secret,
      shared: new Set(members.map((m) => `${m.service}\u0000${m.key}`)).size > 1,
      reuse,
      uses: sites,
    });
  }
  return groups;
}

/** Contrôle de nom (syntaxe) pour la saisie d'un nom de variable : null s'il est valide. */
export const checkVariableName = (name: string): string | null => validateVariableName(name) ?? (name.includes("__") ? "Évitez le double underscore « __ »." : null);

// --- Application -------------------------------------------------------------------------------------------

export interface Replacement {
  service: string;
  key: string;
  /** Nom de la variable de stack qui remplace la valeur. */
  name: string;
}

/** Remplace les valeurs par `${NOM}` en conservant commentaires, ordre et forme du document. */
export function applyExtraction(text: string, replacements: Replacement[]): string {
  const doc = parse(text);
  const { found } = scan(doc);
  for (const r of replacements) {
    const hit = found.find((f) => f.use.service === r.service && f.use.key === r.key);
    if (!hit) throw new ComposeEditError("unsupported_structure", `Valeur introuvable ou déjà variable : ${r.service} / ${r.key}.`);
    if (hit.location.form === "map") hit.location.node.value = `\${${r.name}}`;
    else hit.location.node.value = `${hit.location.key}=\${${r.name}}`;
  }
  const style = detectStyle(text);
  return doc.toString({
    indent: style.indent,
    indentSeq: style.indentSeq,
    ...(style.singleQuote !== null ? { singleQuote: style.singleQuote } : {}),
    lineWidth: 0,
  });
}

// --- Équivalence ---------------------------------------------------------------------------------------------

/** Interpolation Compose minimale : `$$`, `$VAR`, `${VAR}`, `${VAR:-défaut}`, `${VAR-défaut}`. Variable absente → vide. */
function interpolate(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, braced: string | undefined, colon: string | undefined, fallback: string | undefined, bare: string | undefined) => {
    if (m === "$$") return "$";
    const name = braced ?? bare ?? "";
    const v = vars[name];
    if (fallback !== undefined && (v === undefined || (colon === ":" && v === ""))) return fallback;
    return v ?? "";
  });
}

/** Environnement de chaque service après interpolation, clés triées : sert à comparer deux Compose. */
export function resolvedEnvironment(text: string, variables: Record<string, string>): Record<string, Record<string, string>> {
  const doc = parse(text);
  const out: Record<string, Record<string, string>> = {};
  const services = doc.get("services", true);
  if (!isMap(services)) return out;
  for (const pair of services.items) {
    const service = isScalar(pair.key) ? String(pair.key.value) : null;
    const svc = pair.value;
    if (service === null || !isMap(svc)) continue;
    const env = svc.get("environment", true);
    const entries: [string, string][] = [];
    if (isMap(env)) {
      for (const p of env.items) {
        const key = isScalar(p.key) ? String(p.key.value) : null;
        if (key !== null && isScalar(p.value) && p.value.value !== null && p.value.value !== undefined) entries.push([key, interpolate(String(p.value.value), variables)]);
      }
    } else if (isSeq(env)) {
      for (const item of env.items) {
        if (!isScalar(item) || typeof item.value !== "string") continue;
        const eq = item.value.indexOf("=");
        if (eq > 0) entries.push([item.value.slice(0, eq), interpolate(item.value.slice(eq + 1), variables)]);
      }
    }
    out[service] = Object.fromEntries(entries.sort((a, b) => a[0].localeCompare(b[0])));
  }
  return out;
}
