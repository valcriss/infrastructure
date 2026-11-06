import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

const run = promisify(execFile);

// Bout en bout : la vraie console (PostgreSQL), le vrai agent (code compilé de
// packages/agent/dist) et un vrai Docker. Nécessite TEST_DATABASE_URL, DOCKER_INTEGRATION=1
// et `npm run build` (le test charge l'agent compilé).
const url = process.env.TEST_DATABASE_URL;
const enabled = Boolean(url) && process.env.DOCKER_INTEGRATION === "1";

interface AgentLike {
  run(): Promise<void>;
  stop(): void;
}

describe.skipIf(!enabled)("console + agent + Docker (bout en bout)", { timeout: 240_000 }, () => {
  let pool: Pool;
  let built: BuiltApp;
  let baseUrl: string;
  let cookie = "";
  let hostId = "";
  let dirs: string[] = [];
  const clients: AgentLike[] = [];
  const projects: string[] = [];
  const suffix = randomBytes(3).toString("hex");
  const name = `e2e-${suffix}`;
  const protectedName = `e2e-prot-${suffix}`;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };

  const waitFor = async (check: () => boolean | Promise<boolean>, ms = 120_000): Promise<void> => {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > ms) throw new Error("délai dépassé en attendant la condition");
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const startAgent = async (stateDir: string, workspaceDir: string, sharedDir: string): Promise<AgentLike> => {
    const mod = (await import(pathToFileURL(join(import.meta.dirname, "../../agent/dist/client.js")).href)) as {
      AgentClient: new (config: Record<string, unknown>, log: (m: string) => void) => AgentLike;
    };
    const client = new mod.AgentClient(
      {
        consoleUrl: baseUrl.replace("http", "ws") + "/agent/ws",
        stateDir,
        bootstrapTokenFile: join(sharedDir, "bootstrap-token"),
        enrollmentToken: null,
        dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
        hostname: "e2e",
        workspaceDir,
        trivyImage: "ghcr.io/aquasecurity/trivy:0.76.1",
        trivyMemory: "2g",
        trivyMaxImageBytes: 5 * 1024 ** 3,
        protectedProjects: [protectedName],
        selfContainer: undefined,
      },
      () => {},
    );
    clients.push(client);
    void client.run();
    return client;
  };

  const presence = async (): Promise<string> => {
    const hosts = (await call("GET", "/api/v1/hosts")).json as unknown as Array<{ id: string; presence: string }> | { hosts: Array<{ id: string; presence: string }> };
    const list = Array.isArray(hosts) ? hosts : hosts.hosts;
    return list.find((h) => h.id === hostId)?.presence ?? "absent";
  };

  const deploy = async (stackId: string, action: "deploy" | "stop"): Promise<Record<string, any>> => {
    const res = await call("POST", `/api/v1/stacks/${stackId}/${action}`, action === "deploy" ? { pullImages: true } : undefined);
    expect(res.status).toBe(202);
    const opId = res.json.operationId as string;
    await waitFor(async () => ["succeeded", "failed"].includes((await call("GET", `/api/v1/operations/${opId}`)).json.status));
    return (await call("GET", `/api/v1/operations/${opId}`)).json;
  };

  const compose = ["services:", "  app:", "    image: alpine:3.20", "    command: ['sleep', '300']", ""].join("\n");

  let sharedDir = "";
  let stateDir = "";
  let workspaceDir = "";

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    sharedDir = await mkdtemp(join(tmpdir(), "infra-e2e-shared-"));
    stateDir = await mkdtemp(join(tmpdir(), "infra-e2e-state-"));
    workspaceDir = process.env.INFRA_IT_DIR ?? (await mkdtemp(join(tmpdir(), "infra-e2e-ws-")));
    dirs = [sharedDir, stateDir];
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir, webDir: null, secureCookies: false, dataDir: join(tmpdir(), "infra-data-test"), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    const setup = await fetch(baseUrl + "/api/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" }),
    });
    expect(setup.status).toBe(201);
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await startAgent(stateDir, workspaceDir, sharedDir);
    await waitFor(async () => (await pool.query("SELECT 1 FROM hosts")).rowCount === 1, 30_000);
    hostId = (await pool.query("SELECT id FROM hosts")).rows[0].id as string;
    await waitFor(async () => (await presence()) === "online", 30_000);
  });

  afterAll(async () => {
    for (const c of clients) c.stop();
    for (const p of projects) await run("docker", ["compose", "--project-name", p, "down", "--remove-orphans", "--timeout", "1"]).catch(() => {});
    await built.app.close();
    await pool.end();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("déploie une stack réelle, la voit tourner, puis l'arrête", async () => {
    projects.push(name);
    const created = await call("POST", "/api/v1/stacks", { name, hostId, compose, variables: {} });
    expect(created.status).toBe(201);
    const stackId = created.json.id as string;

    const dep = await deploy(stackId, "deploy");
    expect(dep.status).toBe("succeeded");
    const { stdout } = await run("docker", ["ps", "--filter", `label=com.docker.compose.project=${name}`, "--format", "{{.State}}"]);
    expect(stdout.trim()).toBe("running");

    const stop = await deploy(stackId, "stop");
    expect(stop.status).toBe("succeeded");
    const after = await run("docker", ["ps", "--filter", `label=com.docker.compose.project=${name}`, "--format", "{{.State}}"]);
    expect(after.stdout.trim()).toBe("");
  });

  it("refuse d'arrêter ou de redéployer un projet protégé, sans toucher à Docker", async () => {
    const created = await call("POST", "/api/v1/stacks", { name: protectedName, hostId, compose, variables: {} });
    expect(created.status).toBe(201);
    const op = await deploy(created.json.id as string, "deploy");
    expect(op.status).toBe("failed");
    expect(JSON.stringify(op)).toContain("fait tourner la console");
    const { stdout } = await run("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${protectedName}`, "--format", "{{.ID}}"]);
    expect(stdout.trim()).toBe("");
  });

  it("l'agent retrouve la console après une coupure avec ses propres identifiants", async () => {
    clients[0]?.stop();
    await waitFor(async () => (await presence()) === "offline", 30_000);
    await startAgent(stateDir, workspaceDir, sharedDir); // pas de jeton d'amorçage : reconnexion par identifiants enregistrés
    await waitFor(async () => (await presence()) === "online", 30_000);
    expect((await pool.query("SELECT count(*)::int AS n FROM hosts")).rows[0].n).toBe(1);
  });
});
