import { PROTOCOL_VERSION } from "@infra/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

// Test d'intégration : nécessite une base PostgreSQL dédiée et jetable.
// Exemple : TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("console (intégration PostgreSQL)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let baseUrl: string;
  let cookie = "";

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    sharedDir = await mkdtemp(join(tmpdir(), "infra-shared-"));
    built = await buildApp({
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir, webDir: null, secureCookies: false },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("refuse les routes protégées sans session", async () => {
    expect((await fetch(`${baseUrl}/api/v1/hosts`)).status).toBe(401);
    expect((await post("/api/v1/agents/enrollment-tokens", {})).status).toBe(401);
  });

  it("refuse l'initialisation avec un mauvais secret", async () => {
    const res = await post("/api/v1/setup", {
      setupToken: "faux",
      username: "admin",
      password: "mot-de-passe-solide-1",
    });
    expect(res.status).toBe(403);
  });

  it("crée exactement un administrateur malgré des requêtes concurrentes", async () => {
    const token = built.setup.token as string;
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        post("/api/v1/setup", {
          setupToken: token,
          username: `admin${i}`,
          password: "mot-de-passe-solide-1",
        }),
      ),
    );
    const statuses = attempts.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM admin")).rows[0].n).toBe(1);
    const ok = attempts.find((r) => r.status === 201) as Response;
    cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("sid=");
  });

  it("ferme la route d'initialisation après coup", async () => {
    const res = await post("/api/v1/setup", {
      setupToken: "x",
      username: "autre",
      password: "mot-de-passe-solide-1",
    });
    expect(res.status).toBe(404);
  });

  it("dépose un jeton d'amorçage pour l'agent local", async () => {
    const token = (await readFile(join(sharedDir, "bootstrap-token"), "utf8")).trim();
    expect(token.length).toBeGreaterThan(20);
  });

  it("rejette un mauvais mot de passe et accepte le bon", async () => {
    const admin = (await pool.query("SELECT username FROM admin")).rows[0].username as string;
    expect((await post("/api/v1/session", { username: admin, password: "mauvais" })).status).toBe(401);
    expect((await post("/api/v1/session", { username: admin, password: "mot-de-passe-solide-1" })).status).toBe(200);
  });

  it("refuse une requête modifiante d'une autre origine", async () => {
    const res = await post("/api/v1/session", { username: "a", password: "b" }, { origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });

  it("enrôle l'agent local, une seule fois, puis le reconnecte avec ses identifiants", async () => {
    const token = (await readFile(join(sharedDir, "bootstrap-token"), "utf8")).trim();
    const wsUrl = baseUrl.replace("http", "ws") + "/agent/ws";

    const hello = (auth: object) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.on("open", () =>
          ws.send(
            JSON.stringify({
              type: "hello",
              protocol: PROTOCOL_VERSION,
              agentVersion: "test",
              hostname: "h",
              capabilities: ["docker.standalone"],
              auth,
            }),
          ),
        );
        ws.on("message", (raw) => {
          resolve(JSON.parse(raw.toString()));
          ws.close();
        });
        ws.on("error", reject);
      });

    const first = await hello({ kind: "enrollment", token });
    expect(first.type).toBe("welcome");
    const creds = first.credentials as { agentId: string; secret: string };
    expect(creds.secret.length).toBeGreaterThan(20);

    // Le jeton est à usage unique et le fichier d'amorçage est supprimé.
    const replay = await hello({ kind: "enrollment", token });
    expect(replay.type).toBe("error");
    await expect(readFile(join(sharedDir, "bootstrap-token"))).rejects.toThrow();

    const again = await hello({ kind: "credentials", ...creds });
    expect(again.type).toBe("welcome");
    expect(again.credentials).toBeUndefined();

    const bad = await hello({ kind: "credentials", agentId: creds.agentId, secret: "x".repeat(40) });
    expect(bad.type).toBe("error");

    // L'hôte est visible, hors ligne (plus de connexion), avec sa dernière observation.
    const list = await fetch(`${baseUrl}/api/v1/hosts`, { headers: { cookie } });
    const body = (await list.json()) as { hosts: { id: string; presence: string }[] };
    expect(body.hosts).toHaveLength(1);

    // Révocation : les identifiants cessent de fonctionner.
    const del = await fetch(`${baseUrl}/api/v1/hosts/${creds.agentId}`, { method: "DELETE", headers: { cookie } });
    expect(del.status).toBe(204);
    const revoked = await hello({ kind: "credentials", ...creds });
    expect(revoked.type).toBe("error");
  });

  it("n'enrôle pas avec un jeton manuel expiré ou inconnu", async () => {
    const res = await post("/api/v1/agents/enrollment-tokens", { hostName: "serveur2" }, { cookie });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    expect(token.length).toBeGreaterThan(20);
    // Seule l'empreinte est stockée.
    const stored = await pool.query("SELECT token_hash FROM enrollment_tokens WHERE host_name = 'serveur2'");
    expect(stored.rows[0].token_hash).not.toBe(token);
  });
});
