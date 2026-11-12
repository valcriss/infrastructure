import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION, type Container, type ImageInfo } from "@infra/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { requiredRole } from "./permissions.js";
import { AUTO_ACTOR, RemediationAuto, getAutoSettings, imageKey, setAutoSettings } from "./remediation-auto.js";
import { createStack } from "./stacks.js";

const url = process.env.TEST_DATABASE_URL;
const sha = (c: string): string => `sha256:${c.repeat(64)}`;
const IMG = { A: sha("a"), B: sha("b"), C: sha("c"), D: sha("d"), E: sha("e") };
const REF = { A: "alpine:3.20", B: "ghcr.io/org/app:1", C: "nginx:1.27", D: "postgres:16", E: "redis:7" };
const FIXABLE: Record<string, number> = { [IMG.A]: 5, [IMG.B]: 9, [IMG.C]: 20, [IMG.D]: 30, [IMG.E]: 2 };

describe("clé d'image et réglages", () => {
  it("normalise une image sans étiquette", () => {
    expect(imageKey("postgres:16")).toBe("docker.io/library/postgres");
    expect(imageKey("ghcr.io/org/app:2")).toBe("ghcr.io/org/app");
    expect(imageKey("pas une image !!")).toBeNull();
  });

  it("réserve la lecture à tous, l'écriture et le passage immédiat aux administrateurs, la relecture aux opérateurs", () => {
    expect(requiredRole("GET", "/api/v1/settings/remediation")).toBe("viewer");
    expect(requiredRole("PUT", "/api/v1/settings/remediation")).toBe("admin");
    expect(requiredRole("POST", "/api/v1/settings/remediation/run")).toBe("admin");
    expect(requiredRole("GET", "/api/v1/remediations/to-review")).toBe("viewer");
    expect(requiredRole("POST", "/api/v1/remediations/:id/review")).toBe("operator");
  });
});

