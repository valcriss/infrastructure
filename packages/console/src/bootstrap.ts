import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomToken, sha256 } from "./crypto.js";
import type { Pool } from "./db.js";

const BOOTSTRAP_FILE = "bootstrap-token";
const BOOTSTRAP_TTL_HOURS = 24;

/**
 * Amorçage de confiance locale du premier agent : la console dépose un
 * jeton d'enrôlement à usage unique dans un volume partagé avec l'agent
 * local. Aucun jeton universel n'est codé en dur.
 *
 * - Pas d'administrateur : rien n'est produit.
 * - Un hôte actif existe déjà : le fichier est supprimé.
 * - Sinon : un jeton neuf est généré (les anciens jetons d'amorçage non
 *   utilisés sont invalidés) et écrit avec des permissions restrictives.
 */
export async function ensureBootstrapToken(pool: Pool, sharedDir: string): Promise<void> {
  const file = join(sharedDir, BOOTSTRAP_FILE);
  const admin = await pool.query("SELECT 1 FROM admin");
  if ((admin.rowCount ?? 0) === 0) return;

  const hosts = await pool.query("SELECT 1 FROM hosts WHERE revoked_at IS NULL LIMIT 1");
  if ((hosts.rowCount ?? 0) > 0) {
    await rm(file, { force: true });
    return;
  }

  const token = randomToken(32);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM enrollment_tokens WHERE purpose = 'bootstrap' AND used_at IS NULL",
    );
    await client.query(
      `INSERT INTO enrollment_tokens (token_hash, purpose, host_name, expires_at)
       VALUES ($1, 'bootstrap', 'hôte local', now() + make_interval(hours => $2))`,
      [sha256(token), BOOTSTRAP_TTL_HOURS],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await mkdir(sharedDir, { recursive: true });
  await writeFile(file, token, { mode: 0o600 });
}

export async function removeBootstrapFile(sharedDir: string): Promise<void> {
  await rm(join(sharedDir, BOOTSTRAP_FILE), { force: true });
}
