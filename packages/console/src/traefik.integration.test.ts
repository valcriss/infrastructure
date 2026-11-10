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
    // Sans application Traefik, la configuration dynamique n'est pas disponible (avec la raison).
    expect((await call("GET", "/api/v1/settings/traefik/dynamic", { cookie: admin })).json).toMatchObject({ available: false, reason: expect.stringMatching(/pas configuré/) });
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

  it("expose un service par Traefik : aperçu, révision, relecture, retrait, et refus hors périmètre", async () => {
    const compose = 'services:\n  web:\n    image: ghost:5\n    ports:\n      - "2368"\n  db:\n    image: mysql:8\n';
    const stack = await call("POST", "/api/v1/stacks", { cookie: admin, body: { name: "blog", hostId, compose } });
    expect(stack.status).toBe(201);
    const id = stack.json.id as string;
    const base = `/api/v1/stacks/${id}`;
    const exposeBody = (over: Record<string, unknown> = {}) => ({ expectedRevision: 1, hosts: ["Blog.Exemple.fr"], port: 2368, middlewares: ["auth@file"], ...over });

    const before = (await call("GET", `${base}/traefik`, { cookie: admin })).json;
    expect(before).toMatchObject({ available: true, reason: null, settings: { httpsEntryPoint: "websecure", certResolver: "letsencrypt", network: "proxy-existant" } });
    expect(before.services).toEqual([
      { service: "web", routerName: "blog-web", exposure: null, customRule: false, ports: [] },
      { service: "db", routerName: "blog-db", exposure: null, customRule: false, ports: [] },
    ]);

    // Aperçu : rien n'est enregistré.
    const preview = await call("POST", `${base}/services/web/traefik/preview`, { cookie: admin, body: exposeBody() });
    expect(preview.status).toBe(200);
    expect(preview.json.before).toBe(compose);
    expect(preview.json.after).toContain("traefik.http.routers.blog-web.rule: Host(`blog.exemple.fr`)");
    expect((await pool.query("SELECT current_revision FROM stacks WHERE id = $1", [id])).rows[0]?.current_revision).toBe(1);

    // Enregistrement : une révision non déployée, avec le rattachement au réseau de Traefik.
    const saved = await call("PATCH", `${base}/services/web/traefik`, { cookie: admin, body: exposeBody() });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ revision: 2, changed: true });
    const rev = (await pool.query<{ compose: string; message: string }>("SELECT compose, message FROM stack_revisions WHERE stack_id = $1 AND revision = 2", [id])).rows[0];
    expect(rev?.compose).toContain("traefik.http.routers.blog-web.middlewares: auth@file");
    expect(rev?.compose).toContain("name: proxy-existant");
    expect(rev?.message).toBe("Service web exposé par Traefik");
    const after = (await call("GET", `${base}/traefik`, { cookie: admin })).json;
    expect(after.services[0]).toMatchObject({ service: "web", exposure: { hosts: ["blog.exemple.fr"], port: 2368, middlewares: ["auth@file"] } });
    expect(after.services[1].exposure).toBeNull();

    // Erreurs : révision périmée, saisie invalide, service inconnu.
    expect((await call("PATCH", `${base}/services/web/traefik`, { cookie: admin, body: exposeBody() })).json.error.code).toBe("revision_conflict");
    expect((await call("PATCH", `${base}/services/web/traefik`, { cookie: admin, body: exposeBody({ expectedRevision: 2, hosts: ["pas un domaine"] }) })).json.error.code).toBe("invalid_exposure");
    expect((await call("PATCH", `${base}/services/web/traefik`, { cookie: admin, body: exposeBody({ expectedRevision: 2, port: 0 }) })).status).toBe(400);
    expect((await call("PATCH", `${base}/services/absent/traefik`, { cookie: admin, body: exposeBody({ expectedRevision: 2 }) })).status).toBe(404);

    // Retrait.
    const removed = await call("PATCH", `${base}/services/web/traefik`, { cookie: admin, body: { expectedRevision: 2, expose: false } });
    expect(removed.json).toMatchObject({ revision: 3 });
    const last = (await pool.query<{ compose: string }>("SELECT compose FROM stack_revisions WHERE stack_id = $1 AND revision = 3", [id])).rows[0];
    expect(last?.compose).not.toContain("traefik.http.routers");
    expect((await call("GET", `${base}/traefik`, { cookie: admin })).json.services[0].exposure).toBeNull();

    // Hors périmètre : application sur un autre hôte, et Traefik lui-même.
    const other = (await pool.query<{ id: string }>("INSERT INTO hosts (name, secret_hash) VALUES ('autre-hote', 'x') RETURNING id")).rows[0]?.id as string;
    const remote = await call("POST", "/api/v1/stacks", { cookie: admin, body: { name: "distant", hostId: other, compose } });
    const unavailable = (await call("GET", `/api/v1/stacks/${remote.json.id}/traefik`, { cookie: admin })).json;
    expect(unavailable).toMatchObject({ available: false });
    expect(unavailable.reason).toMatch(/autre hôte/);
    expect((await call("PATCH", `/api/v1/stacks/${remote.json.id}/services/web/traefik`, { cookie: admin, body: exposeBody() })).json.error.code).toBe("traefik_unavailable");
    const traefikStack = (await settings()).settings.stackId as string;
    expect((await call("GET", `/api/v1/stacks/${traefikStack}/traefik`, { cookie: admin })).json.reason).toMatch(/Traefik lui-même/);
    expect((await fetch(baseUrl + `${base}/traefik`)).status).toBe(401);
  });

  it("produit l'extrait pour exposer la console avec les noms mémorisés", async () => {
    const ok = await call("POST", "/api/v1/settings/traefik/console-snippet", { cookie: admin, body: { host: "Console.Exemple.fr" } });
    expect(ok.status).toBe(200);
    expect(ok.json.snippet).toContain("Host(`console.exemple.fr`)");
    expect(ok.json.snippet).toContain("SECURE_COOKIES");
    expect(ok.json.snippet).toContain("proxy-existant");
    expect((await call("POST", "/api/v1/settings/traefik/console-snippet", { cookie: admin, body: { host: "pas un domaine" } })).json.error.code).toBe("invalid_host");
    expect((await fetch(baseUrl + "/api/v1/settings/traefik/console-snippet", { method: "POST" })).status).toBe(401);
  });

  it("édite la configuration dynamique : middlewares, routes vers un autre hôte, révisions et fichier sensible", async () => {
    const dyn = "/api/v1/settings/traefik/dynamic";
    const BCRYPT = `admin:$2y$05$${"a".repeat(53)}`;
    const state = async () => (await call("GET", dyn, { cookie: admin })).json;
    const change = (c: unknown, revision: number, extra: Record<string, unknown> = {}) => ({ expectedRevision: revision, change: c, ...extra });
    const files = async (stackId: string, revision: number) =>
      (await pool.query<{ files: Record<string, string>; sensitive_files: string[] }>("SELECT files, sensitive_files FROM stack_revisions WHERE stack_id = $1 AND revision = $2", [stackId, revision])).rows[0];

    const s0 = await state();
    expect(s0).toMatchObject({ available: true, path: "dynamic/dynamic.yml", entryPoint: "websecure", certResolver: "letsencrypt", fileMissing: false, sensitive: false, parseError: null, middlewares: [], routes: [] });
    const traefikId = s0.stack.id as string;
    let rev = s0.revision as number;

    // Aperçu : rien n'est enregistré.
    const ip = { kind: "middleware", name: "interne", spec: { type: "ipAllowList", sourceRange: ["10.0.0.0/8"] } };
    const preview = await call("POST", `${dyn}/preview`, { cookie: admin, body: change(ip, rev) });
    expect(preview.status).toBe(200);
    expect(preview.json.before).toContain("# Configuration dynamique");
    expect(preview.json.after).toContain("sourceRange");
    expect((await state()).revision).toBe(rev);

    // Enregistrement : nouvelle révision, fichier non sensible tant qu'il n'y a pas de mot de passe.
    const saved = await call("PATCH", dyn, { cookie: admin, body: change(ip, rev) });
    expect(saved.json).toMatchObject({ revision: rev + 1, changed: true, sensitive: false });
    rev += 1;
    expect((await files(traefikId, rev))?.sensitive_files).toEqual([]);

    // Un middleware d'authentification rend le fichier sensible (chiffré dans la sauvegarde Git).
    const auth = await call("PATCH", dyn, { cookie: admin, body: change({ kind: "middleware", name: "auth", spec: { type: "basicAuth", users: [BCRYPT] } }, rev) });
    expect(auth.json).toMatchObject({ revision: rev + 1, sensitive: true });
    rev += 1;
    expect((await files(traefikId, rev))?.sensitive_files).toEqual(["dynamic/dynamic.yml"]);

    // Route vers un service d'un autre hôte.
    const nas = { kind: "route", name: "nas", spec: { hosts: ["nas.exemple.fr"], urls: ["http://10.0.0.5:8080"], middlewares: ["auth", "interne"] } };
    expect((await call("PATCH", dyn, { cookie: admin, body: change(nas, rev) })).json.revision).toBe(rev + 1);
    rev += 1;
    const s1 = await state();
    expect(s1.sensitive).toBe(true);
    expect(s1.routes).toEqual([expect.objectContaining({ name: "nas", hosts: ["nas.exemple.fr"], urls: ["http://10.0.0.5:8080"], middlewares: ["auth", "interne"] })]);
    expect(s1.middlewares.map((m: any) => [m.name, m.type, m.usedBy.routes])).toEqual([["interne", "ipAllowList", ["nas"]], ["auth", "basicAuth", ["nas"]]]);
    expect(s1.middlewares[1].spec).toEqual({ type: "basicAuth", users: [BCRYPT] });

    // Un utilisateur non administrateur lit la liste, mais sans les empreintes de mots de passe.
    const created = await call("POST", "/api/v1/users", { cookie: admin, body: { email: "op3@example.com", role: "operator" } });
    const first = await call("POST", "/api/v1/session", { body: { username: "op3@example.com", password: created.json.temporaryPassword } });
    await call("PUT", "/api/v1/admin/credentials", { cookie: first.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "mot-de-passe-solide-3" } });
    const asOperator = await call("GET", dyn, { cookie: first.cookie });
    expect(asOperator.status).toBe(200);
    expect(asOperator.json.middlewares[1].spec).toEqual({ type: "basicAuth", users: ["admin:••••••••"] });
    expect(JSON.stringify(asOperator.json)).not.toContain("$2y$");

    // Refus : révision périmée, saisies invalides, mot de passe en clair, middleware inconnu.
    expect((await call("PATCH", dyn, { cookie: admin, body: change(ip, rev - 1) })).json.error.code).toBe("revision_conflict");
    expect((await call("PATCH", dyn, { cookie: admin, body: change({ kind: "route", name: "x", spec: { hosts: ["pas un domaine"], urls: ["http://10.0.0.5"], middlewares: [] } }, rev) })).json.error.code).toBe("invalid_change");
    expect((await call("PATCH", dyn, { cookie: admin, body: change({ kind: "middleware", name: "clair", spec: { type: "basicAuth", users: ["bob:motdepasse"] } }, rev) })).json.error.message).toMatch(/déjà haché/);
    expect((await call("PATCH", dyn, { cookie: admin, body: change({ kind: "route", name: "y", spec: { hosts: ["y.exemple.fr"], urls: ["http://10.0.0.6"], middlewares: ["absent"] } }, rev) })).status).toBe(400);
    expect((await call("PATCH", dyn, { cookie: admin, body: change({ kind: "route-delete", name: "absent" }, rev) })).status).toBe(404);
    expect((await call("PATCH", dyn, { cookie: admin, body: { expectedRevision: rev, change: { kind: "inconnu", name: "a" } } })).status).toBe(400);

    // Un middleware utilisé par une route du fichier ne se supprime pas, même avec « force ».
    const inUse = await call("PATCH", dyn, { cookie: admin, body: change({ kind: "middleware-delete", name: "auth" }, rev, { force: true }) });
    expect(inUse.status).toBe(409);
    expect(inUse.json.error).toMatchObject({ code: "middleware_in_use", details: { usedBy: ["nas"] } });

    // Utilisé par une application (label « nom@file ») : refus sans « force », accepté avec.
    const app2 = await call("POST", "/api/v1/stacks", { cookie: admin, body: { name: "web2", hostId, compose: 'services:\n  web:\n    image: nginx\n    labels:\n      traefik.http.routers.web2.middlewares: "interne@file"\n' } });
    expect(app2.status).toBe(201);
    expect((await state()).middlewares.find((m: any) => m.name === "interne").usedBy.applications).toEqual(["web2"]);
    expect((await call("PATCH", dyn, { cookie: admin, body: change({ kind: "route-delete", name: "nas" }, rev) })).json.revision).toBe(rev + 1);
    rev += 1;
    const blocked = await call("PATCH", dyn, { cookie: admin, body: change({ kind: "middleware-delete", name: "interne" }, rev) });
    expect(blocked.json.error).toMatchObject({ code: "middleware_in_use", details: { usedBy: ["web2"] } });
    expect((await call("PATCH", dyn, { cookie: admin, body: change({ kind: "middleware-delete", name: "interne" }, rev, { force: true }) })).json.revision).toBe(rev + 1);
    rev += 1;
    expect((await call("PATCH", dyn, { cookie: admin, body: change({ kind: "middleware-delete", name: "auth" }, rev) })).json.revision).toBe(rev + 1);
    rev += 1;
    expect((await files(traefikId, rev))?.files["dynamic/dynamic.yml"]).not.toContain("http:");
    expect((await call("GET", `/api/v1/stacks/${traefikId}/revisions`, { cookie: admin })).json.revisions[0].message).toBe("Traefik : middleware « auth » supprimé");

    // Fichier modifié à la main et devenu illisible : lecture signalée, écriture refusée.
    await call("PUT", `/api/v1/stacks/${traefikId}/files/dynamic/dynamic.yml`, { cookie: admin, body: { expectedRevision: rev, content: "http: [" } });
    const broken = await state();
    expect(broken).toMatchObject({ available: true, middlewares: [], routes: [] });
    expect(broken.parseError).toEqual(expect.any(String));
    expect((await call("PATCH", dyn, { cookie: admin, body: change(ip, broken.revision) })).json.error.code).toBe("unsupported_file");

    // Réservé aux administrateurs ; lecture ouverte aux utilisateurs connectés.
    expect((await call("PATCH", dyn, { cookie: first.cookie, body: change(ip, broken.revision) })).status).toBe(403);
    expect((await call("GET", dyn, { cookie: first.cookie })).status).toBe(200);
    expect((await fetch(baseUrl + dyn)).status).toBe(401);
  });
});
