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
function detectStyle(text: string): { indent: number; indentSeq: boolean; singleQuote: boolean | null } {
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
