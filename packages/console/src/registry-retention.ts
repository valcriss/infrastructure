import { z } from "zod";
import type { Pool } from "./db.js";

/** `off` : rien n'est signalé ; `propose` : les images à nettoyer sont signalées, un administrateur confirme ; `auto` : la console les supprime. */
export const RETENTION_MODES = ["off", "propose", "auto"] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];

export interface RetentionSettings {
  mode: RetentionMode;
  /** Images corrigées conservées par dépôt (les plus récentes) ; le reste est proposé à la suppression. */
  keepPerRepository: number;
  /** Nombre maximal d'images supprimées par passage (sécurité). */
  maxDeletesPerPass: number;
}

export const DEFAULT_RETENTION: RetentionSettings = { mode: "propose", keepPerRepository: 3, maxDeletesPerPass: 10 };

export const RetentionBody = z.object({
  mode: z.enum(RETENTION_MODES),
  keepPerRepository: z.number().int().min(1).max(50),
  maxDeletesPerPass: z.number().int().min(1).max(50),
});

export async function getRetentionSettings(pool: Pick<Pool, "query">): Promise<RetentionSettings> {
  const { rows } = await pool.query<{ value: Partial<RetentionSettings> }>("SELECT value FROM app_settings WHERE key = 'registry_retention'");
  return { ...DEFAULT_RETENTION, ...(rows[0]?.value ?? {}) };
}

export async function setRetentionSettings(pool: Pool, next: RetentionSettings): Promise<RetentionSettings> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('registry_retention', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}

/** Ce que la règle de rétention dit d'une image. */
export interface RetentionMark {
  /** À supprimer d'après la règle ET supprimable sans risque (aucune protection, aucune révision ancienne). */
  candidate: boolean;
  reason: string | null;
}

/** Vue minimale d'une image pour calculer la rétention (sous-ensemble de `RegistryImage`). */
export interface RetentionInput {
  digest: string;
  kind: "patched" | "source" | "other";
  createdAt: string | null;
  sourceDigest: string | null;
  deletable: boolean;
  history: unknown[];
}

/**
 * Règle de rétention d'un dépôt géré : les N images corrigées les plus récentes sont conservées ; au-delà, une image est
 * candidate si elle est supprimable sans risque. Une copie source n'est candidate que si aucune image corrigée conservée
 * (ou protégée) n'en provient. Les images inconnues de la console (sans correctif d'origine) ne sont jamais candidates.
 */
export function markRetention(images: RetentionInput[], settings: Pick<RetentionSettings, "mode" | "keepPerRepository">): Map<string, RetentionMark> {
  const marks = new Map<string, RetentionMark>();
  const none: RetentionMark = { candidate: false, reason: null };
  for (const img of images) marks.set(img.digest, none);
  if (settings.mode === "off") return marks;

  const safe = (i: RetentionInput): boolean => i.deletable && i.history.length === 0;
  const patched = images.filter((i) => i.kind === "patched").sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "") || 0);
  const beyond = patched.slice(settings.keepPerRepository);
  const candidates = new Set<string>();
  for (const img of beyond) {
    if (safe(img)) {
      candidates.add(img.digest);
      marks.set(img.digest, { candidate: true, reason: `Au-delà des ${settings.keepPerRepository} correctifs les plus récents de ce dépôt.` });
    }
  }
  // Une copie source reste utile tant qu'une image corrigée non supprimée en provient.
  for (const img of images.filter((i) => i.kind === "source")) {
    const needed = patched.some((p) => p.sourceDigest === img.digest && !candidates.has(p.digest));
    if (!needed && safe(img) && patched.some((p) => p.sourceDigest === img.digest)) {
      marks.set(img.digest, { candidate: true, reason: "Copie source dont aucune image corrigée conservée ne provient." });
    }
  }
  return marks;
}
