import type { ImageRef } from "./image-ref.js";
import { parseTag } from "./image-tags.js";
import type { Platform, RegistryClient } from "./registry.js";

/** Ce dont la vérification d'ancienneté a besoin du registre (substituable dans les tests). */
export interface DateClient {
  resolvePlatform: RegistryClient["resolvePlatform"];
  configCreated?: RegistryClient["configCreated"];
}

export interface DropResult {
  /** Candidats conservés, dans l'ordre reçu. */
  kept: string[];
  /** Candidats plus anciens que l'image actuelle (la numérotation a changé de schéma) : écartés. */
  older: string[];
  /** Sauts de version suspects écartés faute de date : à saisir à la main si besoin. */
  suspicious: string[];
  /** Vrai quand les dates des images ont pu être comparées. */
  checked: boolean;
  notes: string[];
}

const TTL_MS = 30 * 60_000;
const BUDGET_MS = 8_000;
const caches = new WeakMap<object, Map<string, { at: number; value: number | null }>>();

/** Date de création (ms) de l'image d'un tag pour une plateforme ; null si indéterminable. Mise en cache brièvement. */
async function createdOf(client: DateClient, ref: ImageRef, tag: string, platform: Platform): Promise<number | null> {
  const cache = caches.get(client) ?? new Map();
  caches.set(client, cache);
  const key = `${ref.registry}/${ref.repository}:${tag}|${platform.os}/${platform.arch}/${platform.variant ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: number | null;
  try {
    const resolved = await client.resolvePlatform(ref, tag, platform);
    value = resolved.configDigest && client.configCreated ? await client.configCreated(ref, resolved.configDigest) : null;
  } catch {
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Saut de version majeur incohérent (5 → 20) : signe probable d'un autre schéma de numérotation. */
export function suspiciousJump(current: string, candidate: string): boolean {
  const a = parseTag(current)?.nums[0];
  const b = parseTag(candidate)?.nums[0];
  return a !== undefined && b !== undefined && b - a >= 5 && b >= 2 * Math.max(a, 1);
}

/**
 * Écarte les versions proposées qui sont en réalité plus anciennes que l'image actuelle. Les nombres d'un tag ne disent
 * rien de son âge quand le schéma de numérotation a changé (`5.3.0` → `20.04.1` est un retour en arrière) : on compare la
 * date de création des images dans le registre. Sans date exploitable, on retire seulement les sauts de version suspects.
 * Ne lève jamais : en cas de doute, la liste est conservée.
 */
export async function dropOlder(client: DateClient, ref: ImageRef, currentTag: string, candidates: string[], platform: Platform | null): Promise<DropResult> {
  const result: DropResult = { kept: [...candidates], older: [], suspicious: [], checked: false, notes: [] };
  if (candidates.length === 0) return result;

  const deadline = Date.now() + BUDGET_MS;
  const current = platform && client.configCreated ? await createdOf(client, ref, currentTag, platform) : null;
  if (platform && current !== null) {
    result.checked = true;
    const kept: string[] = [];
    const unknown: string[] = [];
    for (const tag of candidates) {
      const created = Date.now() < deadline ? await createdOf(client, ref, tag, platform) : null;
      if (created !== null && created < current) result.older.push(tag);
      else {
        kept.push(tag);
        if (created === null) unknown.push(tag);
      }
    }
    result.kept = kept;
    if (result.older.length > 0) {
      result.notes.push(`${result.older.length} version(s) écartée(s) car plus ancienne(s) que l'image actuelle (numérotation changée) : ${result.older.join(", ")}.`);
    }
    if (unknown.length > 0) result.notes.push(`Date de création indisponible pour : ${unknown.join(", ")} (ancienneté non vérifiée).`);
    return result;
  }

  // Dates indisponibles : seul le saut de version incohérent est écarté.
  result.kept = candidates.filter((t) => !suspiciousJump(currentTag, t));
  result.suspicious = candidates.filter((t) => suspiciousJump(currentTag, t));
  result.notes.push(
    result.suspicious.length > 0
      ? `Date des images indisponible : ${result.suspicious.join(", ")} écartée(s) (saut de version suspect depuis ${currentTag}) ; saisissez l'étiquette si elle est voulue.`
      : "Date des images indisponible : l'ancienneté des versions proposées n'a pas pu être vérifiée.",
  );
  return result;
}
