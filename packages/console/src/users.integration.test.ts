import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { TOTP_PERIOD_SEC, totpCode } from "./mfa.js";
import { requiredRole } from "./permissions.js";

const url = process.env.TEST_DATABASE_URL;

describe("règles de permissions", () => {
  it("lecture = lecteur, écriture = opérateur, administration = administrateur", () => {
    expect(requiredRole("GET", "/api/v1/stacks")).toBe("viewer");
    expect(requiredRole("POST", "/api/v1/stacks/:id/deploy")).toBe("operator");
    expect(requiredRole("PUT", "/api/v1/settings/security")).toBe("admin");
    expect(requiredRole("GET", "/api/v1/settings/security")).toBe("viewer");
    expect(requiredRole("GET", "/api/v1/users")).toBe("admin");
    expect(requiredRole("POST", "/api/v1/hosts/:id/prune")).toBe("admin");
    expect(requiredRole("PATCH", "/api/v1/me/profile")).toBe("viewer");
    expect(requiredRole("PUT", "/api/v1/admin/credentials")).toBe("viewer");
  });
});

describe.skipIf(!url)("utilisateurs, rôles et deuxième facteur (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let baseUrl: string;
  let admin = "";

  const call = async (method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(baseUrl + path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await res.text();
    return { status: res.status, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "", json: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };
  const login = (username: string, password: string, code?: string) => call("POST", "/api/v1/session", { body: { username, password, ...(code ? { code } : {}) } });

  /** Crée un utilisateur, change son mot de passe provisoire et renvoie sa session. */
  const newUser = async (email: string, role: "admin" | "operator" | "viewer", extra: Record<string, unknown> = {}) => {
    const created = await call("POST", "/api/v1/users", { cookie: admin, body: { email, role, ...extra } });
    expect(created.status).toBe(201);
    const first = await login(email, created.json.temporaryPassword);
    expect(first.status).toBe(200);
    const change = await call("PUT", "/api/v1/admin/credentials", { cookie: first.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "mot-de-passe-solide-2" } });
    expect(change.status).toBe(200);
    return { id: created.json.user.id as string, email, cookie: first.cookie, password: "mot-de-passe-solide-2" };
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
    const setup = await call("POST", "/api/v1/setup", { body: { setupToken: built.setup.token, username: "boss@example.com", password: "mot-de-passe-solide-1" } });
    expect(setup.status).toBe(201);
    admin = setup.cookie;
  });

  afterAll(async () => {
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });

  it("crée le premier utilisateur administrateur avec son e-mail", async () => {
    const s = await call("GET", "/api/v1/session", { cookie: admin });
    expect(s.json).toMatchObject({ email: "boss@example.com", role: "admin", terminalAllowed: false, passkeysAvailable: false, totpEnabled: false });
  });

  it("impose le changement du mot de passe provisoire avant toute autre action", async () => {
    const created = await call("POST", "/api/v1/users", { cookie: admin, body: { email: "Alice@Example.com", role: "operator" } });
    expect(created.status).toBe(201);
    expect(created.json.user.email).toBe("alice@example.com");
    const session = await login("ALICE@example.com", created.json.temporaryPassword);
    expect(session.status).toBe(200);
    const blocked = await call("GET", "/api/v1/stacks", { cookie: session.cookie });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe("password_change_required");
    expect((await call("GET", "/api/v1/session", { cookie: session.cookie })).json.mustChangePassword).toBe(true);
    const changed = await call("PUT", "/api/v1/admin/credentials", { cookie: session.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "mot-de-passe-solide-2" } });
    expect(changed.status).toBe(200);
    expect((await call("GET", "/api/v1/stacks", { cookie: session.cookie })).status).toBe(200);
    // E-mail déjà pris.
    expect((await call("POST", "/api/v1/users", { cookie: admin, body: { email: "alice@example.com", role: "viewer" } })).status).toBe(409);
  });

  it("applique les rôles : lecteur, opérateur, administrateur", async () => {
    const viewer = await newUser("viewer@example.com", "viewer");
    const operator = await newUser("operator@example.com", "operator");
    // Lecture : tous.
    for (const u of [viewer, operator]) expect((await call("GET", "/api/v1/stacks", { cookie: u.cookie })).status).toBe(200);
    // Écriture d'application : opérateur oui, lecteur non (la validation vient après le contrôle de droits).
    expect((await call("POST", "/api/v1/stacks", { cookie: viewer.cookie, body: {} })).status).toBe(403);
    expect((await call("POST", "/api/v1/stacks", { cookie: operator.cookie, body: {} })).status).toBe(400);
    // Administration : administrateur seulement.
    for (const u of [viewer, operator]) {
      expect((await call("GET", "/api/v1/users", { cookie: u.cookie })).status).toBe(403);
      expect((await call("PUT", "/api/v1/settings/security", { cookie: u.cookie, body: {} })).status).toBe(403);
      expect((await call("POST", "/api/v1/api-tokens", { cookie: u.cookie, body: { name: "x" } })).status).toBe(403);
    }
    expect((await call("GET", "/api/v1/users", { cookie: admin })).status).toBe(200);
    // Les droits suivent le compte : rétrograder l'opérateur prend effet tout de suite.
    expect((await call("PATCH", `/api/v1/users/${operator.id}`, { cookie: admin, body: { role: "viewer" } })).status).toBe(200);
    expect((await call("POST", "/api/v1/stacks", { cookie: operator.cookie, body: {} })).status).toBe(403);
  });

  it("protège le dernier administrateur et son propre compte", async () => {
    const me = (await call("GET", "/api/v1/users", { cookie: admin })).json.users.find((u: any) => u.email === "boss@example.com");
    expect((await call("PATCH", `/api/v1/users/${me.id}`, { cookie: admin, body: { role: "viewer" } })).status).toBe(409);
    expect((await call("PATCH", `/api/v1/users/${me.id}`, { cookie: admin, body: { active: false } })).status).toBe(409);
    expect((await call("DELETE", `/api/v1/users/${me.id}`, { cookie: admin })).status).toBe(409);
    // Un second administrateur peut agir sur le premier, mais pas retirer le dernier.
    const other = await newUser("boss2@example.com", "admin");
    expect((await call("PATCH", `/api/v1/users/${me.id}`, { cookie: other.cookie, body: { role: "operator" } })).status).toBe(200);
    expect((await call("PATCH", `/api/v1/users/${other.id}`, { cookie: other.cookie, body: { role: "operator" } })).status).toBe(409);
    await call("PATCH", `/api/v1/users/${me.id}`, { cookie: other.cookie, body: { role: "admin" } });
  });

  it("désactiver un compte ferme ses sessions ; réinitialiser ses accès efface ses facteurs", async () => {
    const u = await newUser("temp@example.com", "viewer");
    expect((await call("GET", "/api/v1/stacks", { cookie: u.cookie })).status).toBe(200);
    expect((await call("PATCH", `/api/v1/users/${u.id}`, { cookie: admin, body: { active: false } })).status).toBe(200);
    expect((await call("GET", "/api/v1/stacks", { cookie: u.cookie })).status).toBe(401);
    expect((await login(u.email, u.password)).status).toBe(401);
    await call("PATCH", `/api/v1/users/${u.id}`, { cookie: admin, body: { active: true } });
    const reset = await call("POST", `/api/v1/users/${u.id}/reset-access`, { cookie: admin });
    expect(reset.status).toBe(200);
    expect((await login(u.email, u.password)).status).toBe(401);
    expect((await login(u.email, reset.json.temporaryPassword)).status).toBe(200);
    expect((await call("DELETE", `/api/v1/users/${u.id}`, { cookie: admin })).status).toBe(204);
  });

  it("code à usage unique : configuration, exigé à la connexion, sans rejeu, avec codes de secours", async () => {
    const u = await newUser("totp@example.com", "operator", { terminalAllowed: true });
    const begin = await call("POST", "/api/v1/me/totp", { cookie: u.cookie });
    expect(begin.status).toBe(200);
    const secret = begin.json.secret as string;
    expect(begin.json.otpauthUrl).toContain("otpauth://totp/");
    const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SEC);
    expect((await call("POST", "/api/v1/me/totp/confirm", { cookie: u.cookie, body: { code: "000000" } })).status).toBe(400);
    const confirm = await call("POST", "/api/v1/me/totp/confirm", { cookie: u.cookie, body: { code: totpCode(secret, step) } });
    expect(confirm.status).toBe(200);
    const recovery = confirm.json.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);
    // Secret stocké chiffré, jamais en clair.
    const stored = await pool.query("SELECT totp_secret FROM users WHERE email = $1", [u.email]);
    expect(stored.rows[0].totp_secret).not.toContain(secret);

    // Connexion : mot de passe seul insuffisant.
    const noCode = await login(u.email, u.password);
    expect(noCode.status).toBe(401);
    expect(noCode.json.error.code).toBe("mfa_required");
    expect((await login(u.email, u.password, "123456")).status).toBe(401);
    // Le code utilisé à la confirmation ne peut pas resservir ; le suivant fonctionne.
    expect((await login(u.email, u.password, totpCode(secret, step))).status).toBe(401);
    const ok = await login(u.email, u.password, totpCode(secret, step + 1));
    expect(ok.status).toBe(200);
    expect((await call("GET", "/api/v1/session", { cookie: ok.cookie })).json).toMatchObject({ totpEnabled: true, mfaRecent: true });
    // Un code de secours remplace le TOTP, une seule fois.
    const code = recovery[0] as string;
    expect((await login(u.email, u.password, code)).status).toBe(200);
    expect((await login(u.email, u.password, code)).status).toBe(401);
    // Confirmation d'identité pour un terminal.
    expect((await call("POST", "/api/v1/me/step-up", { cookie: ok.cookie, body: { code: "123456" } })).status).toBe(401);
    expect((await call("POST", "/api/v1/me/step-up", { cookie: ok.cookie, body: { code: recovery[1] } })).status).toBe(204);
    // Désactivation : exige le mot de passe.
    expect((await call("DELETE", "/api/v1/me/totp", { cookie: ok.cookie, body: { currentPassword: "faux" } })).status).toBe(403);
    expect((await call("DELETE", "/api/v1/me/totp", { cookie: ok.cookie, body: { currentPassword: u.password } })).status).toBe(204);
    expect((await login(u.email, u.password)).status).toBe(200);
  });

  it("les clés d'accès restent désactivées sans domaine configuré", async () => {
    const r = await call("POST", "/api/v1/session/passkey/options", { body: { email: "boss@example.com" } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("passkeys_disabled");
  });
});
