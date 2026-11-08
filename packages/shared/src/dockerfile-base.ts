import { parse } from "yaml";

/** Chemin relatif normalisé (`./a/../b/x` → `b/x`) ; null s'il sort du dossier de départ. */
function normalizeRelative(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** Image de base (instruction FROM) d'un service construit sur l'hôte, avec l'emplacement à modifier pour la changer. */
export interface ServiceBase {
  ref: string;
  /** Chemin du Dockerfile parmi les fichiers de la stack (`build/ghost/Dockerfile`). */
  path: string;
  /** Ligne (à partir de 0) de l'instruction FROM dans ce Dockerfile. */
  line: number;
}

const FROM = /^\s*FROM\s+((?:--\S+\s+)*)(\S+)(?:\s+AS\s+(\S+))?\s*$/i;

/**
 * Image de base unique d'un Dockerfile. Les étapes qui partent d'une étape précédente ou de `scratch` ne comptent pas.
 * Refus expliqué quand le suivi n'est pas possible (plusieurs images externes, image paramétrée par ARG).
 */
export function parseBaseImage(dockerfile: string): { ref: string; line: number } | { error: string } {
  const stages = new Set<string>();
  const externals: { ref: string; line: number }[] = [];
  dockerfile.split("\n").forEach((text, line) => {
    const m = FROM.exec(text.replace(/\r$/, ""));
    if (!m) return;
    const image = m[2] as string;
    if (!stages.has(image.toLowerCase()) && image.toLowerCase() !== "scratch") externals.push({ ref: image, line });
    if (m[3]) stages.add(m[3].toLowerCase());
  });
  if (externals.length === 0) return { error: "Aucune image de base externe dans ce Dockerfile." };
  if (externals.length > 1) return { error: "Plusieurs images de base (construction en plusieurs étapes) : suivi impossible." };
  const only = externals[0] as { ref: string; line: number };
  if (only.ref.includes("$")) return { error: "L'image de base est paramétrée (ARG ou variable) : suivi impossible." };
  return only;
}

/** Remplace l'image de base à la ligne donnée en conservant les options (`--platform=…`) et l'alias (`AS …`). */
export function replaceBaseImage(dockerfile: string, line: number, newRef: string): string {
  const lines = dockerfile.split("\n");
  lines[line] = (lines[line] ?? "").replace(/^(\s*FROM\s+(?:--\S+\s+)*)\S+/i, (_m, head: string) => `${head}${newRef}`);
  return lines.join("\n");
}

/** Chemin du Dockerfile d'un service construit, d'après son `build:` ; null si le service n'est pas construit. */
function buildFilePath(compose: string, service: string): { path: string } | { error: string } | null {
  let doc: { services?: Record<string, { build?: unknown } | null> } | null;
  try {
    doc = parse(compose, { maxAliasCount: 100 }) as typeof doc;
  } catch {
    return null;
  }
  const build = doc?.services?.[service]?.build;
  if (build === undefined || build === null) return null;
  let context = ".";
  let file = "Dockerfile";
  if (typeof build === "string") context = build;
  else if (typeof build === "object") {
    const b = build as { context?: unknown; dockerfile?: unknown };
    if (typeof b.context === "string") context = b.context;
    if (typeof b.dockerfile === "string") file = b.dockerfile;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(context) || context.startsWith("/") || context.includes("$")) {
    return { error: "Le contexte de construction n'est pas un dossier de la stack : suivi impossible." };
  }
  const path = file.startsWith("/") ? null : normalizeRelative(`${context}/${file}`);
  if (!path) return { error: "Le Dockerfile est hors du dossier de la stack : suivi impossible." };
  return { path };
}

/**
 * Image de base d'un service construit sur l'hôte (Dockerfile joint à la révision). `null` si le service n'est pas
 * construit ; `{ error }` quand il l'est mais que son image de base ne peut pas être suivie.
 */
export function serviceBaseImage(compose: string, files: Record<string, string>, service: string): ServiceBase | { error: string } | null {
  const located = buildFilePath(compose, service);
  if (located === null) return null;
  if ("error" in located) return located;
  const content = files[located.path];
  if (content === undefined) return { error: `Dockerfile « ${located.path} » introuvable dans les fichiers de la stack.` };
  const base = parseBaseImage(content);
  if ("error" in base) return base;
  return { ref: base.ref, path: located.path, line: base.line };
}
