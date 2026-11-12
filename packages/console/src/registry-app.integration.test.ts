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
    expect(p.json.files["auth/htpasswd"]).toContain("infrastructure-pull");
    // Écriture réservée au compte de publication (routeur Traefik d'écriture) ; aucune empreinte réelle dans l'aperçu.
    expect(p.json.compose).toContain("registry-write");
    expect(p.json.compose).not.toMatch(/\$\$2a\$\$10\$\$[A-Za-z0-9]/);
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
    // L'empreinte du compte de publication figure aussi dans le Compose (labels Traefik) : il est chiffré dans la sauvegarde.
    expect(detail.composeSensitive).toBe(true);
    expect(s.separated).toBe(true);
    // Les empreintes du fichier correspondent aux mots de passe enregistrés, qui ne sont pas en clair dans la base.
    const creds = await call("POST", "/api/v1/settings/registry/credentials", { cookie: admin });
    expect(creds.status).toBe(200);
    expect(creds.json).toMatchObject({ registry: HOST, username: "infrastructure", pull: { username: "infrastructure-pull" } });
    expect(creds.json.password).toHaveLength(40);
    expect(creds.json.pull.password).toHaveLength(40);
    expect(creds.json.pull.password).not.toBe(creds.json.password);
    const [publishLine, pullLine] = (await htpasswdOf()).trim().split("\n");
    expect(publishLine).toMatch(/^infrastructure:\$2a\$10\$/);
    expect(pullLine).toMatch(/^infrastructure-pull:\$2a\$10\$/);
    expect(await bcrypt.compare(creds.json.password, (publishLine as string).slice("infrastructure:".length))).toBe(true);
    expect(await bcrypt.compare(creds.json.pull.password, (pullLine as string).slice("infrastructure-pull:".length))).toBe(true);
    expect(await bcrypt.compare(creds.json.pull.password, (publishLine as string).slice("infrastructure:".length))).toBe(false);
    const raw = await pool.query<{ password_enc: string; pull_password_enc: string }>("SELECT password_enc, pull_password_enc FROM registry_credentials WHERE registry = $1", [HOST]);
    expect(raw.rows[0]?.password_enc).not.toContain(creds.json.password);
    expect(raw.rows[0]?.pull_password_enc).not.toContain(creds.json.pull.password);

    // Traefik n'a que l'empreinte du compte de publication : le compte de lecture n'y figure pas, et ne peut donc pas écrire.
    const compose = (await stack()).compose as string;
    const users = /basicauth\.users"?:\s*"([^"]+)"/.exec(compose)?.[1] ?? "";
    expect(users.startsWith("infrastructure:")).toBe(true);
    expect(await bcrypt.compare(creds.json.password, users.replaceAll("$$", "$").slice("infrastructure:".length))).toBe(true);
    expect(compose).not.toContain("infrastructure-pull");

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

  it("renouvelle les deux mots de passe : nouvelle révision non déployée, nouvelles empreintes, version de l'image conservée", async () => {
    const beforeCreds = (await call("POST", "/api/v1/settings/registry/credentials", { cookie: admin })).json;
    const rev = await revisionOf();
    const r = await call("POST", "/api/v1/settings/registry/rotate", { cookie: admin });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ revision: rev + 1, separated: true, newlySeparated: false });
    const afterCreds = (await call("POST", "/api/v1/settings/registry/credentials", { cookie: admin })).json;
    expect(afterCreds.password).not.toBe(beforeCreds.password);
    expect(afterCreds.pull.password).not.toBe(beforeCreds.pull.password);
    const [publishLine, pullLine] = (await htpasswdOf()).trim().split("\n");
    expect(await bcrypt.compare(afterCreds.password, (publishLine as string).slice("infrastructure:".length))).toBe(true);
    expect(await bcrypt.compare(beforeCreds.password, (publishLine as string).slice("infrastructure:".length))).toBe(false);
    expect(await bcrypt.compare(afterCreds.pull.password, (pullLine as string).slice("infrastructure-pull:".length))).toBe(true);
    // L'empreinte de Traefik suit le nouveau mot de passe de publication, et l'image mise à jour (3.0.1) n'est pas annulée.
    const compose = (await stack()).compose as string;
    const users = /basicauth\.users"?:\s*"([^"]+)"/.exec(compose)?.[1] ?? "";
    expect(await bcrypt.compare(afterCreds.password, users.replaceAll("$$", "$").slice("infrastructure:".length))).toBe(true);
    expect(compose).toContain("image: registry:3.0.1");
    expect((await state()).application).toMatchObject({ deployed: false, managed: true });
  });

  it("une application créée avant la séparation obtient son compte de lecture et son routeur d'écriture au renouvellement", async () => {
    // Simule l'ancien état : un seul compte, ni compte de lecture, ni routeur d'écriture.
    const legacy = `infrastructure:$2a$10$${"a".repeat(53)}\n`;
    await pool.query("UPDATE registry_credentials SET pull_username = NULL, pull_password_enc = NULL WHERE registry = $1", [HOST]);
    const rev = await revisionOf();
    const detail = await stack();
    await call("PUT", `/api/v1/stacks/${stackId}/files/auth/htpasswd`, { cookie: admin, body: { expectedRevision: rev, content: legacy } }).then((r) => expect(r.status).toBe(423));
    expect((await state()).separated).toBe(false);
    expect((await call("POST", "/api/v1/settings/registry/credentials", { cookie: admin })).json.pull).toBeNull();

    const r = await call("POST", "/api/v1/settings/registry/rotate", { cookie: admin });
    expect(r.json).toMatchObject({ separated: true, newlySeparated: true });
    expect((await state()).separated).toBe(true);
    expect(detail.compose).toContain("registry-write");
  });

  it("les déploiements ne reçoivent que le compte de lecture, jamais le compte de publication", async () => {
    const { SecretBox } = await import("./secretbox.js");
    const { RegistryStore } = await import("./registries.js");
    const store = new RegistryStore(pool, new SecretBox(randomBytes(32)));
    await store.upsert("reg.exemple.invalid", { username: "publish", password: "secret-publication", insecure: false }, "test");
    // Sans compte de lecture (ancienne installation, ou registre externe) : le compte unique est transmis comme avant.
    expect(await store.authsFor(["reg.exemple.invalid/app:1"])).toEqual([{ registry: "reg.exemple.invalid", username: "publish", password: "secret-publication" }]);
    await store.setPull("reg.exemple.invalid", { username: "pull", password: "secret-lecture" });
    const auths = await store.authsFor(["reg.exemple.invalid/app:1"]);
    expect(auths).toEqual([{ registry: "reg.exemple.invalid", username: "pull", password: "secret-lecture" }]);
    expect(JSON.stringify(auths)).not.toContain("secret-publication");
    // Le compte de publication reste disponible pour les correctifs et la console.
    expect((await store.credentials("reg.exemple.invalid"))?.password).toBe("secret-publication");
    expect((await store.list()).find((r) => r.registry === "reg.exemple.invalid")).toMatchObject({ separated: true });
    await store.remove("reg.exemple.invalid", "test");
    expect(await store.pullCredentials("reg.exemple.invalid")).toBeNull();
    await expect(store.setPull("inconnu.exemple.invalid", { username: "p", password: "x" })).rejects.toMatchObject({ status: 404 });
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
