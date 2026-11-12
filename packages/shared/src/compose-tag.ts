import { isAlias, isMap, isScalar, parseDocument } from "yaml";
import { ComposeEditError, detectStyle } from "./compose-edit.js";

/**
 * Change l'étiquette de l'image d'un service (`ghost:bookworm` → `ghost:6.75-alpine`) en conservant le reste du
 * document. Refuse une image paramétrée (variables), épinglée par digest ou sans « image » simple.
 */
export function editServiceImageTag(text: string, service: string, tag: string): { compose: string; from: string; to: string } {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) throw new ComposeEditError("unsupported_structure", "Étiquette invalide.");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new ComposeEditError("unsupported_structure", "Le Compose actuel n'est pas un YAML valide.");
  const services = doc.get("services", true);
  if (!isMap(services)) throw new ComposeEditError("unsupported_structure", "Section « services » introuvable.");
  const svc = services.get(service, true);
  if (!isMap(svc)) throw new ComposeEditError("service_not_found", `Service « ${service} » introuvable.`);
  if (svc.has("<<")) throw new ComposeEditError("unsupported_structure", "Le service utilise une clé de fusion « << » : modification refusée.");
  if (svc.has("build")) throw new ComposeEditError("unsupported_structure", "Ce service est construit localement : modifiez son Dockerfile plutôt que son étiquette.");
  const image = svc.get("image", true);
  if (isAlias(image) || !isScalar(image) || typeof image.value !== "string") {
    throw new ComposeEditError("unsupported_structure", "Le service n'a pas d'« image » simple à modifier.");
  }
  const from = image.value;
  if (from.includes("$")) throw new ComposeEditError("unsupported_structure", "L'image est paramétrée par une variable : modifiez la variable ou le Compose à la main.");
  if (from.includes("@")) throw new ComposeEditError("unsupported_structure", "L'image est épinglée par digest : modifiez-la à la main.");
  const lastSlash = from.lastIndexOf("/");
  const colon = from.indexOf(":", lastSlash + 1);
  const to = `${colon === -1 ? from : from.slice(0, colon)}:${tag}`;
  if (to === from) throw new ComposeEditError("unsupported_structure", "C'est déjà l'étiquette actuelle.");
  image.value = to;
  const style = detectStyle(text);
  return {
    from,
    to,
    compose: doc.toString({
      indent: style.indent,
      indentSeq: style.indentSeq,
      ...(style.singleQuote !== null ? { singleQuote: style.singleQuote } : {}),
      lineWidth: 0,
    }),
  };
}

/** Image (texte) d'un service dans un Compose ; null si le service ou son image est absent ou illisible. */
export function composeServiceImage(text: string, service: string): string | null {
  try {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length > 0) return null;
    const services = doc.get("services", true);
    if (!isMap(services)) return null;
    const svc = services.get(service, true);
    if (!isMap(svc)) return null;
    const image = svc.get("image", true);
    return isScalar(image) && typeof image.value === "string" ? image.value : null;
  } catch {
    return null;
  }
}

/** Référence d'image corrigée par la console : registre, dépôt et digest (`registry.exemple.fr/patched/x@sha256:…`). */
export const PATCHED_REF = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?\/[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;

/**
 * Remplace l'image d'un service par une référence épinglée par digest (image corrigée), en conservant le reste du
 * document. Refuse une image paramétrée (variables), un service construit localement, une clé de fusion ou un alias.
 * Une image déjà épinglée est remplaçable : c'est le cas d'un nouveau correctif après un précédent.
 */
export function editServiceImageRef(text: string, service: string, ref: string): { compose: string; from: string; to: string } {
  if (!PATCHED_REF.test(ref)) throw new ComposeEditError("unsupported_structure", "Référence d'image invalide (registre/dépôt@sha256:… attendu).");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new ComposeEditError("unsupported_structure", "Le Compose actuel n'est pas un YAML valide.");
  const services = doc.get("services", true);
  if (!isMap(services)) throw new ComposeEditError("unsupported_structure", "Section « services » introuvable.");
  const svc = services.get(service, true);
  if (!isMap(svc)) throw new ComposeEditError("service_not_found", `Service « ${service} » introuvable.`);
  if (svc.has("<<")) throw new ComposeEditError("unsupported_structure", "Le service utilise une clé de fusion « << » : modification refusée.");
  if (svc.has("build")) throw new ComposeEditError("unsupported_structure", "Ce service est construit localement : l'image corrigée ne peut pas le remplacer.");
  const image = svc.get("image", true);
  if (isAlias(image) || !isScalar(image) || typeof image.value !== "string") {
    throw new ComposeEditError("unsupported_structure", "Le service n'a pas d'« image » simple à modifier.");
  }
  const from = image.value;
  if (from.includes("$")) throw new ComposeEditError("unsupported_structure", "L'image est composée de plusieurs variables, ou de variables et de texte : modifiez-la à la main.");
  if (from === ref) throw new ComposeEditError("unsupported_structure", "Ce service utilise déjà cette image corrigée.");
  image.value = ref;
  const style = detectStyle(text);
  return {
    from,
    to: ref,
    compose: doc.toString({
      indent: style.indent,
      indentSeq: style.indentSeq,
      ...(style.singleQuote !== null ? { singleQuote: style.singleQuote } : {}),
      lineWidth: 0,
    }),
  };
}

// --- Image portée par une variable (`image: ${WORKER_IMAGE:-alpine:3.22}`) ---------------------------------

/** Variable qui porte, à elle seule, la référence d'image d'un service. */
export interface ImageVariable {
  name: string;
  /** Valeur par défaut du Compose (`:-` ou `-`), sinon null. */
  defaultValue: string | null;
  /** Nombre d'autres endroits du Compose qui utilisent la même variable (au-delà de l'image du service). */
  otherUses: number;
}

const WHOLE_VARIABLE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}$]*))?\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const ANY_VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function* stringValues(node: unknown): Generator<string> {
  if (typeof node === "string") yield node;
  else if (Array.isArray(node)) for (const n of node) yield* stringValues(n);
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) {
    yield k;
    yield* stringValues(v);
  }
}

