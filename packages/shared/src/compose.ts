import { LineCounter, isMap, isScalar, parse, parseDocument } from "yaml";
import type { Node, Pair } from "yaml";
import { MAX_COMPOSE_BYTES } from "./stack.js";

export interface ComposeIssue {
  message: string;
  line?: number;
  column?: number;
}

export type ComposeValidation =
  | { ok: true; services: string[] }
  | { ok: false; issues: ComposeIssue[] };

/**
 * Validation syntaxique et de périmètre du Compose. La validation complète du
 * modèle Compose est faite par `docker compose config` sur l'hôte, avant tout
 * changement de conteneur. Ici : YAML valide et fonctionnalités du MVP.
 *
 * Fonctionnalités rejetées explicitement (jamais appliquées partiellement) :
 * `build` (images préconstruites uniquement) et `include`.
 */
export function validateCompose(text: string): ComposeValidation {
  if (new TextEncoder().encode(text).length > MAX_COMPOSE_BYTES) {
    return { ok: false, issues: [{ message: "Le fichier Compose est trop volumineux." }] };
  }
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((e) => ({
        // La position est fournie à part : on retire le « at line N, column M: » de la bibliothèque.
        message: (e.message.split("\n")[0] ?? e.message).replace(/\s+at line \d+, column \d+:?$/, ""),
        ...(e.linePos?.[0] ? { line: e.linePos[0].line, column: e.linePos[0].col } : {}),
      })),
    };
  }

  const issues: ComposeIssue[] = [];
  const at = (node: Node | null | undefined, message: string): ComposeIssue => {
    const offset = node?.range?.[0];
    const pos = offset === undefined ? undefined : lc.linePos(offset);
    return { message, ...(pos ? { line: pos.line, column: pos.col } : {}) };
  };
  const keyOf = (p: Pair): string | null => (isScalar(p.key) ? String(p.key.value) : null);

  const root = doc.contents;
  if (!isMap(root)) {
    return { ok: false, issues: [at(root as Node | null, "Le document Compose doit être un mapping YAML.")] };
  }

  const services: string[] = [];
  let servicesNode: Node | null = null;
  for (const pair of root.items) {
    const key = keyOf(pair);
    if (key === "include") {
      issues.push(at(pair.key as Node, "« include » n'est pas supporté dans cette version."));
    }
    if (key === "services") servicesNode = pair.value as Node | null;
  }

  if (!isMap(servicesNode) || servicesNode.items.length === 0) {
    issues.push(at(servicesNode ?? root, "Au moins un service est requis sous « services »."));
  } else {
    for (const svc of servicesNode.items) {
      const name = keyOf(svc);
      if (name === null) continue;
      services.push(name);
      if (!isMap(svc.value)) {
        issues.push(at(svc.key as Node, `Le service « ${name} » doit être un mapping.`));
        continue;
      }
      const props = new Map(svc.value.items.map((p) => [keyOf(p), p]));
      const build = props.get("build");
      if (build) {
        issues.push(at(build.key as Node, `« build » n'est pas supporté (service « ${name} ») : utilisez une image préconstruite.`));
      } else if (!props.has("image")) {
        issues.push(at(svc.key as Node, `Le service « ${name} » doit définir « image ».`));
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, services };
}

export interface ComposeService {
  name: string;
  /** Service sous un « profile » : non démarré par défaut, son absence n'est pas une anomalie. */
  optional: boolean;
}

/** Services déclarés par un Compose (liste vide si le YAML est invalide). */
export function listComposeServices(text: string): ComposeService[] {
  try {
    const doc = parse(text, { maxAliasCount: 100 }) as { services?: Record<string, { profiles?: unknown } | null> } | null;
    if (!doc || typeof doc !== "object" || !doc.services || typeof doc.services !== "object") return [];
    return Object.entries(doc.services).map(([name, svc]) => ({
      name,
      optional: Array.isArray(svc?.profiles) && svc.profiles.length > 0,
    }));
  } catch {
    return [];
  }
}
