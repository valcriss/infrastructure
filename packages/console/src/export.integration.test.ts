import { randomBytes } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;
const COMPOSE = "services:\n  web:\n    image: nginx:1.27\n    environment:\n      TOKEN: ${TOKEN}\n      URL: ${URL}\n    volumes:\n      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro\n";

describe.skipIf(!url)("export d'une stack en ZIP (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let baseUrl: string;
  let admin = "";
  let root: string;
  let stackId = "";

  const call = async (method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) => {
    const res = await fetch(baseUrl + path, { method, headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const buf = new Uint8Array(await res.arrayBuffer());
    let json: Record<string, any> = {};
    if (res.headers.get("content-type")?.includes("json")) json = JSON.parse(strFromU8(buf));
    return { status: res.status, headers: res.headers, buf, json, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  };
  const unzip = (buf: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(buf)).map(([k, v]) => [k, strFromU8(v)]));

  /** Crée un utilisateur et renvoie sa session (mot de passe provisoire déjà changé). */
  const newUser = async (email: string, role: "admin" | "operator" | "viewer") => {
    const created = await call("POST", "/api/v1/users", { cookie: admin, body: { email, role } });
    const first = await call("POST", "/api/v1/session", { body: { username: email, password: created.json.temporaryPassword } });
    await call("PUT", "/api/v1/admin/credentials", { cookie: first.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "mot-de-passe-solide-2" } });
    return { cookie: first.cookie, email };
  };

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    root = mkdtempSync(join(tmpdir(), "infra-exp-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir: mkdtempSync(join(root, "shared-")), webDir: null, secureCookies: false, dataDir: mkdtempSync(join(root, "data-")), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    admin = (await call("POST", "/api/v1/setup", { body: { setupToken: built.setup.token, username: "boss@example.com", password: "mot-de-passe-solide-1" } })).cookie;
    const host = await pool.query<{ id: string }>("INSERT INTO hosts (name, secret_hash) VALUES ('hôte de test', 'x') RETURNING id");
    stackId = (
      await call("POST", "/api/v1/stacks", {
        cookie: admin,
        body: { name: "demo", hostId: host.rows[0]?.id, compose: COMPOSE, variables: { TOKEN: { value: "tok-secret-123", sensitive: true }, URL: "https://demo.example" }, ...{ files: undefined } },
      })
    ).json.id as string;
    await call("PUT", `/api/v1/stacks/${stackId}/files/nginx/default.conf`, { cookie: admin, body: { expectedRevision: 1, content: "server { listen 80; }" } });
    await call("PUT", `/api/v1/stacks/${stackId}/files/certs/key.pem`, { cookie: admin, body: { expectedRevision: 2, content: "-----BEGIN KEY-----", sensitive: true } });
  });

  afterAll(async () => {
    await built.app.close();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  const exportOf = (cookie: string, body: unknown = {}) => call("POST", `/api/v1/stacks/${stackId}/export`, { cookie, body });

  it("refuse l'export d'une stack jamais déployée et sans session", async () => {
    expect((await exportOf(admin)).json.error.code).toBe("never_deployed");
    expect((await call("POST", `/api/v1/stacks/${stackId}/export`, { body: {} })).status).toBe(401);
  });

  it("exporte la révision ACTIVE (déployée), pas la plus récente, sans les valeurs sensibles par défaut", async () => {
    // Révision 3 déployée ; une révision 4 plus récente est ensuite enregistrée mais pas déployée.
    await pool.query("UPDATE stacks SET deployed_revision = 3, deployed_at = now() WHERE id = $1", [stackId]);
    await call("PUT", `/api/v1/stacks/${stackId}/compose`, { cookie: admin, body: { expectedRevision: 3, compose: COMPOSE + "  # brouillon plus récent\n" } });

    // Un lecteur peut exporter, sans secrets.
    const viewer = await newUser("viewer@example.com", "viewer");
    const res = await exportOf(viewer.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain('filename="demo-r3.zip"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    const files = unzip(res.buf);
    expect(Object.keys(files).sort()).toEqual([".env", "LISEZMOI.txt", "docker-compose.yml", "nginx/default.conf"]);
    expect(files["docker-compose.yml"]).toBe(COMPOSE); // révision 3, sans le brouillon
    expect(files[".env"]).toContain("URL='https://demo.example'");
    expect(files[".env"]).toContain("TOKEN=\n");
    expect(JSON.stringify(files)).not.toContain("tok-secret-123");
    expect(JSON.stringify(files)).not.toContain("BEGIN KEY");
    expect(files["LISEZMOI.txt"]).toContain("Une révision plus récente (4)");
    expect(files["LISEZMOI.txt"]).toContain("certs/key.pem");
  });

  it("n'inclut les valeurs sensibles que pour un administrateur qui confirme son mot de passe", async () => {
    const operator = await newUser("operator@example.com", "operator");
    // Opérateur et lecteur : refusé même avec un mot de passe.
    expect((await exportOf(operator.cookie, { includeSecrets: true, password: "mot-de-passe-solide-2" })).status).toBe(403);

    // Administrateur : mot de passe obligatoire et vérifié.
    expect((await exportOf(admin, { includeSecrets: true })).json.error.code).toBe("invalid_credentials");
    expect((await exportOf(admin, { includeSecrets: true, password: "faux-mot-de-passe" })).json.error.code).toBe("invalid_credentials");
    const ok = await exportOf(admin, { includeSecrets: true, password: "mot-de-passe-solide-1" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-disposition")).toContain("demo-r3-avec-secrets.zip");
    const files = unzip(ok.buf);
    expect(files[".env"]).toContain("TOKEN='tok-secret-123'");
    expect(files["certs/key.pem"]).toBe("-----BEGIN KEY-----");
    expect(files["LISEZMOI.txt"]).toContain("INCLUSES");

    // Audit : qui, quelle révision, avec ou sans secrets ; aucune valeur.
    const audit = await pool.query("SELECT actor, target, result FROM audit_events WHERE action = 'stack.export' ORDER BY id");
    const targets = audit.rows.map((r) => `${r.result}:${r.target}`);
    expect(targets).toEqual(expect.arrayContaining(["success:demo r3 (sans secrets)", "success:demo r3 (avec secrets)", "failure:demo (avec secrets)"]));
    expect(JSON.stringify(audit.rows)).not.toContain("tok-secret-123");
  });

  it("limite les essais de mot de passe", async () => {
    const boss2 = await newUser("boss2@example.com", "admin");
    for (let i = 0; i < 5; i++) expect((await exportOf(boss2.cookie, { includeSecrets: true, password: "faux-mot-de-passe" })).status).toBe(403);
    expect((await exportOf(boss2.cookie, { includeSecrets: true, password: "mot-de-passe-solide-2" })).status).toBe(429);
  });

  it("compte sans mot de passe : un deuxième facteur récent tient lieu de confirmation", async () => {
    const pk = await newUser("passkey@example.com", "admin");
    await pool.query("UPDATE users SET password_hash = NULL WHERE email = $1", [pk.email]);
    expect((await exportOf(pk.cookie, { includeSecrets: true })).json.error.code).toBe("step_up_required");
    await pool.query("UPDATE sessions SET mfa_at = now() WHERE user_id = (SELECT id FROM users WHERE email = $1)", [pk.email]);
    expect((await exportOf(pk.cookie, { includeSecrets: true })).status).toBe(200);
  });
});