/**
 * Variable qui porte toute la référence d'image d'un service (`${NOM}`, `${NOM:-défaut}`, `${NOM-défaut}`, `$NOM`) ;
 * null pour une image écrite en clair, composée de plusieurs variables, ou avec `:?` / `:+`.
 */
export function serviceImageVariable(text: string, service: string): ImageVariable | null {
  const image = composeServiceImage(text, service);
  if (image === null) return null;
  const m = WHOLE_VARIABLE.exec(image.trim());
  if (!m) return null;
  const name = (m[1] ?? m[3]) as string;
  let uses = 0;
  try {
    for (const s of stringValues(parseDocument(text, { uniqueKeys: true }).toJS({ maxAliasCount: 100 }))) {
      for (const v of s.replaceAll("$$", "\u0000\u0000").matchAll(ANY_VARIABLE)) if ((v[1] ?? v[2]) === name) uses++;
    }
  } catch {
    return null;
  }
  return { name, defaultValue: m[2] ?? null, otherUses: Math.max(0, uses - 1) };
}

export interface StackVariable {
  value: string;
  sensitive: boolean;
}

/** Valeur effective de la variable d'image : la valeur de la stack si elle est non vide, sinon le défaut du Compose. */
export function effectiveImageValue(v: ImageVariable, variables: Record<string, StackVariable>): string | null {
  const own = variables[v.name]?.value;
  return own !== undefined && own !== "" ? own : v.defaultValue;
}

/**
 * Propose l'image corrigée en changeant la VARIABLE qui porte l'image, jamais le Compose. Refuse : un service construit
 * localement, une clé de fusion, une image qui n'est pas portée par une seule variable, une variable utilisée ailleurs
 * (ou sensible), et une valeur déjà égale à l'image corrigée.
 */
export function editServiceImageVariable(
  text: string,
  service: string,
  ref: string,
  variables: Record<string, StackVariable>,
): { name: string; from: string | null; to: string; variables: Record<string, StackVariable> } {
  if (!PATCHED_REF.test(ref)) throw new ComposeEditError("unsupported_structure", "Référence d'image invalide (registre/dépôt@sha256:… attendu).");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new ComposeEditError("unsupported_structure", "Le Compose actuel n'est pas un YAML valide.");
  const services = doc.get("services", true);
  if (!isMap(services)) throw new ComposeEditError("unsupported_structure", "Section « services » introuvable.");
  const svc = services.get(service, true);
  if (!isMap(svc)) throw new ComposeEditError("service_not_found", `Service « ${service} » introuvable.`);
  if (svc.has("<<")) throw new ComposeEditError("unsupported_structure", "Le service utilise une clé de fusion « << » : modification refusée.");
  if (svc.has("build")) throw new ComposeEditError("unsupported_structure", "Ce service est construit localement : l'image corrigée ne peut pas le remplacer.");
  const image = svc.get("image", true);
  if (isAlias(image) || !isScalar(image) || typeof image.value !== "string") {
    throw new ComposeEditError("unsupported_structure", "Le service n'a pas d'« image » simple à modifier.");
  }
  const v = serviceImageVariable(text, service);
  if (!v) throw new ComposeEditError("unsupported_structure", "L'image est composée de plusieurs variables ou d'une forme non gérée (« :? », « :+ ») : modifiez-la à la main.");
  if (v.otherUses > 0) throw new ComposeEditError("unsupported_structure", `La variable ${v.name} est utilisée ailleurs dans le Compose : la modifier changerait d'autres éléments.`);
  const existing = variables[v.name];
  if (existing?.sensitive) throw new ComposeEditError("unsupported_structure", `La variable ${v.name} est sensible : elle n'est pas modifiée par ce parcours.`);
  const from = effectiveImageValue(v, variables);
  if (from === ref) throw new ComposeEditError("unsupported_structure", "Ce service utilise déjà cette image corrigée.");
  return { name: v.name, from, to: ref, variables: { ...variables, [v.name]: { value: ref, sensitive: false } } };
}
