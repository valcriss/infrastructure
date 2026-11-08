import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("fermeture des comparaisons de version (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let baseUrl: string;
  let cookie = "";
  let root: string;
  let hostId = "";
  let stackId = "";
  const ids: string[] = [];

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any>, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  };
  const listed = async () => ((await call("GET", `/api/v1/stacks/${stackId}/candidate-scans`)).json.candidates as { id: string; tag: string }[]).map((c) => c.tag).sort();

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    root = mkdtempSync(join(tmpdir(), "infra-dismiss-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir: mkdtempSync(join(root, "shared-")), webDir: null, secureCookies: false, dataDir: mkdtempSync(join(root, "data-")), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    cookie = (await call("POST", "/api/v1/setup", { setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" })).cookie;
    hostId = (await pool.query<{ id: string }>("INSERT INTO hosts (name, secret_hash) VALUES ('hôte de test', 'x') RETURNING id")).rows[0]?.id as string;
    stackId = (await call("POST", "/api/v1/stacks", { name: "demo", hostId, compose: "services:\n  db:\n    image: mysql:8.0\n" })).json.id as string;
    for (const [service, tag] of [["db", "9.7"], ["db", "8.4"], ["web", "1.0"]] as const) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO candidate_scans (stack_id, service, host_id, ref, base_ref, status, error, requested_by, finished_at, cleaned_at)
         VALUES ($1, $2, $3, $4, 'x:1', 'failed', 'test', 'test', now(), now()) RETURNING id`,
        [stackId, service, hostId, `x:${tag}`],
      );
      ids.push(r.rows[0]?.id as string);
    }
  });

  afterAll(async () => {
    await built.app.close();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("liste les comparaisons, ferme une seule, puis toutes celles d'un service", async () => {
    expect(await listed()).toEqual(["1.0", "8.4", "9.7"]);
    const one = await call("POST", `/api/v1/stacks/${stackId}/candidate-scans/${ids[0]}/dismiss`);
    expect(one.json).toEqual({ dismissed: 1 });
    expect(await listed()).toEqual(["1.0", "8.4"]);
    const all = await call("POST", `/api/v1/stacks/${stackId}/services/db/candidate-scans/dismiss`);
    expect(all.json).toEqual({ dismissed: 1 });
    expect(await listed()).toEqual(["1.0"]);
  });

  it("garde le résultat en base et refuse de fermer deux fois", async () => {
    expect((await pool.query("SELECT 1 FROM candidate_scans WHERE id = $1 AND dismissed_at IS NOT NULL", [ids[0]])).rowCount).toBe(1);
    expect((await call("POST", `/api/v1/stacks/${stackId}/candidate-scans/${ids[0]}/dismiss`)).status).toBe(404);
  });
});
