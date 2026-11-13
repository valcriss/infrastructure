import { ref, watch, type Ref } from "vue";

// Préférences d'affichage mémorisées dans le navigateur (localStorage). Le stockage peut être absent ou refusé
// (navigation privée, données bloquées) : toute lecture ou écriture est protégée, et l'interface fonctionne sans.

type Store = Pick<Storage, "getItem" | "setItem">;

function store(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readJson<T>(key: string, fallback: T, s: Store | null = store()): T {
  try {
    const raw = s?.getItem(key);
    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown, s: Store | null = store()): void {
  try {
    s?.setItem(key, JSON.stringify(value));
  } catch {
    /* préférence non enregistrée : sans conséquence */
  }
}

/** Aide « Corriger une image : le parcours » masquée par l’utilisateur (page Images, réglage dans Affichage). */
export const GUIDE_HIDDEN_KEY = "console.guide.remediation.hidden";

/** Booléen réactif mémorisé sous `key` (par navigateur). */
export function usePersistedFlag(key: string, fallback: boolean): Ref<boolean> {
  const value = ref(readJson<unknown>(key, fallback) === true);
  watch(value, (v) => writeJson(key, v));
  return value;
}

/**
 * Ouverture automatique d'une zone repliée quand une alerte critique apparaît. `seen` est l'ensemble des alertes
 * critiques déjà connues : la zone ne se rouvre qu'une fois par alerte nouvelle, pas à chaque rafraîchissement, et
 * une alerte résolue puis revenue compte de nouveau comme nouvelle.
 */
export function criticalReopen(current: string[], seen: string[]): { reopen: boolean; seen: string[] } {
  const known = new Set(seen);
  return { reopen: current.some((id) => !known.has(id)), seen: [...new Set(current)].sort() };
}
