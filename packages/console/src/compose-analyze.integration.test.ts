import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;
const NL = String.fromCharCode(10);

const COMPOSE = `services:
  web:
    image: nginx
    ports:
      - "\${PUBLIC_PORT:-8080}:80"
    environment:
      API_TOKEN: \${API_TOKEN}
`;

describe.skipIf(!url)("analyse d'un Compose avant enregistrement (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let baseUrl: string;
  let cookie = "";
  let root: string;
  let hostId = "";

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, { method, headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any>, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  };

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    root = mkdtempSync(join(tmpdir(), "infra-analyze-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir: mkdtempSync(join(root, "shared-")), webDir: null, secureCookies: false, dataDir: mkdtempSync(join(root, "data-")), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    cookie = (await call("POST", "/api/v1/setup", { setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" })).cookie;
    const inventory = [{ id: "a".repeat(64), names: ["demo-web-1"], image: "nginx", composeProject: "demo", composeService: "web", ports: [{ privatePort: 80, publicPort: 8443, type: "tcp" }], mounts: [] }];
    const host = await pool.query<{ id: string }>("INSERT INTO hosts (name, secret_hash, inventory) VALUES ('hôte de test', 'x', $1) RETURNING id", [JSON.stringify(inventory)]);
    hostId = host.rows[0]?.id as string;
  });

  afterAll(async () => {
    await built.app.close();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("exige une session", async () => {
    const res = await fetch(`${baseUrl}/api/v1/compose/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ compose: COMPOSE }) });
    expect(res.status).toBe(401);
  });

  it("renvoie les erreurs avec leur ligne pour un Compose invalide", async () => {
    const r = await call("POST", "/api/v1/compose/analyze", { compose: "services:\n  web:\n    image: [" });
    expect(r.status).toBe(200);
    expect(r.json.valid).toBe(false);
    expect(r.json.issues[0].line).toBeGreaterThan(0);
  });

  it("détecte les variables obligatoires, par défaut et secrètes", async () => {
    const r = await call("POST", "/api/v1/compose/analyze", { compose: COMPOSE });
    expect(r.json.valid).toBe(true);
    const byName = Object.fromEntries((r.json.variables as { name: string }[]).map((v) => [v.name, v]));
    expect(byName.PUBLIC_PORT).toMatchObject({ required: false, defaultValue: "8080" });
    expect(byName.API_TOKEN).toMatchObject({ required: true, secret: true });
    expect(r.json.differences).toBeNull();
  });

  it("compare avec un projet observé (port publié différent)", async () => {
    const r = await call("POST", "/api/v1/compose/analyze", { compose: COMPOSE, hostId, project: "demo" });
    const messages = (r.json.differences as { message: string }[]).map((d) => d.message).join("\n");
    expect(messages).toContain("8443");
    expect(messages).toContain("8080");
  });

  it("nettoie un Compose (commentaires, version, lignes vides)", async () => {
    const input = ["# c", 'version: "3"', "services:", "  a:", "    image: x # t", "  b:", "    image: y", ""].join(NL);
    const r = await call("POST", "/api/v1/compose/clean", { compose: input });
    expect(r.status).toBe(200);
    expect(r.json.compose).toBe(["services:", "  a:", "    image: x", "", "  b:", "    image: y", ""].join(NL));
    expect(r.json).toMatchObject({ comments: 2, versionRemoved: "3", changed: true });
    expect((await call("POST", "/api/v1/compose/clean", { compose: "services: [" })).status).toBe(422);
  });

  it("répond 404 pour un hôte inconnu", async () => {
    const r = await call("POST", "/api/v1/compose/analyze", { compose: COMPOSE, hostId: "00000000-0000-4000-8000-000000000000", project: "demo" });
    expect(r.status).toBe(404);
  });
});
