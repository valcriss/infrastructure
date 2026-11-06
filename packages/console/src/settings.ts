import type { SeverityCounts } from "@infra/shared";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";

export interface SecuritySettings {
  /** Période des scans de vulnérabilités planifiés, en heures ; 0 désactive la planification. */
  scanIntervalHours: number;
  /** Période de la recherche planifiée de nouvelles versions d'images, en heures ; 0 la désactive. */
  imageCheckIntervalHours: number;
  /** Gravité minimale des vulnérabilités signalées (comptées, affichées, alertes). Les scans, eux, restent complets. */
  minSeverity: MinSeverity;
  /** Les vulnérabilités de gravité « inconnue » sont-elles signalées ? */
  includeUnknown: boolean;
}

export const MIN_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type MinSeverity = (typeof MIN_SEVERITIES)[number];

export const DEFAULT_SECURITY: SecuritySettings = { scanIntervalHours: 24, imageCheckIntervalHours: 24, minSeverity: "LOW", includeUnknown: true };

const RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/** Une vulnérabilité de cette gravité est-elle signalée avec ces réglages ? */
export function isReported(severity: string, s: Pick<SecuritySettings, "minSeverity" | "includeUnknown">): boolean {
  if (severity === "UNKNOWN") return s.includeUnknown;
  return (RANK[severity] ?? 0) >= (RANK[s.minSeverity] ?? 1);
}

/** Compteurs d'un scan restreints aux gravités signalées (les autres passent à 0) ; `hidden` = nombre de résultats masqués. */
export function reportedCounts(counts: SeverityCounts | null, s: Pick<SecuritySettings, "minSeverity" | "includeUnknown">): { counts: SeverityCounts; total: number; hidden: number } | null {
  if (!counts) return null;
  const out: SeverityCounts = {
    critical: isReported("CRITICAL", s) ? counts.critical : 0,
    high: isReported("HIGH", s) ? counts.high : 0,
    medium: isReported("MEDIUM", s) ? counts.medium : 0,
    low: isReported("LOW", s) ? counts.low : 0,
    unknown: isReported("UNKNOWN", s) ? counts.unknown : 0,
  };
  const total = out.critical + out.high + out.medium + out.low + out.unknown;
  const all = counts.critical + counts.high + counts.medium + counts.low + counts.unknown;
  return { counts: out, total, hidden: all - total };
}
const MAX_HOURS = 24 * 30;

export async function getSecuritySettings(pool: Pick<Pool, "query">): Promise<SecuritySettings> {
  const { rows } = await pool.query<{ value: Partial<SecuritySettings> }>("SELECT value FROM app_settings WHERE key = 'security'");
  return { ...DEFAULT_SECURITY, ...(rows[0]?.value ?? {}) };
}

export async function setSecuritySettings(pool: Pool, next: SecuritySettings): Promise<SecuritySettings> {
  for (const name of ["scanIntervalHours", "imageCheckIntervalHours"] as const) {
    const v = next[name];
    if (!Number.isInteger(v) || v < 0 || v > MAX_HOURS) {
      throw new HttpError(400, "invalid_setting", `${name} doit être un entier d'heures entre 0 et ${MAX_HOURS}.`);
    }
  }
  if (!MIN_SEVERITIES.includes(next.minSeverity)) throw new HttpError(400, "invalid_setting", "minSeverity doit être LOW, MEDIUM, HIGH ou CRITICAL.");
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('security', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}
