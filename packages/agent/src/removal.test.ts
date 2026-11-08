import type { RunMessage } from "@infra/shared";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeRemoval, planRemoval } from "./removal.js";

const STACK = "11111111-1111-4111-8111-111111111111";
const LABEL = "com.docker.compose.project";

interface FakeState {
  project: { Id: string; Names: string[]; Image: string; ImageID: string; State: string; Mounts?: { Type: string; Source: string }[] }[];
  others: { ImageID: string }[];
  volumes: Record<string, Record<string, string> | null>;
  networks: { Id: string; Name: string }[];
  calls: string[];
  failDelete: Set<string>;
}

let server: Server;
let socket: string;
let state: FakeState;
let work: string;

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

beforeEach(async () => {
  state = { project: [], others: [], volumes: {}, networks: [], calls: [], failDelete: new Set() };
  work = await mkdtemp(join(tmpdir(), "rm-test-"));
  socket = process.platform === "win32" ? `\\\\.\\pipe\\infra-rm-${process.pid}-${Date.now()}` : join(work, "docker.sock");
  server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? "");
    const method = req.method ?? "GET";
    if (method === "GET" && url.startsWith("/containers/json")) {
      if (url.includes("filters=")) return json(res, 200, state.project);
      return json(res, 200, [...state.project.map((c) => ({ ...c, Labels: { [LABEL]: "app" } })), ...state.others.map((o) => ({ ...o, Labels: {} }))]);
    }
    if (method === "GET" && url.startsWith("/networks")) return json(res, 200, state.networks);
    if (method === "GET" && url.startsWith("/system/df")) return json(res, 200, { Volumes: Object.keys(state.volumes).map((Name) => ({ Name, UsageData: { Size: 2048 } })) });
    if (method === "GET" && url.startsWith("/volumes/")) {
      const name = url.slice("/volumes/".length);
      return name in state.volumes ? json(res, 200, { Name: name, Labels: state.volumes[name] }) : json(res, 404, { message: "no such volume" });
    }
    if (method === "GET" && url.startsWith("/volumes")) return json(res, 200, { Volumes: Object.entries(state.volumes).filter(([, l]) => l?.[LABEL] === "app").map(([Name]) => ({ Name })) });
    if (method === "DELETE") {
      state.calls.push(url);
      if ([...state.failDelete].some((f) => url.includes(f))) return json(res, 409, { message: "conflict: in use" });
      res.writeHead(url.startsWith("/images/") ? 200 : 204);
      return res.end(url.startsWith("/images/") ? "[]" : "");
    }
    json(res, 404, { message: "?" });
  });
  await new Promise<void>((r) => server.listen(socket, r));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(work, { recursive: true, force: true });
});

const run = (removal: NonNullable<RunMessage["removal"]>): RunMessage => ({
  type: "run",
  operationId: "22222222-2222-4222-8222-222222222222",
  action: "destroy",
  stack: { id: STACK, project: "app" },
  removal,
});
const none = { networks: false, volumes: [], images: [], workspace: false };
const container = (over: Partial<FakeState["project"][number]> = {}) => ({ Id: "c1", Names: ["/app-web-1"], Image: "app-web-custom:local", ImageID: "sha256:aa", State: "exited", ...over });

describe("planRemoval", () => {
  it("décrit conteneurs, réseaux, volumes avec taille, images partagées, dossiers montés et dossier de travail", async () => {
    state.project = [container({ Mounts: [{ Type: "bind", Source: "/home/u/store" }, { Type: "volume", Source: "/var/lib/x" }] }), container({ Id: "c2", Names: ["/app-db-1"], Image: "postgres:17", ImageID: "sha256:bb" })];
    state.others = [{ ImageID: "sha256:bb" }, { ImageID: "sha256:bb" }];
    state.networks = [{ Id: "n1", Name: "app_default" }];
    state.volumes = { app_data: { [LABEL]: "app" }, other_data: { [LABEL]: "other" } };
    await mkdir(join(work, STACK), { recursive: true });
    const plan = await planRemoval(socket, work, { type: "removal_plan", planId: "33333333-3333-4333-8333-333333333333", stack: { id: STACK, project: "app" } });
    expect(plan).toMatchObject({ running: 0, workspace: true, binds: ["/home/u/store"], networks: [{ id: "n1", name: "app_default" }], volumes: [{ name: "app_data", sizeBytes: 2048 }] });
    expect(plan.containers.map((c) => c.name)).toEqual(["app-web-1", "app-db-1"]);
    expect(plan.images).toEqual([
      { ref: "app-web-custom:local", id: "sha256:aa", usedByOthers: 0 },
      { ref: "postgres:17", id: "sha256:bb", usedByOthers: 2 },
    ]);
  });

  it("compte les conteneurs en marche", async () => {
    state.project = [container({ State: "running" })];
    const plan = await planRemoval(socket, work, { type: "removal_plan", planId: "33333333-3333-4333-8333-333333333333", stack: { id: STACK, project: "app" } });
    expect(plan.running).toBe(1);
  });
});

