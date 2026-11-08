import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;
const compose = (tag: string) => `services:\n  db:\n    image: mysql:${tag}\n`;

describe.skipIf(!url)("abandon de révision et versions ignorées (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let baseUrl: string;
  let cookie = "";
  let root: string;
  let hostId = "";
  let stackId = "";

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any>, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  };
  const stack = async () => (await pool.query<{ current_revision: number; deployed_revision: number | null }>("SELECT current_revision, deployed_revision FROM stacks WHERE id = $1", [stackId])).rows[0] as { current_revision: number; deployed_revision: number | null };

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    root = mkdtempSync(join(tmpdir(), "infra-abandon-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir: mkdtempSync(join(root, "shared-")), webDir: null, secureCookies: false, dataDir: mkdtempSync(join(root, "data-")), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    cookie = (await call("POST", "/api/v1/setup", { setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" })).cookie;
    const host = await pool.query<{ id: string }>("INSERT INTO hosts (name, secret_hash) VALUES ('hôte de test', 'x') RETURNING id");
    hostId = host.rows[0]?.id as string;
    stackId = (await call("POST", "/api/v1/stacks", { name: "demo", hostId, compose: compose("8.0") })).json.id as string;
    // r2 (mysql 8.4, déployée) puis r3 (mysql 9.0, incompatible avec les données)
    await call("PUT", `/api/v1/stacks/${stackId}/compose`, { expectedRevision: 1, compose: compose("8.4") });
    await call("PUT", `/api/v1/stacks/${stackId}/compose`, { expectedRevision: 2, compose: compose("9.0") });
    await pool.query("UPDATE stacks SET deployed_revision = 2 WHERE id = $1", [stackId]);
  });

  afterAll(async () => {
    await built.app.close();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuse d'abandonner la révision en service", async () => {
    const r = await call("POST", `/api/v1/stacks/${stackId}/revisions/2/abandon`, {});
    expect(r.status).toBe(409);
    expect(r.json.error?.code ?? r.json.code).toBe("revision_deployed");
  });

  it("abandonne la révision courante et repart du contenu en service", async () => {
    const r = await call("POST", `/api/v1/stacks/${stackId}/revisions/3/abandon`, { reason: "MySQL 9.0 incompatible" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ abandoned: 3, revision: 4, restoredFrom: 2 });
    expect(await stack()).toEqual({ current_revision: 4, deployed_revision: 4 });
    const list = (await call("GET", `/api/v1/stacks/${stackId}/revisions`)).json.revisions as { revision: number; abandoned: { reason: string } | null; message: string }[];
    expect(list.map((x) => x.revision)).toEqual([4, 3, 2, 1]);
    expect(list.find((x) => x.revision === 3)?.abandoned?.reason).toBe("MySQL 9.0 incompatible");
    expect(list.find((x) => x.revision === 4)?.message).toContain("Retour à la révision 2");
    const four = (await call("GET", `/api/v1/stacks/${stackId}/revisions/4`)).json;
    expect(four.compose).toBe(compose("8.4"));
    expect(four.abandoned).toBeNull();
  });

  it("refuse un second abandon et permet de rétablir", async () => {
    expect((await call("POST", `/api/v1/stacks/${stackId}/revisions/3/abandon`, {})).status).toBe(409);
    expect((await call("POST", `/api/v1/stacks/${stackId}/revisions/3/restore`)).status).toBe(200);
    expect((await call("GET", `/api/v1/stacks/${stackId}/revisions/3`)).json.abandoned).toBeNull();
    expect((await call("POST", `/api/v1/stacks/${stackId}/revisions/3/restore`)).status).toBe(409);
  });

  it("abandonne une ancienne révision sans créer de révision", async () => {
    const r = await call("POST", `/api/v1/stacks/${stackId}/revisions/1/abandon`, {});
    expect(r.json).toMatchObject({ abandoned: 1, revision: null });
    expect((await stack()).current_revision).toBe(4);
  });

  it("répond 404 pour une révision inconnue", async () => {
    expect((await call("POST", `/api/v1/stacks/${stackId}/revisions/99/abandon`, {})).status).toBe(404);
  });

  describe("versions d'image ignorées", () => {
    const detail = { ref: "mysql:8.4", registry: "docker.io", repository: "library/mysql", tag: "8.4", deployedDigest: null, remoteDigest: null, platform: "", contentChanged: false, candidates: ["9.0", "9.1"], uncertain: false, tagsTruncated: false, policy: "minor", pattern: null, notes: [] };

    beforeAll(async () => {
      await pool.query(
        "INSERT INTO image_checks (stack_id, service, checked_at, status, kind, detail, last_success_at) VALUES ($1, 'db', now(), 'ok', 'update_available', $2, now())",
        [stackId, JSON.stringify(detail)],
      );
    });

    const check = async () => {
      const row = await pool.query<{ kind: string; detail: { candidates: string[]; ignored?: string[] } }>("SELECT kind, detail FROM image_checks WHERE stack_id = $1 AND service = 'db'", [stackId]);
      return row.rows[0] as { kind: string; detail: { candidates: string[]; ignored?: string[] } };
    };

    it("n'écarte que la version choisie et garde la mise à jour tant qu'il en reste", async () => {
      const r = await call("POST", `/api/v1/stacks/${stackId}/services/db/ignored-tags`, { tag: "9.0", reason: "incompatible" });
      expect(r.status).toBe(201);
      const c = await check();
      expect(c.kind).toBe("update_available");
      expect(c.detail.candidates).toEqual(["9.1"]);
      expect(c.detail.ignored).toEqual(["9.0"]);
    });

    it("repasse à « à jour » quand toutes les versions sont écartées", async () => {
      await call("POST", `/api/v1/stacks/${stackId}/services/db/ignored-tags`, { tag: "9.1" });
      expect((await check()).kind).toBe("up_to_date");
    });

    it("liste les versions ignorées, puis les propose de nouveau", async () => {
      const list = (await call("GET", `/api/v1/stacks/${stackId}/images`)).json;
      expect(list.components ?? []).toBeDefined();
      const rows = await pool.query("SELECT tag, reason FROM image_ignored_tags WHERE stack_id = $1 ORDER BY tag", [stackId]);
      expect(rows.rows.map((x) => x.tag)).toEqual(["9.0", "9.1"]);
      expect((await call("DELETE", `/api/v1/stacks/${stackId}/services/db/ignored-tags/9.0`)).status).toBe(204);
      expect((await call("DELETE", `/api/v1/stacks/${stackId}/services/db/ignored-tags/9.0`)).status).toBe(404);
    });
  });
});
