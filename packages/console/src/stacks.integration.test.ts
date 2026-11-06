import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION, type RunMessage } from "@infra/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;

const COMPOSE = "services:\n  web:\n    image: nginx:1.27\n    ports:\n      - '${PUBLIC_PORT}:80'\n";

interface FakeAgent {
  ws: WebSocket;
  runs: RunMessage[];
  received: Record<string, any>[];
  agentId: string;
  secret: string;
  send: (m: unknown) => void;
  close: () => Promise<void>;
}

describe.skipIf(!url)("stacks et opérations (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let baseUrl: string;
  let wsUrl: string;
  let cookie = "";
  let hostId = "";
  let agent: FakeAgent;

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };

  /** Agent factice : se connecte comme le vrai agent et enregistre les commandes reçues. */
  const connectAgent = (auth: object): Promise<FakeAgent> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const runs: RunMessage[] = [];
      const received: Record<string, any>[] = [];
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "hello",
            protocol: PROTOCOL_VERSION,
            agentVersion: "test",
            hostname: "h",
            capabilities: ["compose.deploy"],
            auth,
          }),
        ),
      );
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, any>;
        if (msg.type === "welcome") {
          const c = msg.credentials as { agentId: string; secret: string } | undefined;
          resolve({
            ws,
            runs,
            received,
            agentId: msg.agentId,
            secret: c?.secret ?? "",
            send: (m) => ws.send(JSON.stringify(m)),
            close: () => new Promise((r) => (ws.on("close", () => r()), ws.close())),
          });
        } else if (msg.type === "run") {
          runs.push(msg as unknown as RunMessage);
        } else if (msg.type === "logs_start" || msg.type === "logs_stop") {
          received.push(msg);
        } else if (msg.type === "error") {
          reject(new Error(msg.message));
        }
      });
      ws.on("error", reject);
    });

  const waitFor = async (check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > ms) throw new Error("délai dépassé en attendant la condition");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const createStack = async (name: string, extra: Record<string, unknown> = {}) =>
    call("POST", "/api/v1/stacks", { name, hostId, compose: COMPOSE, variables: { PUBLIC_PORT: "8080" }, ...extra });

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    sharedDir = await mkdtemp(join(tmpdir(), "infra-shared-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir, webDir: null, secureCookies: false, dataDir: join(tmpdir(), "infra-data-test"), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7 },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    wsUrl = baseUrl.replace("http", "ws") + "/agent/ws";

    const setup = await call("POST", "/api/v1/setup", {
      setupToken: built.setup.token,
      username: "admin",
      password: "mot-de-passe-solide-1",
    });
    expect(setup.status).toBe(201);
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const token = (await readFile(join(sharedDir, "bootstrap-token"), "utf8")).trim();
    agent = await connectAgent({ kind: "enrollment", token });
    hostId = agent.agentId;
  });

  afterAll(async () => {
    agent.ws.close();
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });

  // --- Création et validation -------------------------------------------------

  it("refuse les stacks invalides avec des erreurs localisées", async () => {
    expect((await createStack("Nom Invalide")).status).toBe(400);
    expect((await createStack("console-docker")).status).toBe(400);
    expect((await createStack("ok", { hostId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);

    const bad = await createStack("syntaxe", { compose: "services:\n  web:\n    image: [nginx\n" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid_compose");
    expect(bad.json.error.details[0].line).toBeGreaterThan(0);

    const build = await createStack("avec-build", { compose: "services:\n  web:\n    build: .\n" });
    expect(build.status).toBe(400);
    expect(JSON.stringify(build.json)).toContain("build");
  });

  it("crée une stack en révision 1, non déployée", async () => {
    const res = await createStack("app1");
    expect(res.status).toBe(201);
    expect(res.json.revision).toBe(1);
    expect(res.json.backup.status).toBe("not_configured");
    expect((await createStack("app1")).status).toBe(409);

    const list = await call("GET", "/api/v1/stacks");
    const s = list.json.stacks.find((x: any) => x.name === "app1");
    expect(s).toMatchObject({ currentRevision: 1, deployedRevision: null, pendingDeploy: true });
  });

  // --- Révisions, variables, fichiers ------------------------------------------

  it("crée des révisions, masque les variables sensibles et conserve leur valeur", async () => {
    const id = (await createStack("app2")).json.id as string;

    const v = await call("PATCH", `/api/v1/stacks/${id}/variables`, {
      expectedRevision: 1,
      set: { IMAGE_TAG: "1.4.2", DB_PASSWORD: { value: "sup3r-secret-value", sensitive: true } },
    });
    expect(v.json).toMatchObject({ revision: 2, changed: true });

    // Modifier une autre variable ne doit pas effacer la valeur sensible.
    const v2 = await call("PATCH", `/api/v1/stacks/${id}/variables`, {
      expectedRevision: 2,
      set: { IMAGE_TAG: "1.4.3" },
    });
    expect(v2.json.revision).toBe(3);

    const detail = await call("GET", `/api/v1/stacks/${id}`);
    const vars = detail.json.variables as { name: string; value: string | null; sensitive: boolean }[];
    expect(vars.find((x) => x.name === "DB_PASSWORD")).toEqual({ name: "DB_PASSWORD", value: null, sensitive: true });
    expect(vars.find((x) => x.name === "IMAGE_TAG")?.value).toBe("1.4.3");
    expect(JSON.stringify(detail.json)).not.toContain("sup3r-secret-value");
    expect(JSON.stringify((await call("GET", `/api/v1/stacks/${id}/revisions/3`)).json)).not.toContain("sup3r-secret-value");

    const unset = await call("PATCH", `/api/v1/stacks/${id}/variables`, { expectedRevision: 3, unset: ["IMAGE_TAG"] });
    expect(unset.json.revision).toBe(4);
    const revs = await call("GET", `/api/v1/stacks/${id}/revisions`);
    expect(revs.json.revisions.map((r: any) => r.revision)).toEqual([4, 3, 2, 1]);
  });

  it("détecte les conflits de révision et ignore les modifications sans effet", async () => {
    const id = (await createStack("app3")).json.id as string;
    await call("PUT", `/api/v1/stacks/${id}/compose`, { expectedRevision: 1, compose: COMPOSE + "    restart: always\n" });
    const stale = await call("PUT", `/api/v1/stacks/${id}/compose`, { expectedRevision: 1, compose: COMPOSE });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("revision_conflict");
    expect(stale.json.error.details.currentRevision).toBe(2);

    const same = await call("PATCH", `/api/v1/stacks/${id}/variables`, { expectedRevision: 2, set: { PUBLIC_PORT: "8080" } });
    expect(same.json).toMatchObject({ revision: 2, changed: false });
    expect((await call("PUT", `/api/v1/stacks/${id}/compose`, { compose: COMPOSE })).status).toBe(400);
  });

  it("gère les fichiers associés et refuse les chemins dangereux", async () => {
    const id = (await createStack("app4")).json.id as string;
    const ok = await call("PUT", `/api/v1/stacks/${id}/files/nginx/default.conf`, { expectedRevision: 1, content: "server {}" });
    expect(ok.json.revision).toBe(2);
    expect((await call("GET", `/api/v1/stacks/${id}`)).json.files).toEqual(["nginx/default.conf"]);
    expect((await call("PUT", `/api/v1/stacks/${id}/files/.env`, { expectedRevision: 2, content: "x" })).status).toBe(400);
    expect((await call("PUT", `/api/v1/stacks/${id}/files/a%5Cb`, { expectedRevision: 2, content: "x" })).status).toBe(400);
    const del = await call("DELETE", `/api/v1/stacks/${id}/files/nginx/default.conf?expectedRevision=2`);
    expect(del.json.revision).toBe(3);
    expect((await call("GET", `/api/v1/stacks/${id}`)).json.files).toEqual([]);
  });

  // --- Opérations ------------------------------------------------------------------

  it("déploie exactement la révision demandée et masque les secrets dans les logs", async () => {
    const id = (await createStack("app5", { variables: { PUBLIC_PORT: "9000", TOKEN: { value: "tok-1234567890", sensitive: true } } })).json.id as string;
    const before = agent.runs.length;

    const dep = await call("POST", `/api/v1/stacks/${id}/deploy`, { pullImages: true });
    expect(dep.status).toBe(202);
    const opId = dep.json.operationId as string;
    expect(dep.headers.get("location")).toBe(`/api/v1/operations/${opId}`);

    // Une modification postérieure ne change pas l'opération en cours.
    await call("PATCH", `/api/v1/stacks/${id}/variables`, { expectedRevision: 1, set: { PUBLIC_PORT: "9999" } });

    await waitFor(() => agent.runs.length > before);
    const run = agent.runs[agent.runs.length - 1] as RunMessage;
    expect(run).toMatchObject({ action: "deploy", operationId: opId, stack: { id, project: "app5" } });
    expect(run.revision?.number).toBe(1);
    expect(run.revision?.variables.PUBLIC_PORT).toBe("9000");
    expect(run.revision?.sensitive).toEqual(["TOKEN"]);
    expect(run.options).toEqual({ pullImages: true, forceRecreate: false });

    expect(((await call("GET", `/api/v1/operations/${opId}`)).json as any).status).toBe("running");

    agent.send({ type: "operation_log", operationId: opId, text: "connexion avec tok-1234567890 ok\n" });
    agent.send({
      type: "operation_result",
      operationId: opId,
      status: "succeeded",
      images: [{ service: "web", image: "nginx:1.27", imageId: "sha256:abc", repoDigests: ["nginx@sha256:def"] }],
      services: [{ service: "web", state: "running" }],
    });
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${opId}`)).json as any).status === "succeeded");

    const op = (await call("GET", `/api/v1/operations/${opId}`)).json as any;
    expect(op.log).toContain("connexion avec *** ok");
    expect(op.log).not.toContain("tok-1234567890");
    expect(op.result.images[0].repoDigests).toEqual(["nginx@sha256:def"]);

    // La révision déployée est celle de l'opération (1), pas la courante (2).
    const detail = (await call("GET", `/api/v1/stacks/${id}`)).json as any;
    expect(detail).toMatchObject({ currentRevision: 2, deployedRevision: 1, pendingDeploy: true });
  });

  it("sérialise les opérations d'une stack et gère l'idempotence", async () => {
    const id = (await createStack("app6")).json.id as string;
    const before = agent.runs.length;
    const key = { "idempotency-key": "cle-app6-1" };

    const first = await call("POST", `/api/v1/stacks/${id}/deploy`, {}, key);
    expect(first.status).toBe(202);
    const replay = await call("POST", `/api/v1/stacks/${id}/deploy`, {}, key);
    expect(replay.status).toBe(200);
    expect(replay.json.operationId).toBe(first.json.operationId);
    expect((await call("POST", `/api/v1/stacks/${id}/stop`, {}, key)).status).toBe(422);

    const busy = await call("POST", `/api/v1/stacks/${id}/stop`);
    expect(busy.status).toBe(409);
    expect(busy.json.error.code).toBe("stack_busy");

    await waitFor(() => agent.runs.length === before + 1);
    expect(agent.runs).toHaveLength(before + 1);

    agent.send({ type: "operation_result", operationId: first.json.operationId, status: "failed", error: "pull impossible" });
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${first.json.operationId}`)).json as any).status === "failed");

    // Un échec ne change pas la révision déployée et libère la stack.
    expect(((await call("GET", `/api/v1/stacks/${id}`)).json as any).deployedRevision).toBeNull();
    expect((await call("POST", `/api/v1/stacks/${id}/stop`)).status).toBe(202);
    agent.send({ type: "operation_result", operationId: agent.runs[agent.runs.length - 1]?.operationId, status: "succeeded" });
  });

  it("n'accepte pas les retours d'un autre hôte pour une opération", async () => {
    const id = (await createStack("app7")).json.id as string;
    const before = agent.runs.length;
    const op = (await call("POST", `/api/v1/stacks/${id}/start`)).json.operationId as string;
    await waitFor(() => agent.runs.length > before);

    // Un second agent enrôlé ne peut pas conclure l'opération du premier.
    const t = (await call("POST", "/api/v1/agents/enrollment-tokens", { hostName: "autre" })).json.token as string;
    const other = await connectAgent({ kind: "enrollment", token: t });
    other.send({ type: "operation_result", operationId: op, status: "succeeded" });
    await new Promise((r) => setTimeout(r, 200));
    expect(((await call("GET", `/api/v1/operations/${op}`)).json as any).status).toBe("running");
    await other.close();

    agent.send({ type: "operation_result", operationId: op, status: "succeeded" });
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${op}`)).json as any).status === "succeeded");
  });

  // --- Logs en direct ---------------------------------------------------------------

  /** Lit un flux SSE jusqu'à ce que le texte cumulé satisfasse la condition. */
  const readSse = async (res: Response, until: (text: string) => boolean, ms = 3000): Promise<string> => {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + ms;
    while (!until(text)) {
      if (Date.now() > deadline) throw new Error("flux SSE : délai dépassé, reçu : " + text);
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    reader.releaseLock();
    return text;
  };

  it("relaie les logs en direct de l'agent vers le client et arrête le flux à la déconnexion", async () => {
    const id = (await createStack("app-logs")).json.id as string;
    expect((await fetch(`${baseUrl}/api/v1/stacks/${id}/logs`)).status).toBe(401);
    expect((await call("GET", `/api/v1/stacks/${id}/logs?service=a%20b`)).status).toBe(400);

    const ctl = new AbortController();
    const before = agent.received.length;
    const res = await fetch(`${baseUrl}/api/v1/stacks/${id}/logs?service=web&tail=50`, { headers: { cookie }, signal: ctl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    await waitFor(() => agent.received.length > before);
    const start = agent.received[agent.received.length - 1] as Record<string, any>;
    expect(start).toMatchObject({ type: "logs_start", service: "web", tail: 50, stack: { id, project: "app-logs" } });

    // Un flux inconnu n'a aucun effet ; le bon flux transmet ses lignes.
    agent.send({ type: "log_chunk", streamId: "00000000-0000-4000-8000-000000000000", lines: ["ignorée"] });
    agent.send({ type: "log_chunk", streamId: start.streamId, lines: ["2026-11-06T10:00:00Z premier", "deuxième"] });
    const text = await readSse(res, (t) => t.includes("deuxième"));
    expect(text).toContain("event: lines");
    expect(text).toContain('["2026-11-06T10:00:00Z premier","deuxième"]');
    expect(text).not.toContain("ignorée");

    ctl.abort();
    await waitFor(() => agent.received.some((m) => m.type === "logs_stop" && m.streamId === start.streamId));
  });

  it("termine le flux de logs quand l'agent le clôt", async () => {
    const id = (await createStack("app-logs2")).json.id as string;
    const before = agent.received.length;
    const res = await fetch(`${baseUrl}/api/v1/stacks/${id}/logs`, { headers: { cookie } });
    await waitFor(() => agent.received.length > before);
    const start = agent.received[agent.received.length - 1] as Record<string, any>;
    agent.send({ type: "log_end", streamId: start.streamId, reason: "Flux terminé." });
    const text = await readSse(res, (t) => t.includes("event: end"));
    expect(text).toContain('event: end\ndata: "Flux terminé."');
  });

  // --- Import d'une stack observée ---------------------------------------------------

  it("liste les projets observés et n'importe un projet existant que sur demande explicite", async () => {
    const containers = [
      { id: "c1", names: ["legacy-web-1"], image: "nginx:1.25", imageId: "sha256:1", state: "running", status: "Up", created: 1, composeProject: "legacy", composeService: "web" },
      { id: "c2", names: ["legacy-db-1"], image: "postgres:16", imageId: "sha256:2", state: "exited", status: "Exited", created: 1, composeProject: "legacy", composeService: "db" },
      { id: "c3", names: ["console-docker-console-1"], image: "x", imageId: "sha256:3", state: "running", status: "Up", created: 1, composeProject: "console-docker", composeService: "console" },
    ];
    await pool.query("UPDATE hosts SET inventory = $2, inventory_observed_at = now() WHERE id = $1", [hostId, JSON.stringify(containers)]);

    const list = (await call("GET", `/api/v1/hosts/${hostId}/projects`)).json.projects as any[];
    const legacy = list.find((p) => p.name === "legacy");
    expect(legacy).toMatchObject({ importable: true, managedStackId: null, total: 2, running: 1 });
    expect(legacy.services).toEqual([{ service: "web", image: "nginx:1.25" }, { service: "db", image: "postgres:16" }]);
    expect(list.find((p) => p.name === "console-docker").importable).toBe(false);

    const refused = await createStack("legacy");
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("project_exists_on_host");
    expect((await createStack("fantome", { adopt: true })).json.error.code).toBe("project_not_observed");
    expect((await createStack("console-docker", { adopt: true })).status).toBe(400);

    const created = await createStack("legacy", { adopt: true });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const after = (await call("GET", `/api/v1/hosts/${hostId}/projects`)).json.projects as any[];
    expect(after.find((p) => p.name === "legacy")).toMatchObject({ importable: false, managedStackId: id });

    // Premier déploiement : reprise autorisée ; elle ne l'est plus ensuite.
    const before = agent.runs.length;
    const first = (await call("POST", `/api/v1/stacks/${id}/deploy`)).json.operationId as string;
    await waitFor(() => agent.runs.length > before);
    expect(agent.runs[agent.runs.length - 1]?.options).toMatchObject({ adoptExisting: true });
    agent.send({ type: "operation_result", operationId: first, status: "succeeded" });
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${first}`)).json as any).status === "succeeded");

    const second = (await call("POST", `/api/v1/stacks/${id}/deploy`)).json.operationId as string;
    await waitFor(() => agent.runs.length > before + 1);
    expect(agent.runs[agent.runs.length - 1]?.options?.adoptExisting).toBeUndefined();
    agent.send({ type: "operation_result", operationId: second, status: "succeeded" });
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${second}`)).json as any).status === "succeeded");
  });

  it("marque une opération « inconnue » à la perte de l'agent, sans la rejouer, et refuse si hors ligne", async () => {
    const id = (await createStack("app8")).json.id as string;
    const before = agent.runs.length;
    const op = (await call("POST", `/api/v1/stacks/${id}/deploy`)).json.operationId as string;
    await waitFor(() => agent.runs.length > before);

    await agent.close();
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${op}`)).json as any).status === "unknown");
    const unknown = (await call("GET", `/api/v1/operations/${op}`)).json as any;
    expect(unknown.error).toContain("résultat inconnu");
    expect(((await call("GET", `/api/v1/stacks/${id}`)).json as any).deployedRevision).toBeNull();

    // Hors ligne : rien n'est lancé, et l'état affiché n'est pas « arrêté ».
    const offline = await call("POST", `/api/v1/stacks/${id}/deploy`);
    expect(offline.status).toBe(409);
    expect(offline.json.error.code).toBe("host_offline");
    expect(((await call("GET", `/api/v1/stacks/${id}`)).json as any).hostPresence).toBe("offline");
    expect((await call("GET", `/api/v1/stacks/${id}/logs`)).status).toBe(409);

    // À la reconnexion, le résultat tardif de l'agent est pris en compte.
    agent = await connectAgent({ kind: "credentials", agentId: hostId, secret: await currentSecret() });
    agent.send({ type: "operation_result", operationId: op, status: "succeeded" });
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${op}`)).json as any).status === "succeeded");
    expect(agent.runs.filter((r) => r.operationId === op)).toHaveLength(0);
  });

  // Le secret de l'agent n'est connu que lors de l'enrôlement : on le régénère pour le test.
  async function currentSecret(): Promise<string> {
    const { sha256 } = await import("./crypto.js");
    const secret = "secret-de-test-" + "x".repeat(32);
    await pool.query("UPDATE hosts SET secret_hash = $2 WHERE id = $1", [hostId, sha256(secret)]);
    return secret;
  }
});
