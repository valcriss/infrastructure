import { parse } from "yaml";
import { parseImageRef } from "./image-ref.js";

/** Remplace `${VAR}`, `${VAR:-défaut}`, `${VAR-défaut}` et `$VAR` ; une variable inconnue sans défaut laisse la référence inexploitable. */
function interpolate(text: string, variables: Record<string, string>): string {
  return text.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g, (whole, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? "";
    const v = variables[name];
    if (v !== undefined && v !== "") return v;
    return fallback ?? whole;
  });
}

const DOCKERFILE_NAME = /(^|\/)[^/]*dockerfile[^/]*$/i;

/**
 * Références d'images à télécharger ou à construire pour une révision : `image:` de chaque service (variables
 * interpolées) et lignes `FROM` des Dockerfiles joints. Meilleur effort : une référence illisible est ignorée.
 */
export function collectImageRefs(compose: string, variables: Record<string, string>, files: Record<string, string>): string[] {
  const refs = new Set<string>();
  try {
    const doc = parse(compose) as { services?: Record<string, { image?: unknown }> } | null;
    for (const svc of Object.values(doc?.services ?? {})) {
      if (typeof svc?.image === "string") refs.add(interpolate(svc.image, variables).trim());
    }
  } catch {
    /* Compose illisible : la validation l'aura déjà signalé */
  }
  for (const [path, content] of Object.entries(files)) {
    if (!DOCKERFILE_NAME.test(path)) continue;
    for (const m of content.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)) refs.add(interpolate(m[1] as string, variables).trim());
  }
  return [...refs].filter((r) => r && r !== "scratch" && !r.includes("$"));
}

/** Registres (noms canoniques) des références d'images ; Docker Hub est `docker.io`. */
export function registriesOf(refs: string[]): Set<string> {
  const out = new Set<string>();
  for (const r of refs) {
    const parsed = parseImageRef(r);
    if (parsed) out.add(parsed.registry);
  }
  return out;
}
