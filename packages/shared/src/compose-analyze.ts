import { parse } from "yaml";
import { looksSecret } from "./compose-vars.js";

/** Une variable d'interpolation référencée par le Compose (`${NOM}`, `${NOM:-défaut}`, `${NOM:?erreur}`, `$NOM`). */
export interface VariableReference {
  name: string;
  /** Valeur par défaut déclarée dans le Compose (`:-` ou `-`), sinon absente. */
  defaultValue?: string;
  /** Obligatoire : ni valeur par défaut, ni forme `:+` ; Compose refuse de démarrer sans elle. */
  required: boolean;
  /** Services qui l'utilisent. */
  services: string[];
  /** Le nom ou son contexte évoque un secret (mot de passe, jeton, clé…). */
  secret: boolean;
}

const REF = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function* strings(node: unknown, path: string[]): Generator<{ service: string; value: string }> {
  const service = path[0] === "services" ? (path[1] ?? "") : "";
  if (typeof node === "string") yield { service, value: node };
  else if (Array.isArray(node)) for (const n of node) yield* strings(n, path);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) yield* strings(v, [...path, k]);
  }
}

/** Variables référencées par le Compose, avec valeur par défaut, caractère obligatoire et services concernés. */
export function detectVariableReferences(text: string): VariableReference[] {
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 100 });
  } catch {
    return [];
  }
  const found = new Map<string, VariableReference>();
  for (const { service, value } of strings(doc, [])) {
    for (const m of value.replaceAll("$$", "\u0000\u0000").matchAll(REF)) {
      const name = (m[1] ?? m[4]) as string;
      const op = m[2];
      const arg = m[3] ?? "";
      let ref = found.get(name);
      if (!ref) {
        ref = { name, required: true, services: [], secret: looksSecret(name, "x") };
        found.set(name, ref);
      }
      if (op === "-" || op === ":-") {
        ref.defaultValue = arg;
        ref.required = false;
      } else if (op === "+" || op === ":+") ref.required = false;
      if (service && !ref.services.includes(service)) ref.services.push(service);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Remplace `${NOM}` / `${NOM:-défaut}` par les valeurs connues ; null si une variable reste sans valeur. */
function resolve(value: string, vars: Record<string, string>): string | null {
  let missing = false;
  const out = value.replaceAll("$$", "\u0000\u0000").replace(REF, (_m, braced: string | undefined, op: string | undefined, arg: string | undefined, bare: string | undefined) => {
    const name = (braced ?? bare) as string;
    const v = vars[name];
    if (v !== undefined && v !== "") return v;
    if (op === "-" || op === ":-") return arg ?? "";
    missing = true;
    return "";
  });
  return missing ? null : out.replaceAll("\u0000\u0000", "$");
}

/** Ce que le Compose déclare pour un service, en vue de la comparaison avec les conteneurs observés. */
export interface DeclaredService {
  name: string;
  optional: boolean;
  /** Ports publiés sur l'hôte (`publié:conteneur`) ; `unresolved` : au moins un dépend d'une variable sans valeur. */
  published: number[];
  unresolved: boolean;
  /** Destinations des montages déclarés (dans le conteneur). */
  mounts: string[];
}

function declaredPorts(raw: unknown, vars: Record<string, string>): { ports: number[]; unresolved: boolean } {
  const ports: number[] = [];
  let unresolved = false;
  for (const p of Array.isArray(raw) ? raw : []) {
    let pub: string | null | undefined;
    if (typeof p === "string") {
      // On résout d'abord : « ${P:-8080}:80 » contient des « : » qui ne séparent pas les ports.
      const full = resolve(p, vars);
      if (full === null) {
        unresolved = true;
        continue;
      }
      const parts = full.split("/")[0]?.split(":") ?? [];
      if (parts.length < 2) continue; // port non publié (« 80 »)
      pub = parts[parts.length - 2];
    } else if (typeof p === "number") continue;
    else if (p && typeof p === "object" && "published" in p) pub = resolve(String((p as { published: unknown }).published), vars);
    else continue;
    const n = Number(pub);
    if (pub === null) unresolved = true;
    else if (Number.isInteger(n) && n > 0) ports.push(n);
  }
  return { ports, unresolved };
}

function declaredMounts(raw: unknown): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(raw) ? raw : []) {
    if (typeof v === "string") {
      const parts = v.split(":");
      const dest = parts.length === 1 ? parts[0] : parts[1];
      if (dest) out.push(dest);
    } else if (v && typeof v === "object" && typeof (v as { target?: unknown }).target === "string") out.push((v as { target: string }).target);
  }
  return out;
}

