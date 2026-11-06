import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";

export interface SecuritySettings {
  /** Période des scans de vulnérabilités planifiés, en heures ; 0 désactive la planification. */
  scanIntervalHours: number;
  /** Période de la recherche planifiée de nouvelles versions d'images, en heures ; 0 la désactive. */
  imageCheckIntervalHours: number;
}

export const DEFAULT_SECURITY: SecuritySettings = { scanIntervalHours: 24, imageCheckIntervalHours: 24 };
const MAX_HOURS = 24 * 30;

export async function getSecuritySettings(pool: Pick<Pool, "query">): Promise<SecuritySettings> {
  const { rows } = await pool.query<{ value: Partial<SecuritySettings> }>("SELECT value FROM app_settings WHERE key = 'security'");
  return { ...DEFAULT_SECURITY, ...(rows[0]?.value ?? {}) };
}

export async function setSecuritySettings(pool: Pool, next: SecuritySettings): Promise<SecuritySettings> {
  for (const [name, v] of Object.entries(next)) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_HOURS) {
      throw new HttpError(400, "invalid_setting", `${name} doit être un entier d'heures entre 0 et ${MAX_HOURS}.`);
    }
  }
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('security', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}
