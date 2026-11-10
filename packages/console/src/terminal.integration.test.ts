import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@infra/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { TOTP_PERIOD_SEC, totpCode } from "./mfa.js";

const url = process.env.TEST_DATABASE_URL;

const CONTAINER = "a".repeat(64);
const PROTECTED = "b".repeat(64);

describe.skipIf(!url)("terminal de conteneur (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let baseUrl: string;
  let admin = "";
  let hostId = "";
  let agent: WebSocket;
  const agentInbox: Record<string, any>[] = [];

  const call = async (method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(baseUrl + path, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const text = await res.text();
    return { status: res.status, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "", text, json: (() => { try { return JSON.parse(text) as Record<string, any>; } catch { return {}; } })() };
  };
  const waitFor = async (check: () => boolean, ms = 4000): Promise<void> => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error("délai dépassé");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  /** Ouvre le WebSocket du navigateur et collecte les messages de la console. */
  const openTerminal = (cookie: string, container = CONTAINER) =>
    new Promise<{ ws: WebSocket; msgs: Record<string, any>[]; closed: Promise<void> }>((resolve) => {
      const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/api/v1/hosts/${hostId}/containers/${container}/terminal?cols=100&rows=30`, { headers: { cookie } });
      const msgs: Record<string, any>[] = [];
      const closed = new Promise<void>((r) => ws.on("close", () => r()));
      ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
      ws.on("open", () => resolve({ ws, msgs, closed }));
      ws.on("error", () => resolve({ ws, msgs, closed }));
    });

  /** Utilisateur avec droit Terminal, TOTP configuré et deuxième facteur présenté. */
  const terminalUser = async (email: string) => {
    const created = await call("POST", "/api/v1/users", { cookie: admin, body: { email, role: "operator", terminalAllowed: true } });
    const first = await call("POST", "/api/v1/session", { body: { username: email, password: created.json.temporaryPassword } });
    await call("PUT", "/api/v1/admin/credentials", { cookie: first.cookie, body: { currentPassword: created.json.temporaryPassword, newPassword: "mot-de-passe-solide-2" } });
    const begin = await call("POST", "/api/v1/me/totp", { cookie: first.cookie });
    const secret = begin.json.secret as string;
    const step = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SEC);
    await call("POST", "/api/v1/me/totp/confirm", { cookie: first.cookie, body: { code: totpCode(secret, step) } });
    return { cookie: first.cookie, secret, step, email };
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
    admin = setup.cookie;

    // Agent factice enrôlé, avec deux conteneurs en marche (dont un de la console).
    const token = (await readFile(join(sharedDir, "bootstrap-token"), "utf8")).trim();
    agent = new WebSocket(baseUrl.replace("http", "ws") + "/agent/ws");
    await new Promise<void>((resolve, reject) => {
      agent.on("open", () => agent.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, agentVersion: "test", hostname: "h", capabilities: ["terminal.exec"], auth: { kind: "enrollment", token } })));
      agent.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, any>;
        if (msg.type === "welcome") {
          hostId = msg.agentId;
          resolve();
        } else if (msg.type.startsWith("terminal_")) agentInbox.push(msg);
      });
      agent.on("error", reject);
    });
    const ctr = (id: string, name: string, project: string) => ({ id, names: [name], image: "alpine", imageId: "sha256:" + "c".repeat(64), state: "running", status: "Up", created: 1, composeProject: project, composeService: name });
    agent.send(JSON.stringify({ type: "inventory", inventory: { observedAt: new Date().toISOString(), dockerVersion: "29", containers: [ctr(CONTAINER, "web", "monapp"), ctr(PROTECTED, "console", "console-docker")] } }));
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(async () => {
    agent.close();
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });

  const reasons = (msgs: Record<string, any>[]) => msgs.filter((m) => m.t === "error").map((m) => m.code);

  it("refuse tant que le terminal est désactivé, puis selon les droits et le deuxième facteur", async () => {
    const u = await terminalUser("term@example.com");
    // Désactivé par défaut (réglage administrateur).
    let t = await openTerminal(u.cookie);
    await t.closed;
    expect(reasons(t.msgs)).toEqual(["terminal_disabled"]);

    expect((await call("PUT", "/api/v1/settings/terminal", { cookie: u.cookie, body: { enabled: true, idleMinutes: 10, maxMinutes: 60, record: true } })).status).toBe(403);
    expect((await call("PUT", "/api/v1/settings/terminal", { cookie: admin, body: { enabled: true, idleMinutes: 10, maxMinutes: 60, record: true } })).status).toBe(200);

    // Utilisateur sans le droit Terminal : refusé même administrateur.
    t = await openTerminal(admin);
    await t.closed;
    expect(reasons(t.msgs)).toEqual(["terminal_forbidden"]);

    // Droit accordé, mais le deuxième facteur n'est plus récent : confirmation exigée.
    await pool.query("UPDATE sessions SET mfa_at = now() - interval '11 minutes' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [u.email]);
    t = await openTerminal(u.cookie);
    await t.closed;
    expect(reasons(t.msgs)).toEqual(["step_up_required"]);
    expect((await call("POST", "/api/v1/me/step-up", { cookie: u.cookie, body: { code: totpCode(u.secret, u.step + 1) } })).status).toBe(204);
  });

  it("n'exige plus le deuxième facteur quand l'administrateur le désactive, mais garde le droit Terminal", async () => {
    const u = await terminalUser("term-nomfa@example.com");
    const put = (requireSecondFactor: boolean) =>
      call("PUT", "/api/v1/settings/terminal", { cookie: admin, body: { enabled: true, idleMinutes: 10, maxMinutes: 60, record: true, requireSecondFactor } });
    expect((await put(false)).status).toBe(200);
    try {
      await pool.query("UPDATE sessions SET mfa_at = now() - interval '11 minutes' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [u.email]);
      // Confirmation périmée : la session s'ouvre quand même.
      agentInbox.length = 0;
      let t = await openTerminal(u.cookie);
      await waitFor(() => t.msgs.some((m) => m.t === "ready" || m.t === "error"));
      expect(reasons(t.msgs)).toEqual([]);
      expect(t.msgs.some((m) => m.t === "ready")).toBe(true);
      await waitFor(() => agentInbox.some((m) => m.type === "terminal_open"));
      const open = agentInbox.find((m) => m.type === "terminal_open") as Record<string, any>;
      agent.send(JSON.stringify({ type: "terminal_end", sessionId: open.sessionId, reason: "Shell terminé.", exitCode: 0 }));
      await t.closed;
      // Sans le droit, toujours refusé.
      t = await openTerminal(admin);
      await t.closed;
      expect(reasons(t.msgs)).toEqual(["terminal_forbidden"]);
    } finally {
      expect((await put(true)).status).toBe(200);
    }
  });

  it("refuse les conteneurs de la console, inconnus ou sans session", async () => {
    const u = await terminalUser("term2@example.com");
    let t = await openTerminal(u.cookie, PROTECTED);
    await t.closed;
    expect(reasons(t.msgs)).toEqual(["container_protected"]);
    t = await openTerminal(u.cookie, "d".repeat(64));
    await t.closed;
    expect(reasons(t.msgs)).toEqual(["container_not_found"]);
    t = await openTerminal("");
    await t.closed;
    expect(t.msgs).toEqual([]);
  });

  it("relaie l'entrée et la sortie, enregistre la session et la trace dans l'audit", async () => {
    const u = await terminalUser("term3@example.com");
    agentInbox.length = 0;
    const t = await openTerminal(u.cookie);
    await waitFor(() => t.msgs.some((m) => m.t === "ready"));
    await waitFor(() => agentInbox.some((m) => m.type === "terminal_open"));
    const open = agentInbox.find((m) => m.type === "terminal_open") as Record<string, any>;
    expect(open).toMatchObject({ containerId: CONTAINER, cols: 100, rows: 30 });

    // Navigateur -> agent.
    t.ws.send(JSON.stringify({ t: "input", d: Buffer.from("ls\n").toString("base64") }));
    await waitFor(() => agentInbox.some((m) => m.type === "terminal_input"));
    expect(Buffer.from(agentInbox.find((m) => m.type === "terminal_input")!.data, "base64").toString()).toBe("ls\n");
    t.ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));
    await waitFor(() => agentInbox.some((m) => m.type === "terminal_resize"));

    // Agent -> navigateur, puis fin du shell.
    agent.send(JSON.stringify({ type: "terminal_data", sessionId: open.sessionId, data: Buffer.from("fichier.txt\r\n").toString("base64") }));
    await waitFor(() => t.msgs.some((m) => m.t === "data"));
    expect(Buffer.from(t.msgs.find((m) => m.t === "data")!.d, "base64").toString()).toBe("fichier.txt\r\n");
    agent.send(JSON.stringify({ type: "terminal_end", sessionId: open.sessionId, reason: "Shell terminé.", exitCode: 0 }));
    await t.closed;
    expect(t.msgs.find((m) => m.t === "end")).toMatchObject({ reason: "Shell terminé.", exitCode: 0 });

    // Enregistrement asciinema (réservé aux administrateurs).
    await new Promise((r) => setTimeout(r, 200));
    const list = await call("GET", "/api/v1/terminal-recordings", { cookie: admin });
    const session = list.json.sessions.find((s: any) => s.id === open.sessionId);
    expect(session).toMatchObject({ userEmail: u.email, containerName: "web", project: "monapp", exitCode: 0, active: false, recorded: true });
    expect((await call("GET", "/api/v1/terminal-recordings", { cookie: u.cookie })).status).toBe(403);
    const cast = await call("GET", `/api/v1/terminal-recordings/${open.sessionId}`, { cookie: admin });
    expect(cast.status).toBe(200);
    const lines = cast.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ version: 2, width: 100, height: 30 });
    expect(lines.some((l) => Array.isArray(l) && l[1] === "o" && l[2] === "fichier.txt\r\n")).toBe(true);
    expect(lines.some((l) => Array.isArray(l) && l[1] === "r" && l[2] === "120x40")).toBe(true);
    // Les frappes ne sont pas enregistrées (mots de passe saisis sans écho).
    expect(cast.text).not.toContain('"i"');
    const audit = await pool.query("SELECT action FROM audit_events WHERE action LIKE 'terminal.%' ORDER BY id");
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["terminal.open", "terminal.replay"]));
    expect((await call("DELETE", `/api/v1/terminal-recordings/${open.sessionId}`, { cookie: admin })).status).toBe(204);
  });

  it("ferme la session côté agent quand le navigateur se déconnecte, et limite le nombre de terminaux", async () => {
    const u = await terminalUser("term4@example.com");
    agentInbox.length = 0;
    const sessions = [];
    for (let i = 0; i < 3; i++) {
      const t = await openTerminal(u.cookie);
      await waitFor(() => t.msgs.some((m) => m.t === "ready"));
      sessions.push(t);
    }
    const fourth = await openTerminal(u.cookie);
    await fourth.closed;
    expect(reasons(fourth.msgs)).toEqual(["too_many_terminals"]);
    sessions[0]!.ws.close();
    await waitFor(() => agentInbox.some((m) => m.type === "terminal_close"));
    for (const s of sessions.slice(1)) s.ws.close();
    await new Promise((r) => setTimeout(r, 300));
  });
});