export function declaredServices(text: string, variables: Record<string, string> = {}): DeclaredService[] {
  let doc: { services?: Record<string, Record<string, unknown> | null> } | null;
  try {
    doc = parse(text, { maxAliasCount: 100 }) as typeof doc;
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") return [];
  return Object.entries(doc.services).map(([name, svc]) => {
    const { ports, unresolved } = declaredPorts(svc?.ports, variables);
    return {
      name,
      optional: Array.isArray(svc?.profiles) && svc.profiles.length > 0,
      published: ports,
      unresolved,
      mounts: declaredMounts(svc?.volumes),
    };
  });
}

/** Conteneur observé, réduit à ce qui sert à la comparaison. */
export interface ObservedService {
  service: string;
  ports?: { publicPort?: number | undefined }[] | undefined;
  mounts?: { type: string; destination: string }[] | undefined;
}

export interface ObservedDifference {
  level: "warning" | "info";
  service?: string;
  message: string;
}

/**
 * Écarts détectables entre le Compose saisi et ce qui tourne : services absents ou en trop, ports publiés qui ne
 * correspondent pas, montages observés que le Compose ne déclare pas. Ce n'est pas une preuve d'équivalence.
 */
export function compareWithObserved(text: string, observed: ObservedService[], variables: Record<string, string> = {}): ObservedDifference[] {
  const diffs: ObservedDifference[] = [];
  const declared = declaredServices(text, variables);
  const byName = new Map(declared.map((d) => [d.name, d]));
  const seen = new Set(observed.map((o) => o.service));
  for (const d of declared) {
    if (!seen.has(d.name) && !d.optional) diffs.push({ level: "warning", service: d.name, message: `Le service « ${d.name} » est dans le Compose mais aucun conteneur ne tourne pour lui.` });
  }
  for (const name of seen) {
    if (!byName.has(name)) diffs.push({ level: "warning", service: name, message: `Un conteneur du service « ${name} » tourne mais le Compose ne le déclare pas : il ne sera pas géré par ce Compose.` });
  }
  for (const o of observed) {
    const d = byName.get(o.service);
    if (!d) continue;
    const running = [...new Set((o.ports ?? []).map((p) => p.publicPort).filter((p): p is number => typeof p === "number"))].sort((a, b) => a - b);
    if (d.unresolved) {
      diffs.push({ level: "info", service: o.service, message: `Les ports de « ${o.service} » dépendent de variables sans valeur : renseignez-les pour les comparer (en marche : ${running.join(", ") || "aucun"}).` });
    } else {
      const decl = [...new Set(d.published)].sort((a, b) => a - b);
      const missing = running.filter((p) => !decl.includes(p));
      const extra = decl.filter((p) => !running.includes(p));
      if (missing.length) diffs.push({ level: "warning", service: o.service, message: `Port(s) ${missing.join(", ")} publié(s) par le conteneur de « ${o.service} » mais absent(s) du Compose : ils seraient fermés au déploiement.` });
      if (extra.length) diffs.push({ level: "info", service: o.service, message: `Port(s) ${extra.join(", ")} déclaré(s) par le Compose pour « ${o.service} » mais pas publiés actuellement.` });
    }
    const declaredDest = new Set(d.mounts);
    const lost = (o.mounts ?? []).filter((m) => (m.type === "bind" || m.type === "volume") && !declaredDest.has(m.destination)).map((m) => m.destination);
    if (lost.length) diffs.push({ level: "warning", service: o.service, message: `Montage(s) ${lost.join(", ")} présent(s) sur le conteneur de « ${o.service} » mais absent(s) du Compose : les données ne seraient plus accessibles après recréation.` });
  }
  return diffs;
}