describe("executeRemoval", () => {
  it("refuse sans rien supprimer si un conteneur est en marche", async () => {
    state.project = [container({ State: "running" })];
    await expect(executeRemoval(socket, work, run(none), () => {})).rejects.toThrow(/en marche/);
    expect(state.calls).toEqual([]);
  });

  it("supprime conteneurs, réseaux, volumes et images cochés, et le dossier de travail", async () => {
    state.project = [container()];
    state.networks = [{ Id: "n1", Name: "app_default" }];
    state.volumes = { app_data: { [LABEL]: "app" } };
    await mkdir(join(work, STACK), { recursive: true });
    await writeFile(join(work, STACK, ".env"), "SECRET=1");
    await mkdir(join(work, `${STACK}.staging`), { recursive: true });
    const lines: string[] = [];
    await executeRemoval(socket, work, run({ networks: true, volumes: ["app_data"], images: ["app-web-custom:local"], workspace: true }), (l) => lines.push(l));
    expect(state.calls).toEqual(["/containers/c1?force=false&v=false", "/networks/n1", "/volumes/app_data", "/images/app-web-custom:local?force=false"]);
    await expect(stat(join(work, STACK))).rejects.toThrow();
    await expect(stat(join(work, `${STACK}.staging`))).rejects.toThrow();
    expect(lines.join("\n")).toMatch(/Conteneur app-web-1 supprimé/);
  });

  it("ne touche pas aux réseaux, volumes et dossier non cochés", async () => {
    state.project = [container()];
    state.networks = [{ Id: "n1", Name: "app_default" }];
    state.volumes = { app_data: { [LABEL]: "app" } };
    await mkdir(join(work, STACK), { recursive: true });
    await executeRemoval(socket, work, run(none), () => {});
    expect(state.calls).toEqual(["/containers/c1?force=false&v=false"]);
    expect((await stat(join(work, STACK))).isDirectory()).toBe(true);
  });

  it("refuse un volume ou une image qui n'appartient pas au projet, et rapporte l'échec à la fin", async () => {
    state.project = [container()];
    state.volumes = { foreign: { [LABEL]: "other" } };
    await expect(executeRemoval(socket, work, run({ ...none, volumes: ["foreign"], images: ["nginx:latest"] }), () => {})).rejects.toThrow(/volume foreign.*n'appartient pas.*image nginx:latest/);
    expect(state.calls).toEqual(["/containers/c1?force=false&v=false"]);
  });

  it("conserve une image utilisée par un autre projet", async () => {
    state.project = [container()];
    state.others = [{ ImageID: "sha256:aa" }];
    const lines: string[] = [];
    await executeRemoval(socket, work, run({ ...none, images: ["app-web-custom:local"] }), (l) => lines.push(l));
    expect(state.calls.some((c) => c.startsWith("/images/"))).toBe(false);
    expect(lines.join("\n")).toMatch(/conservée : utilisée par un autre projet/);
  });

  it("signale l'échec d'une suppression (ex. élément en cours d'utilisation) sans s'arrêter en route", async () => {
    state.project = [container()];
    state.networks = [{ Id: "n1", Name: "app_default" }];
    state.failDelete.add("/networks/n1");
    await expect(executeRemoval(socket, work, run({ ...none, networks: true }), () => {})).rejects.toThrow(/réseau app_default : conflict: in use/);
  });
});
