import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@infra/shared";
import bcrypt from "bcryptjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { requiredRole } from "./permissions.js";

const url = process.env.TEST_DATABASE_URL;
const HOST = "registry.exemple.invalid";

describe.skipIf(!url)("application registry (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let baseUrl: string;
  let admin = "";
  let hostId = "";
  let agent: WebSocket;
  let stackId = "";

  const call = async (method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(baseUrl + path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: (() => { try { return JSON.parse(text) as Record<string, any>; } catch { return {}; } })() };
  };
  const state = async () => (await call("GET", "/api/v1/settings/registry", { cookie: admin })).json;
  const stack = async () => (await call("GET", `/api/v1/stacks/${stackId}`, { cookie: admin })).json;
  const revisionOf = async () => (await stack()).currentRevision as number;
  const htpasswdOf = async () => (await pool.query<{ files: Record<string, string> }>("SELECT files FROM stack_revisions WHERE stack_id = $1 ORDER BY revision DESC LIMIT 1", [stackId])).rows[0]?.files["auth/htpasswd"] ?? "";

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

  it("sans Traefik, indique le prérequis et refuse l'aperçu comme la création", async () => {
    const s = await state();
    expect(s).toMatchObject({ settings: null, application: null, stackName: "registry", username: "infrastructure", traefik: { available: false } });
    expect((await call("POST", "/api/v1/settings/registry/preview", { cookie: admin, body: { host: HOST } })).status).toBe(409);
    expect((await call("POST", "/api/v1/settings/registry/application", { cookie: admin, body: { host: HOST } })).status).toBe(409);
  });

  it("avec Traefik : l'aperçu ne contient aucun secret et refuse un nom de domaine invalide", async () => {
    const t = await call("POST", "/api/v1/settings/traefik/application", { cookie: admin, body: { hostId, email: "admin@exemple.fr", network: { mode: "create", name: "traefik-public" } } });
    expect(t.status).toBe(201);
    expect((await state()).traefik).toMatchObject({ available: true, deployed: false, production: false, network: "traefik-public" });

    const p = await call("POST", "/api/v1/settings/registry/preview", { cookie: admin, body: { host: HOST } });
    expect(p.status).toBe(200);
    expect(p.json.compose).toContain("registry:3.0.0");
    expect(p.json.compose).toContain("Host(`registry.exemple.invalid`)");
    expect(p.json.files["auth/htpasswd"]).not.toMatch(/\$2[aby]\$/);
    expect((await call("POST", "/api/v1/settings/registry/preview", { cookie: admin, body: { host: "registre" } })).status).toBe(400);
    // L'aperçu n'enregistre rien.
    expect((await state()).settings).toBeNull();
  });

  it("crée l'application protégée (révision 1, non déployée), son mot de passe chiffré et son enregistrement", async () => {
    const r = await call("POST", "/api/v1/settings/registry/application", { cookie: admin, body: { host: ` ${HOST.toUpperCase()}`.trim() } });
    expect(r.status).toBe(201);
    stackId = r.json.id;
    expect(r.json.revision).toBe(1);
    expect(JSON.stringify(r.json)).not.toMatch(/password|\$2a\$/i);

    const s = await state();
    expect(s).toMatchObject({ settings: { stackId, host: HOST, entryPoint: "websecure", certResolver: "letsencrypt", network: "traefik-public" }, application: { name: "registry", deployed: false, managed: true }, hasPassword: true });
    expect(JSON.stringify(s)).not.toMatch(/\$2a\$/);

    const detail = await stack();
    expect(detail.managedBy).toBe("registry");
    expect(detail.sensitiveFiles).toEqual(["auth/htpasswd"]);
    // L'empreinte du fichier correspond au mot de passe enregistré, qui n'est pas en clair dans la base.
    const creds = await call("POST", "/api/v1/settings/registry/credentials", { cookie: admin });
    expect(creds.status).toBe(200);
    expect(creds.json).toMatchObject({ registry: HOST, username: "infrastructure" });
    expect(creds.json.password).toHaveLength(40);
    const line = (await htpasswdOf()).trim();
    expect(line).toMatch(/^infrastructure:\$2a\$10\$/);
    expect(await bcrypt.compare(creds.json.password, line.slice("infrastructure:".length))).toBe(true);
    const raw = await pool.query<{ password_enc: string }>("SELECT password_enc FROM registry_credentials WHERE registry = $1", [HOST]);
    expect(raw.rows[0]?.password_enc).not.toContain(creds.json.password);

    // Les identifiants rejoignent le module des registres d'images : les déploiements les transmettront à l'agent.
    const list = await call("GET", "/api/v1/registries", { cookie: admin });
    expect(JSON.stringify(list.json)).toContain(HOST);
  });

  it("refuse une seconde application tant que la première existe", async () => {
    const again = await call("POST", "/api/v1/settings/registry/application", { cookie: admin, body: { host: "autre.exemple.invalid" } });
    expect(again.status).toBe(409);
    expect(again.json.code ?? again.json.error?.code).toBe("registry_already_configured");
  });

  it("refuse toute modification manuelle de l'application (423) mais autorise le changement d'étiquette d'image", async () => {
    const rev = await revisionOf();
    const detail = await stack();
    const edits = [
      call("PUT", `/api/v1/stacks/${stackId}/compose`, { cookie: admin, body: { expectedRevision: rev, compose: detail.compose + "\n# x\n" } }),
      call("PATCH", `/api/v1/stacks/${stackId}/variables`, { cookie: admin, body: { expectedRevision: rev, set: { A: "1" } } }),
      call("PUT", `/api/v1/stacks/${stackId}/files/auth/htpasswd`, { cookie: admin, body: { expectedRevision: rev, content: "x" } }),
      call("PATCH", `/api/v1/stacks/${stackId}/services/registry/environment`, { cookie: admin, body: { expectedRevision: rev, set: { X: "1" } } }),
    ];
    for (const e of await Promise.all(edits)) {
      expect(e.status).toBe(423);
      expect(e.json.code ?? e.json.error?.code).toBe("stack_managed");
    }
    expect(await revisionOf()).toBe(rev);

    const tag = await call("PATCH", `/api/v1/stacks/${stackId}/services/registry/image-tag`, { cookie: admin, body: { expectedRevision: rev, tag: "3.0.1" } });
    expect(tag.status).toBe(200);
    expect(await revisionOf()).toBe(rev + 1);
  });

  it("renouvelle le mot de passe : nouvelle révision non déployée, nouvelle empreinte, anciens identifiants remplacés", async () => {
    const before = (await call("POST", "/api/v1/settings/registry/credentials", { cookie: admin })).json.password as string;
    const rev = await revisionOf();
    const r = await call("POST", "/api/v1/settings/registry/rotate", { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.json.revision).toBe(rev + 1);
    const after = (await call("POST", "/api/v1/settings/registry/credentials", { cookie: admin })).json.password as string;
    expect(after).not.toBe(before);
    const hash = (await htpasswdOf()).trim().slice("infrastructure:".length);
    expect(await bcrypt.compare(after, hash)).toBe(true);
    expect(await bcrypt.compare(before, hash)).toBe(false);
    expect((await state()).application).toMatchObject({ deployed: false, managed: true });
  });

  it("le test d'accès signale un nom de domaine qui ne se résout pas, sans déclarer le registre prêt", async () => {
    const t = await call("POST", "/api/v1/settings/registry/test", { cookie: admin });
    expect(t.status).toBe(200);
    expect(t.json.ready).toBe(false);
    expect(t.json.dns.ok).toBe(false);
    expect(t.json.dns.detail).toContain(HOST);
  });

  it("réserve la configuration aux administrateurs, la lecture restant ouverte", () => {
    expect(requiredRole("GET", "/api/v1/settings/registry")).toBe("viewer");
    for (const p of ["preview", "application", "credentials", "rotate", "test", "detach"]) expect(requiredRole("POST", `/api/v1/settings/registry/${p}`)).toBe("admin");
  });

  it("détache l'application : elle redevient modifiable à la main et ne se renouvelle plus", async () => {
    const d = await call("POST", "/api/v1/settings/registry/detach", { cookie: admin });
    expect(d.status).toBe(200);
    expect((await call("POST", "/api/v1/settings/registry/detach", { cookie: admin })).status).toBe(409);
    expect((await call("POST", "/api/v1/settings/registry/rotate", { cookie: admin })).status).toBe(409);
    expect((await state()).application).toMatchObject({ managed: false });
    const rev = await revisionOf();
    const detail = await stack();
    const edit = await call("PUT", `/api/v1/stacks/${stackId}/compose`, { cookie: admin, body: { expectedRevision: rev, compose: detail.compose + "\n# libre\n" } });
    expect(edit.status).toBe(200);
  });
});
