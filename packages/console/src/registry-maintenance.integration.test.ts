import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION, type ConsoleMessage } from "@infra/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { requiredRole } from "./permissions.js";
import { RegistryError } from "./registry.js";
import { RegistryGc } from "./registry-gc.js";
import { RegistryImages } from "./registry-images.js";
import { RegistryRetention } from "./registry-maintenance.js";
import { markRetention, setRetentionSettings, type RetentionInput } from "./registry-retention.js";
import { changeStack, createStack } from "./stacks.js";

const url = process.env.TEST_DATABASE_URL;
const HOST = "registry.exemple.invalid";
const sha = (c: string): string => `sha256:${c.repeat(64)}`;
const REPO_A = "patched/lib-a";
const REPO_B = "patched/lib-b";

const input = (digest: string, over: Partial<RetentionInput> = {}): RetentionInput => ({ digest, kind: "patched", createdAt: null, sourceDigest: null, deletable: true, history: [], ...over });

describe("règle de rétention (pure)", () => {
  const at = (n: number): string => new Date(2026, 10, n).toISOString();

  it("garde les N plus récentes et propose le reste", () => {
    const imgs = [1, 2, 3, 4, 5].map((n) => input(sha(String(n)), { createdAt: at(n) }));
    const marks = markRetention(imgs, { mode: "propose", keepPerRepository: 3 });
    expect([...marks].filter(([, m]) => m.candidate).map(([d]) => d).sort()).toEqual([sha("1"), sha("2")]);
    expect(marks.get(sha("5"))).toEqual({ candidate: false, reason: null });
  });

  it("ne propose jamais une image protégée, référencée par d'anciennes révisions, ou inconnue", () => {
    const imgs = [
      input(sha("1"), { createdAt: at(1), deletable: false }),
      input(sha("2"), { createdAt: at(2), history: [{}] }),
      input(sha("3"), { createdAt: at(3) }),
      input(sha("4"), { createdAt: at(4) }),
      input(sha("9"), { kind: "other" }),
    ];
    const marks = markRetention(imgs, { mode: "propose", keepPerRepository: 1 });
    expect([...marks].filter(([, m]) => m.candidate).map(([d]) => d)).toEqual([sha("3")]);
  });

  it("ne propose rien en mode désactivé", () => {
    const marks = markRetention([1, 2, 3].map((n) => input(sha(String(n)), { createdAt: at(n) })), { mode: "off", keepPerRepository: 1 });
    expect([...marks.values()].some((m) => m.candidate)).toBe(false);
  });

  it("une copie source n'est proposée que si plus aucune image corrigée conservée n'en provient", () => {
    const src = input(sha("a"), { kind: "source" });
    const kept = markRetention([src, input(sha("1"), { createdAt: at(1), sourceDigest: sha("a") })], { mode: "propose", keepPerRepository: 1 });
    expect(kept.get(sha("a"))?.candidate).toBe(false);
    const gone = markRetention([src, input(sha("1"), { createdAt: at(1), sourceDigest: sha("a") }), input(sha("2"), { createdAt: at(2), sourceDigest: sha("b") })], { mode: "propose", keepPerRepository: 1 });
    expect(gone.get(sha("1"))?.candidate).toBe(true);
    expect(gone.get(sha("a"))?.candidate).toBe(true);
    // Une copie dont aucune image corrigée ne provient (correctif en échec) est conservée.
    expect(markRetention([input(sha("c"), { kind: "source" })], { mode: "propose", keepPerRepository: 1 }).get(sha("c"))?.candidate).toBe(false);
  });
});

describe("permissions", () => {
  it("lecture pour tous, réglages, suppression et ramasse-miettes pour les administrateurs", () => {
    expect(requiredRole("GET", "/api/v1/settings/registry/retention")).toBe("viewer");
    expect(requiredRole("PUT", "/api/v1/settings/registry/retention")).toBe("admin");
    expect(requiredRole("POST", "/api/v1/settings/registry/retention/apply")).toBe("admin");
    expect(requiredRole("POST", "/api/v1/settings/registry/gc")).toBe("admin");
  });
});

