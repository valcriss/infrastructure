import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@infra/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("application Traefik (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let baseUrl: string;
  let admin = "";
  let hostId = "";
  let agent: WebSocket;

  const call = async (method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(baseUrl + path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await res.text();
    return { status: res.status, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "", json: (() => { try { return JSON.parse(text) as Record<string, any>; } catch { return {}; } })() };
  };
  const waitFor = async (check: () => Promise<boolean>, ms = 4000): Promise<void> => {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > ms) throw new Error("délai dépassé");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const sendInventory = (networks: unknown, containers: unknown[] = []) =>
    agent.send(JSON.stringify({ type: "inventory", inventory: { observedAt: new Date().toISOString(), dockerVersion: "29", containers, ...(networks ? { networks } : {}) } }));
  const body = (over: Record<string, unknown> = {}) => ({ hostId, email: "admin@exemple.fr", network: { mode: "create", name: "traefik-public" }, ...over });
  const settings = async () => (await call("GET", "/api/v1/settings/traefik", { cookie: admin })).json;

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
    admin = (await call("POST", "/api/v1/setup", { body: { setupToken: built.setup.token, username: "boss@example.com", password: "mot-de-passe-solide-1" } })).cookie;

    const token = (await readFile(join(sharedDir, "bootstrap-token"), "utf8")).trim();
    agent = new WebSocket(baseUrl.replace("http", "ws") + "/agent/ws");
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
  });
  afterAll(async () => {
    agent.close();
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });

  it("remonte les réseaux de l'hôte (candidats) et les ports 80/443 déjà publiés", async () => {
    // Agent qui ne remonte pas les réseaux : null, distinct de « aucun réseau ».
    sendInventory(undefined);
    await waitFor(async () => (await settings()).hosts?.[0]?.networks === null);

    sendInventory(
      [
        { name: "proxy-existant", driver: "bridge", scope: "local", internal: false },
        { name: "blog_default", driver: "bridge", scope: "local", internal: false, project: "blog" },
      ],
      [{ id: "n".repeat(64), names: ["nginx"], image: "nginx", imageId: "sha256:1", state: "running", status: "Up", created: 1, composeProject: "site", networks: ["proxy-existant"], ports: [{ privatePort: 80, publicPort: 80, type: "tcp" }] }],
    );
    await waitFor(async () => ((await settings()).hosts?.[0]?.networks ?? []).length > 0);
    const r = await settings();
    expect(r).toMatchObject({ settings: null, application: null, stackName: "traefik", defaults: { httpEntryPoint: "web", httpsEntryPoint: "websecure", certResolver: "letsencrypt" } });
    expect(r.hosts[0].networks).toEqual([{ name: "proxy-existant", driver: "bridge", usedBy: ["site"], suggested: true }]);
    expect(r.hosts[0].portConflicts).toEqual([{ port: 80, container: "nginx" }]);
    expect((await fetch(baseUrl + "/api/v1/settings/traefik")).status).toBe(401);
  });

  it("refuse les saisies invalides, un réseau incohérent et les non-administrateurs", async () => {
    const post = (b: unknown, cookie = admin) => call("POST", "/api/v1/settings/traefik/application", { cookie, body: b });
    expect((await post(body({ email: "pas-un-mail" }))).json.error.code).toBe("invalid_options");
    expect((await post(body({ httpsEntryPoint: "web" }))).status).toBe(400);
    expect((await post(body({ network: { mode: "existing", name: "inconnu" } }))).json.error.code).toBe("network_not_found");
    expect((await post(body({ network: { mode: "create", name: "proxy-existant" } }))).json.error.code).toBe("network_exists");
    expect((await post(body({ hostId: "00000000-0000-4000-8000-000000000000" }))).status).toBe(404);

    const created = await call("POST", "/api/v1/users", { cookie: admin, body: { email: "op@example.com", role: "operator" } });
    const first = await call("POST", "/api/v1/session", { body: { username: "op@example.com", password: created.json.temporaryPassword } });
    await call("PUT", "/api/v1/admin/credentials", { cookie: first.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "mot-de-passe-solide-2" } });
    expect((await post(body(), first.cookie)).status).toBe(403);
    expect((await pool.query("SELECT 1 FROM stacks")).rowCount).toBe(0);
  });

  it("donne un aperçu des fichiers sans rien enregistrer, avec la même validation", async () => {
    const preview = (b: unknown, cookie = admin) => call("POST", "/api/v1/settings/traefik/preview", { cookie, body: b });
    const ok = await preview(body({ production: true }));
    expect(ok.status).toBe(200);
    expect(ok.json.compose).toContain("traefik:v3.7.17");
    expect(Object.keys(ok.json.files).sort()).toEqual(["dynamic/dynamic.yml", "traefik.yml"]);
    expect(ok.json.files["traefik.yml"]).not.toContain("acme-staging");
    expect((await preview(body({ email: "x" }))).json.error.code).toBe("invalid_options");
    expect((await preview(body({ network: { mode: "existing", name: "inconnu" } }))).json.error.code).toBe("network_not_found");
    expect((await fetch(baseUrl + "/api/v1/settings/traefik/preview", { method: "POST" })).status).toBe(401);
    expect((await pool.query("SELECT 1 FROM stacks")).rowCount).toBe(0);
    expect((await settings()).settings).toBeNull();
  });

  it("crée l'application en révision 1 avec ses fichiers, mémorise les noms et refuse une seconde création", async () => {
    const res = await call("POST", "/api/v1/settings/traefik/application", {
      cookie: admin,
      body: body({ production: false, httpEntryPoint: "http", httpsEntryPoint: "https", certResolver: "le", network: { mode: "existing", name: "proxy-existant" } }),
    });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ revision: 1, settings: { hostId, httpEntryPoint: "http", httpsEntryPoint: "https", certResolver: "le", network: "proxy-existant", production: false } });

    const rev = await pool.query<{ compose: string; files: Record<string, string>; sensitive_files: string[] }>("SELECT compose, files, sensitive_files FROM stack_revisions WHERE stack_id = $1 AND revision = 1", [res.json.id]);
    expect(rev.rows[0]?.compose).toContain("traefik:v3.7.17");
    expect(rev.rows[0]?.compose).toContain("external: true");
    expect(Object.keys(rev.rows[0]?.files ?? {}).sort()).toEqual(["dynamic/dynamic.yml", "traefik.yml"]);
    expect(rev.rows[0]?.files["traefik.yml"]).toContain("certResolver: le");
    expect(rev.rows[0]?.sensitive_files).toEqual([]);
    expect((await pool.query("SELECT name, current_revision, deployed_revision FROM stacks WHERE id = $1", [res.json.id])).rows[0]).toEqual({ name: "traefik", current_revision: 1, deployed_revision: null });

    const state = await settings();
    expect(state.settings).toMatchObject({ stackId: res.json.id, certResolver: "le" });
    expect(state.application).toMatchObject({ id: res.json.id, name: "traefik", currentRevision: 1, deployed: false });

    expect((await call("POST", "/api/v1/settings/traefik/application", { cookie: admin, body: body() })).json.error.code).toBe("traefik_already_configured");
    expect((await pool.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'settings.traefik'")).rows[0]?.n).toBe(1);

    // Application supprimée depuis : le réglage reste, avec l'indication, et une nouvelle création redevient possible.
    await pool.query("DELETE FROM stacks WHERE id = $1", [res.json.id]);
    expect((await settings()).application).toEqual({ missing: true });
    expect((await call("POST", "/api/v1/settings/traefik/application", { cookie: admin, body: body({ network: { mode: "existing", name: "proxy-existant" } }) })).status).toBe(201);
  });
});