describe.skipIf(!url)("préparation planifiée des correctifs (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let agent: WebSocket;
  let hostId = "";
  let baseUrl = "";
  let admin = "";
  const created: { imageId: string; requestedBy: string }[] = [];
  let online = true;

  const fake = {
    eligibility: async (imageId: string) => ({ canStart: true, fixableOs: FIXABLE[imageId] ?? 0 }) as never,
    create: async (input: { imageId: string; requestedBy: string }) => {
      created.push({ imageId: input.imageId, requestedBy: input.requestedBy });
      return { job: {} as never, created: true };
    },
  };
  const auto = () => new RemediationAuto(pool, fake, () => online);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, { method, headers: { cookie: admin, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: (() => { try { return JSON.parse(text) as Record<string, any>; } catch { return {}; } })() };
  };
  const job = (imageId: string, status: string, over: { by?: string; finishedAgo?: string; reviewed?: boolean; n?: number } = {}) =>
    pool.query(
      `INSERT INTO remediation_jobs (image_id, platform, host_id, image_ref, status, requested_by, registry_host, repository, source_tag, patched_tag, patch_number,
                                     patched_digest, finished_at, reviewed_at)
       VALUES ($1, 'linux/amd64', $2, 'x', $3, $4, 'registry.exemple.invalid', 'patched/x', 'src', $5, $6, $7, now() - $8::interval, $9) RETURNING id`,
      [imageId, hostId, status, over.by ?? AUTO_ACTOR, `t-patch.${over.n ?? 1}`, over.n ?? 1, ["validated", "partial"].includes(status) ? sha("9") : null, over.finishedAgo ?? "0 seconds", over.reviewed ? new Date() : null],
    );

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

    // Applications gérées : app (image A), shop (image B) et legacy (image D, exclue plus loin) ; C n'est qu'observée, E a déjà un correctif.
    for (const name of ["app", "shop", "legacy", "old"]) await createStack(pool, { name, hostId, description: "", compose: `services:\n  s:\n    image: ${name}\n`, variables: {}, author: "t" });
    const ctr = (svc: string, image: string, imageId: string, project: string): Container => ({
      id: `c-${project}`, names: [`${project}-${svc}-1`], image, imageId, state: "running", status: "Up", created: 1, composeProject: project, composeService: svc,
      health: "none", restartCount: 0, startedAt: new Date().toISOString(), exitCode: 0,
    });
    const info = (id: string, tag: string): ImageInfo => ({ id, repoTags: [tag], repoDigests: [], size: 5_000_000, os: "linux", arch: "amd64" });
    const containers = [ctr("s", REF.A, IMG.A, "app"), ctr("s", REF.B, IMG.B, "shop"), ctr("s", REF.C, IMG.C, "observed"), ctr("s", REF.D, IMG.D, "legacy"), ctr("s", REF.E, IMG.E, "old")];
    const images = [info(IMG.A, REF.A), info(IMG.B, REF.B), info(IMG.C, REF.C), info(IMG.D, REF.D), info(IMG.E, REF.E)];
    await pool.query("UPDATE hosts SET inventory = $2::jsonb, images = $3::jsonb WHERE id = $1", [hostId, JSON.stringify(containers), JSON.stringify(images)]);
    // E a déjà été préparée (par n'importe qui) : jamais retentée automatiquement. Cette ligne compte aussi pour le plafond du jour.
    await job(IMG.E, "validated", { by: "boss@example.com", n: 1 });
  });
  afterAll(async () => {
    agent.close();
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    created.length = 0;
    online = true;
    await pool.query("DELETE FROM app_settings WHERE key = 'remediation_auto'");
    await pool.query("DELETE FROM remediation_jobs WHERE requested_by = $1", [AUTO_ACTOR]);
  });

  it("est désactivée par défaut : aucun correctif n'est préparé", async () => {
    expect(await getAutoSettings(pool)).toEqual({ enabled: false, maxPerDay: 3, excluded: [] });
    expect(await auto().pass()).toEqual({ started: 0, skipped: "disabled" });
    expect(created).toEqual([]);
  });

  it("prépare les images des applications gérées, les plus corrigeables d'abord, sans toucher aux autres", async () => {
    await setAutoSettings(pool, { enabled: true, maxPerDay: 10, excluded: ["postgres"] });
    const result = await auto().pass();
    expect(result).toEqual({ started: 2, skipped: null });
    // B (9 CVE) avant A (5) ; C n'est qu'observée, D est exclue, E a déjà un correctif.
    expect(created).toEqual([
      { imageId: IMG.B, requestedBy: AUTO_ACTOR },
      { imageId: IMG.A, requestedBy: AUTO_ACTOR },
    ]);
  });

  it("respecte le plafond par 24 h", async () => {
    await setAutoSettings(pool, { enabled: true, maxPerDay: 1, excluded: ["postgres"] });
    expect(await auto().pass()).toEqual({ started: 1, skipped: null });
    expect(created.map((c) => c.imageId)).toEqual([IMG.B]);

    await job(IMG.A, "validated", { n: 2 });
    expect((await auto().state()).usedToday).toBe(1);
    expect(await auto().pass()).toEqual({ started: 0, skipped: "daily_limit" });
  });

  it("ne retente jamais une image déjà préparée, même en échec ou refusée", async () => {
    await setAutoSettings(pool, { enabled: true, maxPerDay: 10, excluded: ["postgres"] });
    await job(IMG.B, "failed", { by: "boss@example.com", n: 3 });
    await auto().pass();
    expect(created.map((c) => c.imageId)).toEqual([IMG.A]);
  });

  it("ignore un hôte hors ligne", async () => {
    await setAutoSettings(pool, { enabled: true, maxPerDay: 10, excluded: [] });
    online = false;
    expect(await auto().pass()).toEqual({ started: 0, skipped: null });
    expect(created).toEqual([]);
  });

  it("se met en pause 24 h après trois échecs automatiques consécutifs, et reprend ensuite", async () => {
    await setAutoSettings(pool, { enabled: true, maxPerDay: 10, excluded: [] });
    for (const n of [11, 12, 13]) await job(IMG.A, "failed", { n, finishedAgo: "1 hour" });
    const state = await auto().state();
    expect(state.pausedUntil).not.toBeNull();
    expect(await auto().pass()).toEqual({ started: 0, skipped: "paused" });
    expect(created).toEqual([]);

    // Échecs anciens : la pause est terminée.
    await pool.query("UPDATE remediation_jobs SET finished_at = now() - interval '2 days' WHERE requested_by = $1", [AUTO_ACTOR]);
    expect((await auto().state()).pausedUntil).toBeNull();
  });

  it("une réussite ou un refus parmi les derniers résultats évite la pause", async () => {
    await setAutoSettings(pool, { enabled: true, maxPerDay: 10, excluded: [] });
    await job(IMG.A, "failed", { n: 11, finishedAgo: "3 hours" });
    await job(IMG.A, "rejected", { n: 12, finishedAgo: "2 hours" });
    await job(IMG.A, "failed", { n: 13, finishedAgo: "1 hour" });
    expect((await auto().state()).pausedUntil).toBeNull();
  });

  it("valide les exclusions et les normalise", async () => {
    const saved = await setAutoSettings(pool, { enabled: true, maxPerDay: 2, excluded: ["postgres", "docker.io/library/postgres", "ghcr.io/org/app"] });
    expect(saved.excluded).toEqual(["docker.io/library/postgres", "ghcr.io/org/app"]);
    await expect(setAutoSettings(pool, { enabled: true, maxPerDay: 2, excluded: ["pas une image !!"] })).rejects.toMatchObject({ status: 400 });
    // Pas de version : une exclusion vise toute l'image.
    await expect(setAutoSettings(pool, { enabled: true, maxPerDay: 2, excluded: ["postgres:15"] })).rejects.toMatchObject({ status: 400 });
    await expect(setAutoSettings(pool, { enabled: true, maxPerDay: 2, excluded: ["ghcr.io/org/app@sha256:" + "a".repeat(64)] })).rejects.toMatchObject({ status: 400 });
    expect((await setAutoSettings(pool, { enabled: true, maxPerDay: 2, excluded: ["localhost:5000/app"] })).excluded).toEqual(["localhost:5000/app"]);
  });

  it("expose les réglages et l'état par l'API, et trace l'activation", async () => {
    const before = await call("GET", "/api/v1/settings/remediation");
    expect(before.status).toBe(200);
    expect(before.json).toMatchObject({ settings: { enabled: false, maxPerDay: 3 }, usedToday: 0, pausedUntil: null });
    const put = await call("PUT", "/api/v1/settings/remediation", { enabled: true, maxPerDay: 2, excluded: ["postgres"] });
    expect(put.status).toBe(200);
    expect(put.json.settings).toEqual({ enabled: true, maxPerDay: 2, excluded: ["docker.io/library/postgres"] });
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action = 'remediation.auto.enable'")).rowCount).toBe(1);
    expect((await call("PUT", "/api/v1/settings/remediation", { enabled: true, maxPerDay: 99, excluded: [] })).status).toBe(400);
    const run = await call("POST", "/api/v1/settings/remediation/run");
    expect(run.status).toBe(200);
    expect(run.json).toHaveProperty("started");
    await call("PUT", "/api/v1/settings/remediation", { enabled: false, maxPerDay: 3, excluded: [] });
  });

  it("signale « à relire » les correctifs automatiques utilisables, jusqu'à ce qu'un utilisateur les relise", async () => {
    const ready = (await job(IMG.A, "validated", { n: 21 })).rows[0].id as string;
    const partial = (await job(IMG.B, "partial", { n: 22 })).rows[0].id as string;
    await job(IMG.C, "rejected", { n: 23 });
    await job(IMG.D, "validated", { by: "boss@example.com", n: 24 });
    const active = (await job(IMG.A, "patching", { n: 25 })).rows[0].id as string;

    const list = (await call("GET", "/api/v1/remediations/to-review")).json.remediations as { id: string; automatic: boolean }[];
    expect(list.map((j) => j.id).sort()).toEqual([ready, partial].sort());
    expect(list.every((j) => j.automatic)).toBe(true);

    const reviewed = await call("POST", `/api/v1/remediations/${ready}/review`);
    expect(reviewed.status).toBe(200);
    expect(reviewed.json).toMatchObject({ reviewedBy: "boss@example.com", automatic: true });
    const after = (await call("GET", "/api/v1/remediations/to-review")).json.remediations as { id: string }[];
    expect(after.map((j) => j.id)).toEqual([partial]);

    expect((await call("POST", `/api/v1/remediations/${active}/review`)).status).toBe(409);
    expect((await call("POST", "/api/v1/remediations/00000000-0000-4000-8000-000000000000/review")).status).toBe(404);
  });
});