describe.skipIf(!url)("rétention et ramasse-miettes du registre (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let agent: WebSocket;
  let hostId = "";
  let stackId = "";
  const deleted: string[] = [];
  let images: RegistryImages;

  // Faux registre : dépôt → tag → digest. A : P1..P5 (+ copie source) ; B : Q1 (ancien, autre source) et Q2..Q4.
  const repos: Record<string, Record<string, string>> = {};
  const reset = (): void => {
    deleted.length = 0;
    for (const k of Object.keys(repos)) delete repos[k];
    repos[REPO_A] = { "t-patch.1": sha("1"), "t-patch.2": sha("2"), "t-patch.3": sha("3"), "t-patch.4": sha("4"), "t-patch.5": sha("5"), "src-a": sha("a") };
    repos[REPO_B] = { "t-patch.1": sha("b1"), "t-patch.2": sha("b2"), "t-patch.3": sha("b3"), "t-patch.4": sha("b4"), "src-x": sha("ax"), "src-y": sha("ay") };
  };
  const fake = {
    catalog: async () => ({ repositories: Object.keys(repos), truncated: false }),
    listTags: async (ref: { repository: string }) => ({ tags: Object.keys(repos[ref.repository] ?? {}), truncated: false }),
    headManifest: async (ref: { repository: string }, tag: string) => {
      const d = repos[ref.repository]?.[tag];
      if (!d) throw new RegistryError("not_found", "introuvable");
      return { digest: d, mediaType: "application/vnd.oci.image.manifest.v1+json" };
    },
    manifestSize: async () => 1_000_000,
    deleteManifest: async (ref: { repository: string }, digest: string) => {
      deleted.push(`${ref.repository}@${digest}`);
      for (const [tag, d] of Object.entries(repos[ref.repository] ?? {})) if (d === digest) delete (repos[ref.repository] as Record<string, string>)[tag];
    },
  };

  const job = (repository: string, n: number, digests: { source: string; patched: string }, created: string, status = "validated") =>
    pool.query(
      `INSERT INTO remediation_jobs (image_id, platform, host_id, image_ref, status, requested_by, registry_host, repository, source_tag, patched_tag, patch_number, source_digest, patched_digest, created_at)
       VALUES ($1, 'linux/amd64', $2, 'x', $3, 'test', $4, $5, 'src', $6, $7, $8, $9, $10)`,
      [sha(`${repository.slice(-1)}${n}`.replace(/[^0-9a-f]/g, "0")), hostId, status, HOST, repository, `t-patch.${n}`, n, digests.source, digests.patched, created],
    );
  const candidates = async (): Promise<string[]> =>
    (await images.list()).repositories.flatMap((r) => r.images.filter((i) => i.retention.candidate).map((i) => `${r.repository}@${i.digest}`)).sort();

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
    const baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    await fetch(baseUrl + "/api/v1/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: built.setup.token, username: "boss@example.com", password: "mot-de-passe-solide-1" }) });
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
    await pool.query("INSERT INTO app_settings (key, value) VALUES ('registry', $1)", [JSON.stringify({ stackId: "00000000-0000-4000-8000-000000000000", hostId, host: HOST, entryPoint: "websecure", certResolver: "le", network: "proxy" })]);
    images = new RegistryImages(pool, fake);
    // P1 est la plus ancienne mais utilisée par la révision courante ; P2 n'est référencée que par une ancienne révision.
    const created = await createStack(pool, { name: "shop", hostId, description: "", compose: `services:\n  w:\n    image: ${HOST}/${REPO_A}@${sha("2")}\n`, variables: {}, author: "t" });
    stackId = created.id;
    await changeStack(pool, stackId, 1, "t", "r2", (c) => ({ ...c, compose: `services:\n  w:\n    image: ${HOST}/${REPO_A}@${sha("1")}\n` }));
  });
  afterAll(async () => {
    agent.close();
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    reset();
    await pool.query("DELETE FROM remediation_jobs");
    await pool.query("DELETE FROM audit_events");
    await setRetentionSettings(pool, { mode: "propose", keepPerRepository: 3, maxDeletesPerPass: 10 });
    for (let n = 1; n <= 5; n++) await job(REPO_A, n, { source: sha("a"), patched: sha(String(n)) }, `2026-11-0${n}T10:00:00Z`);
    await job(REPO_B, 1, { source: sha("ax"), patched: sha("b1") }, "2026-11-01T10:00:00Z");
    for (let n = 2; n <= 4; n++) await job(REPO_B, n, { source: sha("ay"), patched: sha(`b${n}`) }, `2026-11-0${n}T10:00:00Z`);
  });

  it("propose les images au-delà des N plus récentes, sans toucher aux protégées ni aux anciennes révisions", async () => {
    // A : P5, P4, P3 conservées ; P1 (révision courante) et P2 (ancienne révision) ne sont jamais proposées. B : Q1 proposée, et sa copie source.
    expect(await candidates()).toEqual([`${REPO_B}@${sha("ax")}`, `${REPO_B}@${sha("b1")}`].sort());
    const view = await images.list();
    expect(view).toMatchObject({ retention: { mode: "propose", keepPerRepository: 3 }, retentionCandidates: 2 });
    const a = view.repositories.find((r) => r.repository === REPO_A)!;
    expect(a.images.find((i) => i.digest === sha("1"))).toMatchObject({ deletable: false, retention: { candidate: false } });
    expect(a.images.find((i) => i.digest === sha("2"))).toMatchObject({ deletable: true, retention: { candidate: false } });
    // La copie source de A reste : P1 à P5 en proviennent.
    expect(a.images.find((i) => i.digest === sha("a"))?.retention.candidate).toBe(false);
  });

  it("n'en propose aucune quand la règle est désactivée", async () => {
    await setRetentionSettings(pool, { mode: "off", keepPerRepository: 3, maxDeletesPerPass: 10 });
    expect(await candidates()).toEqual([]);
  });

  it("supprime les candidates à la demande, sans ramasse-miettes, avec audit", async () => {
    const gcCalls: boolean[] = [];
    const retention = new RegistryRetention(pool, images, { start: async () => { gcCalls.push(true); return {} as never; } });
    const run = await retention.apply("boss@example.com", false);
    expect(run.deleted.map((d) => d.digest).sort()).toEqual([sha("ax"), sha("b1")].sort());
    expect(run).toMatchObject({ failed: [], remaining: 0, gcRequested: false });
    expect(gcCalls).toEqual([]);
    expect(await candidates()).toEqual([]);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action = 'registry.retention'")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action = 'registry.image.delete'")).rowCount).toBe(2);
  });

  it("respecte le plafond par passage", async () => {
    await setRetentionSettings(pool, { mode: "propose", keepPerRepository: 3, maxDeletesPerPass: 1 });
    const run = await new RegistryRetention(pool, images, { start: async () => ({}) as never }).apply("boss@example.com", false);
    expect(run.deleted).toHaveLength(1);
    expect(run.remaining).toBe(1);
  });

  it("le passage automatique ne fait rien hors mode « auto » ni pendant un correctif, puis supprime et demande le ramasse-miettes", async () => {
    const gcCalls: { actor: string; dryRun: boolean }[] = [];
    const retention = new RegistryRetention(pool, images, { start: async (actor: string, dryRun: boolean) => { gcCalls.push({ actor, dryRun }); return {} as never; } });
    expect(await retention.autoPass()).toBeNull();

    await setRetentionSettings(pool, { mode: "auto", keepPerRepository: 3, maxDeletesPerPass: 10 });
    await job(REPO_B, 9, { source: sha("ay"), patched: sha("b9") }, "2026-11-09T10:00:00Z", "patching");
    expect(await retention.autoPass()).toBeNull();
    expect(deleted).toEqual([]);

    await pool.query("DELETE FROM remediation_jobs WHERE status = 'patching'");
    const run = await retention.autoPass();
    expect(run?.deleted).toHaveLength(2);
    expect(run?.gcRequested).toBe(true);
    expect(gcCalls).toEqual([{ actor: "rétention", dryRun: false }]);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE actor = 'rétention'")).rowCount).toBeGreaterThan(0);
  });

  describe("ramasse-miettes", () => {
    const sent: ConsoleMessage[] = [];
    const holds: boolean[] = [];
    let online = true;
    const gc = () => new RegistryGc(pool, { isOnline: () => online, send: (_h, m) => (sent.push(m), true) }, (h) => holds.push(h));

    beforeEach(async () => {
      sent.length = 0;
      holds.length = 0;
      online = true;
      await pool.query("UPDATE hosts SET capabilities = $2::jsonb WHERE id = $1", [hostId, JSON.stringify(["registry.gc"])]);
      await pool.query("DELETE FROM remediation_jobs");
    });

    it("exige la capacité de l'agent, un hôte en ligne et aucun correctif actif", async () => {
      await pool.query("UPDATE hosts SET capabilities = $2::jsonb WHERE id = $1", [hostId, "[]"]);
      await expect(gc().start("boss", false)).rejects.toMatchObject({ status: 409, code: "agent_cannot_gc" });
      await pool.query("UPDATE hosts SET capabilities = $2::jsonb WHERE id = $1", [hostId, JSON.stringify(["registry.gc"])]);
      online = false;
      await expect(gc().start("boss", false)).rejects.toMatchObject({ status: 409, code: "host_offline" });
      online = true;
      await job(REPO_A, 9, { source: sha("a"), patched: sha("9") }, "2026-11-09T10:00:00Z", "queued");
      await expect(gc().start("boss", false)).rejects.toMatchObject({ status: 409, code: "remediation_active" });
      expect(sent).toEqual([]);
      expect(holds).toEqual([]);
    });

    it("envoie une commande sans argument libre, suspend les correctifs, puis enregistre le résultat", async () => {
      const g = gc();
      const state = await g.start("boss@example.com", true);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: "registry_gc", dryRun: true });
      expect(Object.keys(sent[0] as object).sort()).toEqual(["dryRun", "expiresAt", "requestId", "type"]);
      expect(state.running).toMatchObject({ requestedBy: "boss@example.com", dryRun: true });
      expect(holds).toEqual([true]);
      await expect(g.start("boss", false)).rejects.toMatchObject({ code: "gc_running" });

      const requestId = (sent[0] as { requestId: string }).requestId;
      // Résultat d'un autre hôte ou d'une autre demande : ignoré.
      g.onResult("00000000-0000-4000-8000-000000000000", { type: "registry_gc_result", requestId, status: "succeeded", dryRun: true });
      g.onResult(hostId, { type: "registry_gc_result", requestId: "00000000-0000-4000-8000-000000000000", status: "succeeded", dryRun: true });
      expect(g.state().running).not.toBeNull();

      g.onResult(hostId, { type: "registry_gc_result", requestId, status: "succeeded", dryRun: true, output: "ok", usedBeforeKb: 3824, usedAfterKb: 88 });
      expect(g.state().running).toBeNull();
      expect(g.state().last).toMatchObject({ status: "succeeded", dryRun: true, usedBeforeKb: 3824, usedAfterKb: 88, requestedBy: "boss@example.com" });
      expect(holds).toEqual([true, false]);
      expect((await pool.query("SELECT 1 FROM audit_events WHERE action = 'registry.gc.dry_run'")).rowCount).toBe(1);
    });

    it("signale un ramasse-miettes en échec ou indéterminé (notification), pas un réussi", async () => {
      const failures: string[] = [];
      const g = new RegistryGc(pool, { isOnline: () => true, send: () => true }, () => undefined, (o) => failures.push(o.status));
      const run = async (result: (id: string) => void): Promise<void> => {
        await g.start("boss", false);
        result(g.state().running?.requestId as string);
      };
      await run((id) => g.onResult(hostId, { type: "registry_gc_result", requestId: id, status: "succeeded", dryRun: false }));
      await run((id) => g.onResult(hostId, { type: "registry_gc_result", requestId: id, status: "failed", dryRun: false, error: "x" }));
      await run(() => g.onDisconnect(hostId));
      expect(failures).toEqual(["failed", "unknown"]);
    });

    it("une connexion perdue rend le résultat indéterminé et reprend les correctifs", async () => {
      const g = gc();
      await g.start("boss", false);
      g.onDisconnect(hostId);
      expect(g.state().last).toMatchObject({ status: "unknown" });
      expect(holds).toEqual([true, false]);
    });
  });
});
