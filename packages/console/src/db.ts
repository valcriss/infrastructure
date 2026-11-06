import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
// Verrou consultatif : évite deux migrations simultanées.
const MIGRATION_LOCK_ID = 727001;

export async function migrate(pool: Pool, log: (msg: string) => void = () => {}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`migration appliquée : ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

export async function audit(
  pool: Pick<pg.Pool, "query">,
  actor: string,
  action: string,
  target: string | null,
  result: "success" | "failure",
): Promise<void> {
  await pool.query(
    "INSERT INTO audit_events (actor, action, target, result) VALUES ($1, $2, $3, $4)",
    [actor, action, target, result],
  );
}
