import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Document } from "yaml";

export type ComposeEditErrorCode = "service_not_found" | "unsupported_structure";

export class ComposeEditError extends Error {
  constructor(
    public readonly code: ComposeEditErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

export function validateEnvironmentName(name: string): string | null {
  return ENV_NAME.test(name) ? null : "Nom de variable d'environnement invalide.";
}

/** Détecte l'indentation du document pour la conserver à la réécriture. */
export function detectStyle(text: string): { indent: number; indentSeq: boolean; singleQuote: boolean | null } {
  // Limite de la bibliothèque YAML : avec une indentation de 4 espaces ET des
  // listes non indentées, les listes sont réécrites décalées de 2 espaces.
  const singles = (text.match(/(?:^|[:\-=]\s+)'/gm) ?? []).length;
  const doubles = (text.match(/(?:^|[:\-=]\s+)"/gm) ?? []).length;
  const singleQuote = singles > doubles ? true : doubles > singles ? false : null;
  const lines = text.split(/\r?\n/);
  let indent = 0;
  let indentSeq = true;
  let seqKnown = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(#.*)?$/.test(line)) continue;
    const lead = /^( *)/.exec(line)?.[1]?.length ?? 0;
    if (lead > 0 && (indent === 0 || lead < indent)) indent = lead;
    if (!seqKnown && /^\s*[^\s#-][^#]*:\s*$/.test(line)) {
      const next = lines.slice(i + 1).find((l) => !/^\s*(#.*)?$/.test(l));
      const m = next ? /^( *)- /.exec(next) : null;
      if (m) {
        indentSeq = (m[1]?.length ?? 0) > lead;
        seqKnown = true;
      }
    }
  }
  return { indent: indent || 2, indentSeq, singleQuote };
}

function removeKeyIfEmpty(doc: Document, servicePath: (string | number)[]): void {
  doc.deleteIn([...servicePath, "environment"]);
}

/**
 * Modifie les variables d'environnement d'un service en conservant, autant
 * que possible, la forme du document : commentaires, ordre, indentation et
 * expressions `${...}` des autres entrées sont laissés intacts. Les deux
 * écritures Compose sont gérées (mapping et liste `CLE=valeur`) sans jamais
 * confondre l'une avec l'autre.
 *
 * Les structures qui ne peuvent pas être modifiées sans ambiguïté (alias YAML,
 * clé de fusion `<<`) sont refusées explicitement.
 */
export function editServiceEnvironment(
  text: string,
  service: string,
  set: Record<string, string>,
  unset: string[],
): string {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new ComposeEditError("unsupported_structure", "Le Compose actuel n'est pas un YAML valide.");
  }
  const services = doc.get("services", true);
  if (!isMap(services)) {
    throw new ComposeEditError("unsupported_structure", "Section « services » introuvable.");
  }
  const svc = services.get(service, true);
  if (!isMap(svc)) {
    throw new ComposeEditError("service_not_found", `Service « ${service} » introuvable.`);
  }

  const path = ["services", service];
  const current = svc.get("environment", true);
  const absent = current === undefined || current === null || (isScalar(current) && current.value === null);

  if (isAlias(current)) {
    throw new ComposeEditError("unsupported_structure", "« environment » utilise un alias YAML : modification refusée.");
  }
  if (absent && svc.has("<<")) {
    throw new ComposeEditError(
      "unsupported_structure",
      "Le service utilise une clé de fusion « << » : l'ajout d'un « environment » pourrait masquer des valeurs héritées.",
    );
  }

  if (absent) {
    if (Object.keys(set).length === 0) return text;
    svc.set("environment", doc.createNode(set));
  } else if (isMap(current)) {
    for (const [k, v] of Object.entries(set)) current.set(k, v);
    for (const k of unset) current.delete(k);
    if (current.items.length === 0) removeKeyIfEmpty(doc, path);
  } else if (isSeq(current)) {
    const keyOf = (item: unknown): string | null => {
      if (!isScalar(item) || typeof item.value !== "string") return null;
      const eq = item.value.indexOf("=");
      return eq === -1 ? item.value : item.value.slice(0, eq);
    };
    for (const [k, v] of Object.entries(set)) {
      const found = current.items.find((it) => keyOf(it) === k);
      if (found && isScalar(found)) found.value = `${k}=${v}`;
      else current.items.push(doc.createNode(`${k}=${v}`));
    }
    if (unset.length > 0) {
      current.items = current.items.filter((it) => {
        const key = keyOf(it);
        return key === null || !unset.includes(key);
      });
    }
    if (current.items.length === 0) removeKeyIfEmpty(doc, path);
  } else {
    throw new ComposeEditError("unsupported_structure", "« environment » doit être un mapping ou une liste.");
  }

  const style = detectStyle(text);
  return doc.toString({
    indent: style.indent,
    indentSeq: style.indentSeq,
    ...(style.singleQuote !== null ? { singleQuote: style.singleQuote } : {}),
    lineWidth: 0,
  });
}

/** Le service déclare-t-il un `healthcheck` ? (false aussi si le Compose est illisible ou le service absent.) */
export function composeHasHealthcheck(text: string, service: string): boolean {
  try {
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length > 0) return false;
    const services = doc.get("services", true);
    const svc = isMap(services) ? services.get(service, true) : null;
    return isMap(svc) && svc.has("healthcheck");
  } catch {
    return false;
  }
}

export interface HealthcheckSpec {
  /** Commande exécutée dans le conteneur (via `CMD-SHELL`). */
  test: string;
  interval: string;
  timeout: string;
  retries: number;
  startPeriod: string;
}

const DURATION = /^\d+(\.\d+)?(ms|s|m|h)$/;

export function validateHealthcheck(spec: HealthcheckSpec): string | null {
  if (spec.test.trim() === "" || spec.test.length > 1000) return "Commande de test invalide.";
  for (const [label, value] of [
    ["intervalle", spec.interval],
    ["délai d'expiration", spec.timeout],
    ["période de démarrage", spec.startPeriod],
  ] as const) {
    if (!DURATION.test(value)) return `Durée invalide pour ${label} (ex. 30s, 1m).`;
  }
  if (!Number.isInteger(spec.retries) || spec.retries < 1 || spec.retries > 100) return "Nombre d'essais invalide (1 à 100).";
  return null;
}

/**
 * Définit le bloc `healthcheck` d'un service en conservant la forme du reste
 * du document. Refuse les services dont la structure ne peut pas être
 * modifiée sans ambiguïté (alias, clé de fusion `<<`).
 */
export function editServiceHealthcheck(text: string, service: string, spec: HealthcheckSpec): string {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new ComposeEditError("unsupported_structure", "Le Compose actuel n'est pas un YAML valide.");
  }
  const services = doc.get("services", true);
  if (!isMap(services)) {
    throw new ComposeEditError("unsupported_structure", "Section « services » introuvable.");
  }
  const svc = services.get(service, true);
  if (!isMap(svc)) {
    throw new ComposeEditError("service_not_found", `Service « ${service} » introuvable.`);
  }
  if (isAlias(svc.get("healthcheck", true))) {
    throw new ComposeEditError("unsupported_structure", "« healthcheck » utilise un alias YAML : modification refusée.");
  }
  if (!svc.has("healthcheck") && svc.has("<<")) {
    throw new ComposeEditError(
      "unsupported_structure",
      "Le service utilise une clé de fusion « << » : l'ajout d'un « healthcheck » pourrait masquer des valeurs héritées.",
    );
  }
  svc.set(
    "healthcheck",
    doc.createNode({
      test: ["CMD-SHELL", spec.test],
      interval: spec.interval,
      timeout: spec.timeout,
      retries: spec.retries,
      start_period: spec.startPeriod,
    }),
  );
  const style = detectStyle(text);
  return doc.toString({
    indent: style.indent,
    indentSeq: style.indentSeq,
    ...(style.singleQuote !== null ? { singleQuote: style.singleQuote } : {}),
    lineWidth: 0,
  });
}

export interface BuildSpec {
  /** Dossier de construction relatif au Compose (`./build/ghost`). */
  context: string;
  /** Nom local de l'image construite. */
  image: string;
}

/**
 * Remplace l'image d'un service par une image construite localement (`build:` + `image:`), en conservant le reste du
 * document. Renvoie le Compose modifié et l'image d'origine (base du Dockerfile).
 * Refuse un service déjà construit, une image paramétrée (variables) et les structures ambiguës (alias, `<<`).
 */
export function editServiceBuild(text: string, service: string, spec: BuildSpec): { compose: string; baseImage: string } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) throw new ComposeEditError("unsupported_structure", "Le Compose actuel n'est pas un YAML valide.");
  const services = doc.get("services", true);
  if (!isMap(services)) throw new ComposeEditError("unsupported_structure", "Section « services » introuvable.");
  const svc = services.get(service, true);
  if (!isMap(svc)) throw new ComposeEditError("service_not_found", `Service « ${service} » introuvable.`);
  if (svc.has("<<")) throw new ComposeEditError("unsupported_structure", "Le service utilise une clé de fusion « << » : modification refusée.");
  if (svc.has("build")) throw new ComposeEditError("unsupported_structure", "Ce service est déjà construit localement (« build »). Modifiez son Dockerfile.");
  const image = svc.get("image", true);
  if (isAlias(image) || !isScalar(image) || typeof image.value !== "string") {
    throw new ComposeEditError("unsupported_structure", "Le service n'a pas d'« image » simple à partir de laquelle construire.");
  }
  const baseImage = image.value;
  svc.set("build", spec.context);
  svc.set("image", spec.image);
  const style = detectStyle(text);
  return {
    baseImage,
    compose: doc.toString({
      indent: style.indent,
      indentSeq: style.indentSeq,
      ...(style.singleQuote !== null ? { singleQuote: style.singleQuote } : {}),
      lineWidth: 0,
    }),
  };
}
