/** Règles communes sur les stacks, partagées par la console, l'agent et l'interface. */

export const MAX_COMPOSE_BYTES = 256 * 1024;
export const MAX_FILES_TOTAL_BYTES = 512 * 1024;
export const MAX_FILE_COUNT = 100;
export const MAX_VARIABLES = 200;
export const MAX_VARIABLE_VALUE_BYTES = 8 * 1024;

/** Noms de projet Compose : minuscules, chiffres, tiret et tiret bas. */
const STACK_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Noms réservés : projets de la console elle-même (cf. project.md §14). */
export const RESERVED_STACK_NAMES = ["console-docker", "console-docker-agent"];

export function validateStackName(name: string): string | null {
  if (!STACK_NAME.test(name)) {
    return "Nom invalide : minuscules, chiffres, « - » et « _ » ; 63 caractères maximum ; commence par une lettre ou un chiffre.";
  }
  if (RESERVED_STACK_NAMES.includes(name)) return "Nom réservé à la console.";
  return null;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function validateVariableName(name: string): string | null {
  return VARIABLE_NAME.test(name) ? null : "Nom de variable invalide (lettres, chiffres et « _ »).";
}

export function validateVariableValue(value: string): string | null {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    return "Une valeur ne peut pas contenir de saut de ligne ni de caractère nul.";
  }
  if (new TextEncoder().encode(value).length > MAX_VARIABLE_VALUE_BYTES) {
    return "Valeur trop longue.";
  }
  return null;
}

/** Fichiers réservés, écrits par la console ou par l'agent. */
const RESERVED_FILES = new Set(["compose.yaml", ".env", ".managed.json"]);

/**
 * Chemin relatif d'un fichier associé : pas de chemin absolu, de `..`, de
 * séparateur Windows, de segment vide ou caché de gestion. La protection
 * contre les liens symboliques est refaite côté agent à l'écriture.
 */
export function validateFilePath(path: string): string | null {
  if (path.length === 0 || path.length > 200) return "Chemin vide ou trop long.";
  if (path.includes("\0") || path.includes("\\")) return "Caractère interdit dans le chemin.";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "Le chemin doit être relatif.";
  const segments = path.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return "Segment de chemin interdit.";
  }
  if (RESERVED_FILES.has(path)) return "Nom de fichier réservé.";
  return null;
}

/**
 * Masque dans un texte les valeurs sensibles connues. Ne remplace pas les
 * valeurs trop courtes pour éviter de défigurer la sortie.
 */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join("***");
  }
  return out;
}
