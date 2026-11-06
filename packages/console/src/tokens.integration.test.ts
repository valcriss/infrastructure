import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { ROUTE_DOCS } from "./openapi.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;

const COMPOSE = `# Application de test
services:
  web:
    image: nginx:1.27
    environment:
      # niveau de logs
      LOG_LEVEL: info
      URL: http://\${HOST_NAME}/
  db:
    image: postgres:17
`;

describe.skipIf(!url)("jetons API et variables par service (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let baseUrl: string;
  let cookie = "";
  let hostId = "";

  const call = async (method: string, path: string, opts: { body?: unknown; bearer?: string; session?: boolean } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.session) headers.cookie = cookie;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(baseUrl + path, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };

  const newToken = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/v1/api-tokens", { session: true, body: { name, ...extra } });
    expect(r.status).toBe(201);
    return r.json as { id: string; token: string };
  };

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    sharedDir = await mkdtemp(join(tmpdir(), "infra-shared-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir, webDir: null, secureCookies: false, dataDir: join(tmpdir(), "infra-data-test"), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    const setup = await fetch(`${baseUrl}/api/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" }),
    });
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // Un hôte suffit pour créer des stacks ; aucun agent n'est nécessaire ici.
    const host = await pool.query<{ id: string }>(
      "INSERT INTO hosts (name, secret_hash) VALUES ('hôte de test', 'x') RETURNING id",
    );
    hostId = host.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });

  it("refuse les accès non authentifiés", async () => {
    expect((await call("GET", "/api/v1/stacks")).status).toBe(401);
    expect((await call("POST", "/api/v1/api-tokens", { body: { name: "x" } })).status).toBe(401);
    expect((await call("GET", "/api/v1/stacks", { bearer: "cdt_inconnu" })).status).toBe(401);
    expect((await call("GET", "/api/v1/stacks", { bearer: "pas-un-jeton" })).status).toBe(401);
  });

  it("crée un jeton affiché une seule fois et stocké sous forme d'empreinte", async () => {
    const t = await newToken("ci");
    expect(t.token).toMatch(/^cdt_/);
    const list = await call("GET", "/api/v1/api-tokens", { session: true });
    expect(JSON.stringify(list.json)).not.toContain(t.token);
    expect(list.json.tokens[0]).toMatchObject({ name: "ci", scope: "write", revokedAt: null });
    const stored = await pool.query("SELECT token_hash, prefix FROM api_tokens WHERE id = $1", [t.id]);
    expect(stored.rows[0].token_hash).not.toBe(t.token);
    expect(t.token.startsWith(stored.rows[0].prefix)).toBe(true);
  });

  it("autorise l'automatisation avec un jeton et trace son nom dans l'audit", async () => {
    const t = await newToken("pipeline");
    const created = await call("POST", "/api/v1/stacks", {
      bearer: t.token,
      body: { name: "via-jeton", hostId, compose: COMPOSE, variables: { HOST_NAME: "exemple.org" } },
    });
    expect(created.status).toBe(201);
    expect((await call("GET", "/api/v1/stacks", { bearer: t.token })).status).toBe(200);
    const audit = await pool.query("SELECT actor FROM audit_events WHERE action = 'stack.create'");
    expect(audit.rows.map((r) => r.actor)).toContain("token:pipeline");
    expect((await pool.query("SELECT last_used_at FROM api_tokens WHERE id = $1", [t.id])).rows[0].last_used_at).not.toBeNull();
  });

  it("limite un jeton en lecture seule aux requêtes GET", async () => {
    const t = await newToken("lecteur", { scope: "read" });
    expect((await call("GET", "/api/v1/stacks", { bearer: t.token })).status).toBe(200);
    const w = await call("POST", "/api/v1/stacks", {
      bearer: t.token,
      body: { name: "interdit", hostId, compose: COMPOSE, variables: { HOST_NAME: "x" } },
    });
    expect(w.status).toBe(403);
    expect(w.json.error.code).toBe("insufficient_scope");
  });

  it("empêche un jeton de gérer les jetons ou le compte administrateur", async () => {
    const t = await newToken("tentative");
    expect((await call("POST", "/api/v1/api-tokens", { bearer: t.token, body: { name: "autre" } })).status).toBe(401);
    expect((await call("GET", "/api/v1/api-tokens", { bearer: t.token })).status).toBe(401);
    expect(
      (await call("PUT", "/api/v1/admin/credentials", { bearer: t.token, body: { currentPassword: "x", newPassword: "nouveau-mot-de-passe-2" } })).status,
    ).toBe(401);
  });

  it("refuse les jetons révoqués ou expirés", async () => {
    const revoked = await newToken("a-revoquer");
    expect((await call("GET", "/api/v1/stacks", { bearer: revoked.token })).status).toBe(200);
    expect((await call("DELETE", `/api/v1/api-tokens/${revoked.id}`, { session: true })).status).toBe(204);
    expect((await call("GET", "/api/v1/stacks", { bearer: revoked.token })).status).toBe(401);
    expect((await call("DELETE", `/api/v1/api-tokens/${revoked.id}`, { session: true })).status).toBe(404);

    const expiring = await newToken("expire", { expiresInDays: 1 });
    expect((await call("GET", "/api/v1/stacks", { bearer: expiring.token })).status).toBe(200);
    await pool.query("UPDATE api_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1", [expiring.id]);
    expect((await call("GET", "/api/v1/stacks", { bearer: expiring.token })).status).toBe(401);
  });

  // --- Variables d'environnement par service ------------------------------------

  it("modifie l'environnement d'un service sans casser le reste du Compose", async () => {
    const t = await newToken("env");
    const id = (await call("GET", "/api/v1/stacks", { bearer: t.token })).json.stacks.find((s: any) => s.name === "via-jeton").id as string;

    const r = await call("PATCH", `/api/v1/stacks/${id}/services/web/environment`, {
      bearer: t.token,
      body: { expectedRevision: 1, set: { LOG_LEVEL: "debug", FEATURE_X: "on" }, unset: [] },
    });
    expect(r.json).toMatchObject({ revision: 2, changed: true });

    const detail = (await call("GET", `/api/v1/stacks/${id}`, { bearer: t.token })).json;
    expect(detail.compose).toContain("LOG_LEVEL: debug");
    expect(detail.compose).toContain("FEATURE_X: on");
    expect(detail.compose).toContain("# Application de test");
    expect(detail.compose).toContain("# niveau de logs");
    expect(detail.compose).toContain("URL: http://${HOST_NAME}/");

    // Conflit de révision, service inconnu, nom invalide.
    const stale = await call("PATCH", `/api/v1/stacks/${id}/services/web/environment`, {
      bearer: t.token,
      body: { expectedRevision: 1, set: { A: "1" } },
    });
    expect(stale.status).toBe(409);
    const unknown = await call("PATCH", `/api/v1/stacks/${id}/services/absent/environment`, {
      bearer: t.token,
      body: { expectedRevision: 2, set: { A: "1" } },
    });
    expect(unknown.status).toBe(404);
    const bad = await call("PATCH", `/api/v1/stacks/${id}/services/web/environment`, {
      bearer: t.token,
      body: { expectedRevision: 2, set: { "1 BAD": "x" } },
    });
    expect(bad.status).toBe(400);

    const removed = await call("PATCH", `/api/v1/stacks/${id}/services/web/environment`, {
      bearer: t.token,
      body: { expectedRevision: 2, unset: ["FEATURE_X"] },
    });
    expect(removed.json.revision).toBe(3);
    expect((await call("GET", `/api/v1/stacks/${id}`, { bearer: t.token })).json.compose).not.toContain("FEATURE_X");
  });

  it("refuse explicitement une structure Compose ambiguë", async () => {
    const t = await newToken("alias");
    const compose = "x-env: &env\n  A: '1'\nservices:\n  web:\n    image: x\n    environment: *env\n";
    const id = (await call("POST", "/api/v1/stacks", { bearer: t.token, body: { name: "avec-alias", hostId, compose } })).json.id as string;
    const r = await call("PATCH", `/api/v1/stacks/${id}/services/web/environment`, {
      bearer: t.token,
      body: { expectedRevision: 1, set: { B: "2" } },
    });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("unsupported_compose_structure");
  });

  it("documente exactement les routes enregistrées (contrat OpenAPI sans dérive)", async () => {
    const registered = built.routes.filter((r) => r.split(" ")[1]?.startsWith("/api/v1") || r.endsWith(" /status")).sort();
    const documented = ROUTE_DOCS.map((d) => `${d.method} ${d.path}`).sort();
    expect(registered).toEqual(documented);

    const res = await call("GET", "/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.json.openapi).toBe("3.1.0");
    expect(Object.keys(res.json.paths)).toContain("/api/v1/stacks/{id}/deploy");
  });

  // Dernier test : il épuise le limiteur d'échecs de l'adresse locale.
  it("limite les tentatives de jetons invalides", async () => {
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await call("GET", "/api/v1/stacks", { bearer: "cdt_devine" + i })).status;
    expect(last).toBe(429);
  });
});
