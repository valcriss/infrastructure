import type { AgentMessage, ContainerActionMessage } from "@infra/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContainerActions } from "./container-actions.js";

const ACTION = "11111111-1111-4111-8111-111111111111";
const ID = "a".repeat(64);

let server: Server;
let socket: string;
let work: string;
let calls: string[];
let labels: Record<string, string>;
let reply: { status: number; body: unknown };

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === null ? "" : JSON.stringify(body));
};

beforeEach(async () => {
  calls = [];
  labels = {};
  reply = { status: 204, body: null };
  work = await mkdtemp(join(tmpdir(), "ca-test-"));
  socket = process.platform === "win32" ? `\\\\.\\pipe\\infra-ca-${process.pid}-${Date.now()}` : join(work, "docker.sock");
  server = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === `/containers/${ID}/json`) return json(res, 200, { Config: { Labels: labels } });
    if (req.method === "GET") return json(res, 404, { message: "no such container" });
    calls.push(`${req.method} ${url}`);
    json(res, reply.status, reply.body);
  });
  await new Promise<void>((r) => server.listen(socket, r));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(work, { recursive: true, force: true });
});

const run = async (action: ContainerActionMessage["action"], protectedProjects: string[] = [], containerId = ID): Promise<AgentMessage> => {
  const out: AgentMessage[] = [];
  const actions = new ContainerActions(socket, async (p) => protectedProjects.includes(p));
  await actions.run({ type: "container_action", actionId: ACTION, containerId, action }, (m) => out.push(m));
  expect(out).toHaveLength(1);
  return out[0] as AgentMessage;
};

describe("actions sur un conteneur isolé", () => {
  it("démarre un conteneur", async () => {
    expect(await run("start")).toEqual({ type: "container_action_result", actionId: ACTION, status: "succeeded" });
    expect(calls).toEqual([`POST /containers/${ID}/start`]);
  });

  it("laisse dix secondes au conteneur pour s'arrêter ou redémarrer", async () => {
    await run("stop");
    await run("restart");
    expect(calls).toEqual([`POST /containers/${ID}/stop?t=10`, `POST /containers/${ID}/restart?t=10`]);
  });

  it("considère « déjà dans l'état demandé » (304) comme un succès", async () => {
    reply = { status: 304, body: null };
    expect(await run("stop")).toMatchObject({ status: "succeeded" });
  });

  it("signale un conteneur introuvable", async () => {
    expect(await run("start", [], "b".repeat(64))).toMatchObject({ status: "failed", error: "Conteneur introuvable." });
    expect(calls).toEqual([]);
  });

  it("refuse les conteneurs de la console et de l'agent sans rien envoyer à Docker", async () => {
    labels = { "com.docker.compose.project": "console-docker" };
    const r = await run("stop", ["console-docker"]);
    expect(r).toMatchObject({ status: "failed" });
    expect((r as { error: string }).error).toContain("console");
    expect(calls).toEqual([]);
  });

  it("autorise un conteneur d'un autre projet Compose", async () => {
    labels = { "com.docker.compose.project": "monapp" };
    expect(await run("restart", ["console-docker"])).toMatchObject({ status: "succeeded" });
  });

  it("rapporte le message d'erreur de Docker", async () => {
    reply = { status: 500, body: { message: "driver failed programming external connectivity" } };
    const r = await run("start");
    expect(r).toMatchObject({ status: "failed" });
    expect((r as { error: string }).error).toContain("driver failed programming external connectivity");
  });
});
