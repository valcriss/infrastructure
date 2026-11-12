import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@infra/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { requiredRole } from "./permissions.js";

const url = process.env.TEST_DATABASE_URL;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="#fff"/></svg>`;

describe.skipIf(!url)("icône d'une application (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let baseUrl: string;
  let admin = "";
  let agent: WebSocket;
  let stackId = "";

  const call = async (method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(baseUrl + path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: (() => { try { return JSON.parse(text) as Record<string, any>; } catch { return {}; } })() };
  };
  const detail = async () => (await call("GET", `/api/v1/stacks/${stackId}`, { cookie: admin })).json;
  const put = (body: unknown) => call("PUT", `/api/v1/stacks/${stackId}/icon`, { cookie: admin, body });

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
    const setup = await fetch(baseUrl + "/api/v1/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: built.setup.token, username: "boss@example.com", password: "mot-de-passe-solide-1" }) });
    admin = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const token = (await readFile(join(sharedDir, "bootstrap-token"), "utf8")).trim();
    agent = new WebSocket(baseUrl.replace("http", "ws") + "/agent/ws");
    let hostId = "";
    await new Promise<void>((resolve, reject) => {
      agent.on("open", () => agent.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, agentVersion: "test", hostname: "h", capabilities: [], auth: { kind: "enrollment", token } })));
      agent.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, any>;
        if (msg.type === "welcome") {
          hostId = msg.agentId;
          resolve();
        }
      });
      agent.on("error", reject);
    });
    const created = await call("POST", "/api/v1/stacks", { cookie: admin, body: { name: "blog", hostId, compose: "services:\n  web:\n    image: nginx\n" } });
    stackId = created.json.id;
  });
  afterAll(async () => {
    agent.close();
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });

  it("n'a aucune icône par défaut : réponse 404, et rien dans la liste ni le détail", async () => {
    expect((await call("GET", `/api/v1/stacks/${stackId}/icon`, { cookie: admin })).status).toBe(404);
    expect(await detail()).toMatchObject({ iconTag: null, iconColor: null });
    const apps = (await call("GET", "/api/v1/applications", { cookie: admin })).json.applications as Record<string, any>[];
    expect(apps.find((a) => a.name === "blog")).toMatchObject({ iconTag: null, iconColor: null });
  });

  it("enregistre un SVG et une couleur sans créer de révision ni demander de déploiement", async () => {
    const before = await detail();
    const r = await put({ svg: SVG, color: "#1E40AF" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ iconColor: "#1e40af" });
    expect(r.json.iconTag).toMatch(/^[0-9a-f]{12}$/);

    const after = await detail();
    expect(after).toMatchObject({ iconTag: r.json.iconTag, iconColor: "#1e40af", currentRevision: before.currentRevision, pendingDeploy: before.pendingDeploy });
    const apps = (await call("GET", "/api/v1/applications", { cookie: admin })).json.applications as Record<string, any>[];
    expect(apps.find((a) => a.name === "blog")).toMatchObject({ iconTag: r.json.iconTag, iconColor: "#1e40af", currentRevision: before.currentRevision });
    expect((await pool.query("SELECT count(*)::int AS n FROM stack_revisions WHERE stack_id = $1", [stackId])).rows[0]?.n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'stack.icon'")).rows[0]?.n).toBe(1);
  });

  it("sert le SVG avec les en-têtes qui l'empêchent d'agir comme une page", async () => {
    const r = await call("GET", `/api/v1/stacks/${stackId}/icon`, { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.text).toBe(SVG);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
    expect((await call("GET", `/api/v1/stacks/${stackId}/icon`)).status).toBe(401);
  });

  it("change l'empreinte quand le SVG change, pas quand seule la couleur change", async () => {
    const tag = (await detail()).iconTag as string;
    expect((await put({ color: "#ff0000" })).json).toMatchObject({ iconTag: tag, iconColor: "#ff0000" });
    const other = SVG.replace("#fff", "#000");
    expect((await put({ svg: other })).json.iconTag).not.toBe(tag);
    expect((await call("GET", `/api/v1/stacks/${stackId}/icon`, { cookie: admin })).text).toBe(other);
  });

  it("refuse un SVG dangereux, une couleur invalide, une demande vide et une application inconnue", async () => {
    const tag = (await detail()).iconTag;
    const evil = await put({ svg: `<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>` });
    expect(evil.status).toBe(400);
    expect(evil.json.error.code).toBe("invalid_icon");
    expect((await put({ color: "rouge" })).json.error.code).toBe("invalid_color");
    expect((await put({})).json.error.code).toBe("invalid_icon");
    expect((await detail()).iconTag).toBe(tag);
    const unknown = await call("PUT", "/api/v1/stacks/00000000-0000-4000-8000-000000000000/icon", { cookie: admin, body: { color: "#000000" } });
    expect(unknown.status).toBe(404);
  });

  it("rétablit les valeurs par défaut avec null", async () => {
    expect((await put({ svg: null, color: null })).json).toEqual({ iconTag: null, iconColor: null });
    expect((await call("GET", `/api/v1/stacks/${stackId}/icon`, { cookie: admin })).status).toBe(404);
  });

  it("autorise un opérateur à la modifier et laisse la lecture à tous", () => {
    expect(requiredRole("PUT", "/api/v1/stacks/:id/icon")).toBe("operator");
    expect(requiredRole("GET", "/api/v1/stacks/:id/icon")).toBe("viewer");
  });
});
