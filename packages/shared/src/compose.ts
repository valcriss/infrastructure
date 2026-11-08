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

// Dossier de construction d'une image personnalisée : un sous-dossier de « build/ » du Compose, jamais en dehors.
const BUILD_PATH = /^(?:\.\/)?build\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/;
const SIMPLE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const noParent = (p: string): boolean => !p.split("/").includes("..");

/** Pourquoi ce « build » n'est pas accepté (null s'il l'est). Seule la forme générée par la console passe. */
function buildProblem(value: unknown): string | null {
  const v = value as { value?: unknown; items?: Pair[] } | null;
  const text = (n: unknown): string | null => (isScalar(n) && typeof n.value === "string" ? n.value : null);
  const wrongContext = "le dossier de construction doit être un sous-dossier de « build/ » (ex. ./build/mon-service).";
  const asString = text(v);
  if (asString !== null) return BUILD_PATH.test(asString) && noParent(asString) ? null : wrongContext;
  if (!isMap(value)) return wrongContext;
  for (const pair of value.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : "";
    if (key === "context") {
      const ctx = text(pair.value);
      if (ctx === null || !BUILD_PATH.test(ctx) || !noParent(ctx)) return wrongContext;
    } else if (key === "dockerfile") {
      const f = text(pair.value);
      if (f === null || !SIMPLE_PATH.test(f) || !noParent(f)) return "« dockerfile » doit être un chemin relatif simple.";
    } else if (key !== "args" && key !== "target") {
      return `l'option « build.${key} » n'est pas supportée (contextes externes, secrets, SSH…).`;
    }
  }
  return value.items.some((p) => isScalar(p.key) && p.key.value === "context") ? null : wrongContext;
}

/**
 * Validation syntaxique et de périmètre du Compose. La validation complète du
 * modèle Compose est faite par `docker compose config` sur l'hôte, avant tout
 * changement de conteneur. Ici : YAML valide et fonctionnalités du MVP.
 *
 * Fonctionnalités rejetées explicitement (jamais appliquées partiellement) :
 * `include`, et `build` hors de la forme d'image personnalisée générée par la console
 * (dossier « build/<service> » du Compose, sans contexte externe ni secrets).
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
        const problem = buildProblem(build.value);
        if (problem) issues.push(at(build.key as Node, `« build » non supporté (service « ${name} ») : ${problem}`));
        else if (!props.has("image")) issues.push(at(svc.key as Node, `Le service « ${name} » construit localement doit aussi définir « image » (nom de l'image construite).`));
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
