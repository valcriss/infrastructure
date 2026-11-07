import { PROTOCOL_VERSION, type Container, type ImageInfo } from "@infra/shared";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { ScanService } from "./scans.js";

const url = process.env.TEST_DATABASE_URL;
const sha = (c: string) => "sha256:" + c.repeat(64);
const IMG_APP = sha("a"); // image du registre privé
const IMG_NGINX = sha("b"); // image publique (jamais interrogée : pas de registre accessible)
const IMG_LEGACY = sha("c"); // conteneur hors stack
const INDEX_V1 = sha("1");
const INDEX_V2 = sha("2");
const COMPOSE = "services:\n  web:\n    image: reg/team/app:1.0\n  worker:\n    image: nginx:1.27\n";

/** Registre privé minimal (jeton Bearer) dont le contenu du tag « 1.0 » peut changer. */
async function startRegistry() {
  const state = { index: INDEX_V1, tags: ["1.0", "1.1", "1.2", "2.0"], password: "secret", configDigest: IMG_APP, token: "T" };
  let host = "";
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (u.pathname === "/token") {
      return req.headers.authorization === "Basic " + Buffer.from(`alice:${state.password}`).toString("base64") ? send(200, { token: state.token, expires_in: 300 }) : send(401, {});
    }
    if (req.headers.authorization !== `Bearer ${state.token}`) return send(401, {}, { "www-authenticate": `Bearer realm="http://${host}/token",service="fake"` });
    if (u.pathname === "/v2/") return send(200, {});
    if (u.pathname === "/v2/team/app/manifests/1.0" || u.pathname === `/v2/team/app/manifests/${state.index}`) {
      return send(200, { manifests: [{ digest: sha("3"), platform: { os: "linux", architecture: "amd64" } }] }, { "docker-content-digest": state.index, "content-type": "application/vnd.oci.image.index.v1+json" });
    }
    if (u.pathname === `/v2/team/app/manifests/${sha("3")}`) {
      return send(200, { config: { digest: state.configDigest } }, { "docker-content-digest": sha("3"), "content-type": "application/vnd.oci.image.manifest.v1+json" });
    }
    if (u.pathname === "/v2/team/app/tags/list") return send(200, { tags: state.tags });
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { state, host, close: () => new Promise((r) => server.close(() => r(null))) };
}

describe.skipIf(!url)("images, scans Trivy et suivi des versions (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let baseUrl: string;
  let wsUrl: string;
  let cookie = "";
  let root: string;
  let hostId = "";
  let stackId = "";
  let ws: WebSocket;
  let registry: Awaited<ReturnType<typeof startRegistry>>;
  const scanMessages: Record<string, any>[] = [];
  const runs: Record<string, any>[] = [];

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };
  const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > ms) throw new Error("délai dépassé");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const connect = (auth: object): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const sock = new WebSocket(wsUrl);
      sock.on("open", () => sock.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, agentVersion: "t", hostname: "h", capabilities: ["scan.trivy"], auth })));
      sock.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, any>;
        if (msg.type === "welcome") {
          if (msg.credentials) hostId = msg.agentId;
          resolve(sock);
        } else if (msg.type === "scan") scanMessages.push(msg);
        else if (msg.type === "run") runs.push(msg);
        else if (msg.type === "error") reject(new Error(msg.message));
      });
      sock.on("error", reject);
    });

  const ctr = (svc: string, image: string, imageId: string, project = "app"): Container => ({
    id: `c-${svc}`, names: [`${project}-${svc}-1`], image, imageId, state: "running", status: "Up", created: 1,
    composeProject: project, composeService: svc, health: "none", restartCount: 0, startedAt: new Date().toISOString(), exitCode: 0,
  });
  const info = (id: string, tag: string, digest: string): ImageInfo => ({ id, repoTags: [tag], repoDigests: digest ? [digest] : [], size: 5_000_000, os: "linux", arch: "amd64" });

  const sendInventory = async () => {
    const containers = [
      ctr("web", `${registry.host}/team/app:1.0`, IMG_APP),
      ctr("worker", "127.0.0.1:1/team/worker:1.0", IMG_NGINX),
      ctr("x", "legacy/tool:1", IMG_LEGACY, "legacy"),
    ];
    const images = [
      info(IMG_APP, `${registry.host}/team/app:1.0`, `${registry.host}/team/app@${INDEX_V1}`),
      info(IMG_NGINX, "127.0.0.1:1/team/worker:1.0", `127.0.0.1:1/team/worker@${sha("d")}`),
      info(IMG_LEGACY, "legacy/tool:1", `legacy/tool@${sha("e")}`),
    ];
    ws.send(JSON.stringify({ type: "inventory", inventory: { observedAt: new Date().toISOString(), dockerVersion: "29", containers, images } }));
    await waitFor(async () => ((await pool.query("SELECT jsonb_array_length(images) AS n FROM hosts WHERE id = $1", [hostId])).rows[0]?.n ?? 0) === 3);
  };

  const result = (scanId: string, over: Record<string, unknown> = {}) =>
    ws.send(
      JSON.stringify({
        type: "scan_result",
        scanId,
        status: "succeeded",
        trivy: { version: "0.76.1", dbVersion: 2, dbUpdatedAt: "2026-11-06T18:00:00Z", dbDownloadedAt: "2026-11-06T20:00:00Z" },
        os: { family: "alpine", name: "3.12.12", eosl: true },
        counts: { critical: 1, high: 1, medium: 0, low: 1, unknown: 0 },
        total: 3,
        vulnerabilities: [
          { id: "CVE-2026-0001", pkg: "openssl", installed: "1.1.1", fixed: "1.1.2", severity: "CRITICAL", title: "Débordement", url: "https://avd.aquasec.com/nvd/cve-2026-0001", status: "fixed" },
          { id: "CVE-2026-0002", pkg: "zlib", installed: "1.2.12", fixed: null, severity: "HIGH", title: "Lecture hors limites", url: null },
          { id: "CVE-2026-0003", pkg: "busybox", installed: "1.31", fixed: "1.32", severity: "LOW", title: "Mineure", url: null },
        ],
        truncated: false,
        ...over,
      }),
    );

  const imageView = async (imageId: string) => ((await call("GET", "/api/v1/images")).json.images as any[]).find((i) => i.imageId === imageId);

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    registry = await startRegistry();
    root = mkdtempSync(join(tmpdir(), "infra-img-"));
    const sharedDir = mkdtempSync(join(root, "shared-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      allowInsecureGit: true,
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir, webDir: null, secureCookies: false, dataDir: mkdtempSync(join(root, "data-")), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    wsUrl = baseUrl.replace("http", "ws") + "/agent/ws";
    const setup = await fetch(`${baseUrl}/api/v1/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" }) });
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    ws = await connect({ kind: "enrollment", token: readFileSync(join(sharedDir, "bootstrap-token"), "utf8").trim() });
    stackId = (await call("POST", "/api/v1/stacks", { name: "app", hostId, compose: COMPOSE })).json.id as string;
    const dep = (await call("POST", `/api/v1/stacks/${stackId}/deploy`)).json.operationId as string;
    await waitFor(() => runs.length > 0);
    ws.send(JSON.stringify({ type: "operation_result", operationId: dep, status: "succeeded" }));
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${dep}`)).json as any).status === "succeeded");
    await sendInventory();
  });

  afterAll(async () => {
    ws?.close();
    await built.app.close();
    await registry.close();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("exige une authentification", async () => {
    for (const path of ["/api/v1/images", "/api/v1/settings/security", "/api/v1/registries"]) expect((await fetch(baseUrl + path)).status).toBe(401);
  });

  // === Scans ===========================================================================================

  it("relie chaque image à ses stacks, services et conteneurs, et distingue « jamais scanné »", async () => {
    const images = (await call("GET", "/api/v1/images")).json.images as any[];
    expect(images).toHaveLength(3);
    const app = images.find((i) => i.imageId === IMG_APP);
    expect(app).toMatchObject({ platform: "linux/amd64", managed: true, scan: { state: "never", current: null } });
    expect(app.usedBy).toEqual([expect.objectContaining({ stackName: "app", service: "web", hostId, state: "running" })]);
    expect(images.find((i) => i.imageId === IMG_LEGACY)).toMatchObject({ managed: false });
    expect((await call("GET", `/api/v1/images?stackId=${stackId}`)).json.images).toHaveLength(2);
  });

  it("scanne une image, dédoublonne les demandes et expose le résultat daté avec la fraîcheur de la base", async () => {
    const first = await call("POST", `/api/v1/images/${IMG_APP}/scans`, {});
    expect(first.status).toBe(202);
    await waitFor(() => scanMessages.length === 1);
    expect(scanMessages[0]).toMatchObject({ type: "scan", imageId: IMG_APP, scanId: first.json.scanId });
    expect(((await call("GET", `/api/v1/scans/${first.json.scanId}`)).json as any).status).toBe("running");

    const again = await call("POST", `/api/v1/images/${IMG_APP}/scans`, {});
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ scanId: first.json.scanId, created: false }); // un seul scan actif par contenu
    expect(scanMessages).toHaveLength(1);

    result(first.json.scanId as string);
    await waitFor(async () => (await imageView(IMG_APP)).scan.state === "vulnerable");
    const v = await imageView(IMG_APP);
    expect(v.scan.current).toMatchObject({ total: 3, counts: { critical: 1, high: 1, low: 1 }, trivyVersion: "0.76.1", dbUpdatedAt: "2026-11-06T18:00:00.000Z", os: { family: "alpine", eosl: true } });
    expect(v.scan.current.finishedAt).not.toBeNull();
  });

  it("filtre et pagine les vulnérabilités", async () => {
    const all = (await call("GET", `/api/v1/images/${IMG_APP}/scan?platform=${encodeURIComponent("linux/amd64")}`)).json;
    expect(all.total).toBe(3);
    expect(all.vulnerabilities[0]).toMatchObject({ id: "CVE-2026-0001", pkg: "openssl", installed: "1.1.1", fixed: "1.1.2", severity: "CRITICAL", url: expect.stringContaining("avd.aquasec.com") });
    const q = (query: string) => call("GET", `/api/v1/images/${IMG_APP}/scan?platform=linux%2Famd64&${query}`);
    expect((await q("severity=HIGH")).json.vulnerabilities.map((x: any) => x.id)).toEqual(["CVE-2026-0002"]);
    expect((await q("q=zlib")).json.total).toBe(1);
    expect((await q("limit=1&offset=1")).json.vulnerabilities.map((x: any) => x.id)).toEqual(["CVE-2026-0002"]);
    expect((await q("severity=ENORME")).status).toBe(400);
    expect((await call("GET", `/api/v1/images/${IMG_NGINX}/scan?platform=linux%2Famd64`)).status).toBe(404); // jamais scannée
    expect((await call("GET", "/api/v1/images/pas-un-id/scan")).status).toBe(400);
  });

  it("un scan en échec n'est jamais présenté comme sain, et le dernier résultat réussi reste daté", async () => {
    const r = await call("POST", `/api/v1/images/${IMG_APP}/scans`, {});
    await waitFor(() => scanMessages.length === 2);
    result(r.json.scanId as string, { status: "failed", error: "Trivy a échoué (code 1) : base indisponible", counts: undefined, total: undefined, vulnerabilities: undefined, trivy: undefined, os: undefined });
    await waitFor(async () => (await imageView(IMG_APP)).scan.state === "failed");
    const v = await imageView(IMG_APP);
    expect(v.scan.lastAttempt).toMatchObject({ status: "failed", error: expect.stringContaining("base indisponible") });
    expect(v.scan.current).toMatchObject({ total: 3 }); // l'observation précédente est conservée
    const alerts = ((await call("GET", "/api/v1/dashboard")).json.alerts as any[]).map((a) => a.kind);
    expect(alerts).toContain("scan_failed");
    expect(alerts).toContain("vulnerabilities_critical");
  });

  it("distingue « aucune vulnérabilité connue » (scan réussi) de « jamais scanné »", async () => {
    const r = await call("POST", `/api/v1/images/${IMG_NGINX}/scans`, {});
    await waitFor(() => scanMessages.length === 3);
    result(r.json.scanId as string, { counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, total: 0, vulnerabilities: [] });
    await waitFor(async () => (await imageView(IMG_NGINX)).scan.state === "clean");
    expect((await imageView(IMG_NGINX)).scan.current.total).toBe(0);
    expect((await imageView(IMG_LEGACY)).scan.state).toBe("never");
  });

  it("exécute un seul scan à la fois par hôte et enchaîne la file d'attente", async () => {
    await pool.query("DELETE FROM image_scans");
    scanMessages.length = 0;
    const a = await call("POST", `/api/v1/images/${IMG_APP}/scans`, {});
    const b = await call("POST", `/api/v1/images/${IMG_LEGACY}/scans`, {});
    await waitFor(() => scanMessages.length === 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(scanMessages).toHaveLength(1); // le second attend
    expect(((await call("GET", `/api/v1/scans/${b.json.scanId}`)).json as any).status).toBe("pending");
    result(a.json.scanId as string);
    await waitFor(() => scanMessages.length === 2);
    expect(scanMessages[1]).toMatchObject({ imageId: IMG_LEGACY, scanId: b.json.scanId });
    result(b.json.scanId as string, { counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }, total: 0, vulnerabilities: [] });
    await waitFor(async () => (await imageView(IMG_LEGACY)).scan.state === "clean");
  });

  it("planifie les scans des images de stacks (pas les autres) et relance ceux qui sont périmés", async () => {
    await pool.query("DELETE FROM image_scans");
    scanMessages.length = 0;
    expect(await built.scans.scheduledPass(24)).toBe(2); // app + nginx ; l'image hors stack est ignorée
    await waitFor(() => scanMessages.length === 1);
    for (const m of [...scanMessages]) result(m.scanId);
    await waitFor(() => scanMessages.length === 2);
    result(scanMessages[1]?.scanId);
    await waitFor(async () => (await imageView(IMG_NGINX)).scan.state !== "never" && (await imageView(IMG_APP)).scan.state !== "never");
    expect((await pool.query("SELECT count(*)::int AS n FROM image_scans WHERE trigger = 'scheduled'")).rows[0].n).toBe(2);

    expect(await built.scans.scheduledPass(24)).toBe(0); // récents : rien à faire
    await pool.query("UPDATE image_scans SET finished_at = now() - interval '30 hours' WHERE image_id = $1", [IMG_APP]);
    expect(await built.scans.scheduledPass(24)).toBe(1); // la base de vulnérabilités a évolué depuis
  });

  it("marque en échec un scan interrompu par la perte de l'agent, sans le rejouer", async () => {
    await pool.query("DELETE FROM image_scans");
    scanMessages.length = 0;
    const r = await call("POST", `/api/v1/images/${IMG_APP}/scans`, {});
    await waitFor(() => scanMessages.length === 1);
    await new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
      ws.close();
    });
    await waitFor(async () => ((await call("GET", `/api/v1/scans/${r.json.scanId}`)).json as any).status === "failed");
    expect(((await call("GET", `/api/v1/scans/${r.json.scanId}`)).json as any).error).toContain("Connexion à l'agent perdue");
    expect((await call("POST", `/api/v1/images/${IMG_APP}/scans`, {})).status).toBe(409); // hôte hors ligne : rien n'est lancé
    ws = await connect({ kind: "credentials", agentId: hostId, secret: await resetSecret() });
    await sendInventory();
  });

  async function resetSecret(): Promise<string> {
    const { sha256 } = await import("./crypto.js");
    const secret = "secret-de-test-" + "x".repeat(32);
    await pool.query("UPDATE hosts SET secret_hash = $2 WHERE id = $1", [hostId, sha256(secret)]);
    return secret;
  }

  // === Registres et suivi des versions ===================================================================

  it("enregistre les identifiants d'un registre privé sans jamais les renvoyer", async () => {
    const put = await call("PUT", `/api/v1/registries/${encodeURIComponent(registry.host)}`, { username: "alice", password: "secret", insecure: true });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ registry: registry.host, username: "alice", hasPassword: true, insecure: true });
    expect(JSON.stringify(put.json)).not.toContain("secret");
    const list = (await call("GET", "/api/v1/registries")).json.registries as any[];
    expect(list).toEqual([{ registry: registry.host, username: "alice", hasPassword: true, insecure: true }]);
    const row = (await pool.query("SELECT password_enc FROM registry_credentials")).rows[0];
    expect(row.password_enc).toMatch(/^v1:/);
    expect(row.password_enc).not.toContain("secret");

    expect((await call("POST", `/api/v1/registries/${encodeURIComponent(registry.host)}/test`)).json).toEqual({ ok: true });
    expect((await call("PUT", "/api/v1/registries/pas%20valide", { insecure: false })).status).toBe(400);
    expect((await call("PUT", `/api/v1/registries/${encodeURIComponent(registry.host)}`, { username: "alice", insecure: true })).status).toBe(200); // mot de passe conservé
    expect((await call("POST", `/api/v1/registries/${encodeURIComponent(registry.host)}/test`)).json.ok).toBe(true);
  });

  const checkNow = async () => {
    await call("POST", `/api/v1/stacks/${stackId}/image-checks`);
    // La vérification est asynchrone : on attend qu'elle soit terminée.
    await waitFor(async () => (await call("GET", `/api/v1/stacks/${stackId}/images`)).json.checking === false);
    return ((await call("GET", `/api/v1/stacks/${stackId}/images`)).json.components as any[]).find((x) => x.service === "web");
  };

  it("détecte qu'un tag n'a pas changé, puis qu'il pointe vers un autre contenu — sans rien déployer", async () => {
    const runsBefore = runs.length;
    const ok = await checkNow();
    expect(ok.check).toMatchObject({ status: "ok", kind: "up_to_date", detail: { contentChanged: false, deployedDigest: INDEX_V1, platform: "linux/amd64" } });

    registry.state.index = INDEX_V2; // le tag « 1.0 » est republié
    registry.state.configDigest = sha("f"); // avec une autre configuration d'image
    const changed = await checkNow();
    expect(changed.check).toMatchObject({ kind: "update_available", detail: { contentChanged: true, remoteDigest: INDEX_V2 } });
    expect(runs.length).toBe(runsBefore); // aucune opération de déploiement
    const alert = ((await call("GET", "/api/v1/dashboard")).json.alerts as any[]).find((a) => a.kind === "image_update");
    expect(alert).toMatchObject({ severity: "info" });
    expect(alert.message).toContain("Rien n'est déployé automatiquement");
  });

  it("propose de nouveaux tags selon la règle du composant et la sauvegarde dans Git", async () => {
    expect((await call("PUT", `/api/v1/stacks/${stackId}/services/web/update-policy`, { policy: "pattern", pattern: "(a+)+" })).status).toBe(400); // expression dangereuse
    expect((await call("PUT", `/api/v1/stacks/${stackId}/services/web/update-policy`, { policy: "banane" })).status).toBe(400);
    expect((await call("PUT", `/api/v1/stacks/${stackId}/services/web/update-policy`, { policy: "minor" })).status).toBe(200);
    const withTags = await checkNow();
    expect(withTags.policy).toEqual({ policy: "minor", pattern: null });
    expect(withTags.check.detail.candidates).toEqual(["1.2", "1.1"]); // pas 2.0 : autre version majeure
    expect(withTags.check.detail.uncertain).toBe(false);
    expect((await pool.query("SELECT policy FROM image_policies WHERE service = 'web'")).rows[0].policy).toBe("minor");
  });

  it("conserve la dernière observation datée quand le registre refuse l'accès", async () => {
    const good = await checkNow();
    const lastSuccess = good.check.lastSuccessAt as string;
    registry.state.password = "autre-mot-de-passe"; // les identifiants enregistrés ne sont plus valides
    registry.state.token = "T2"; // et le jeton en cache est révoqué côté registre
    const failed = await checkNow();
    expect(failed.check).toMatchObject({ status: "error", error: expect.stringContaining("refusés"), kind: "update_available" });
    expect(failed.check.detail.candidates).toEqual(["1.2", "1.1"]); // observation précédente conservée…
    expect(failed.check.lastSuccessAt).toBe(lastSuccess); // …avec sa date
    expect((await call("POST", `/api/v1/registries/${encodeURIComponent(registry.host)}/test`)).json).toMatchObject({ ok: false, code: "auth" });
    registry.state.password = "secret";
    registry.state.token = "T3";
  });

  it("ne compare pas une image locale, épinglée ou venant d'un registre inaccessible, et le dit", async () => {
    // Le registre de « worker » est injoignable : échec explicite, jamais un faux « à jour ».
    const worker = ((await call("GET", `/api/v1/stacks/${stackId}/images`)).json.components as any[]).find((x) => x.service === "worker");
    expect(worker.check).toMatchObject({ status: "error", error: expect.stringContaining("injoignable"), kind: null, detail: null, lastSuccessAt: null });
  });

  it("ne signale que les gravités choisies (seuil minimal, « inconnues »), sans relancer de scan", async () => {
    const r = await call("POST", `/api/v1/images/${IMG_APP}/scans`, {});
    const before = (await call("GET", "/api/v1/images")).json.images.find((i: any) => i.imageId === IMG_APP);
    // Aucun scan réussi n'est nécessairement présent ici : on en fabrique un avec toutes les gravités.
    const scanId = (r.json.scanId ?? before?.scan?.lastAttempt?.id) as string;
    result(scanId, { counts: { critical: 1, high: 2, medium: 3, low: 4, unknown: 5 }, total: 15, vulnerabilities: [
      { id: "CVE-A", pkg: "a", installed: "1", fixed: null, severity: "CRITICAL", title: "c", url: null },
      { id: "CVE-B", pkg: "b", installed: "1", fixed: null, severity: "LOW", title: "l", url: null },
      { id: "CVE-C", pkg: "c", installed: "1", fixed: null, severity: "UNKNOWN", title: "u", url: null },
    ] });
    await waitFor(async () => (await imageView(IMG_APP))?.scan.current?.total === 15);
    const put = (body: Record<string, unknown>) => call("PUT", "/api/v1/settings/security", { scanIntervalHours: 24, imageCheckIntervalHours: 24, ...body });

    // Seuil « élevée » sans les inconnues : 1 critique + 2 élevées signalées, le reste est masqué mais reste stocké.
    expect((await put({ minSeverity: "HIGH", includeUnknown: false })).status).toBe(200);
    const view = await imageView(IMG_APP);
    expect(view.scan.current).toMatchObject({ counts: { critical: 1, high: 2, medium: 0, low: 0, unknown: 0 }, total: 3, hidden: 12 });
    const dash = (await call("GET", "/api/v1/dashboard")).json;
    expect(dash.security.images).toMatchObject({ critical: 1, high: 2, withCritical: 1 });
    const apps = (await call("GET", "/api/v1/applications")).json.applications as any[];
    expect(apps.flatMap((a) => a.images).find((i) => i.imageId === IMG_APP).counts).toMatchObject({ medium: 0, low: 0, unknown: 0 });
    const details = (await call("GET", `/api/v1/images/${IMG_APP}/scan`)).json;
    expect(details.vulnerabilities.map((v: any) => v.id)).toEqual(["CVE-A"]);

    // Seuil « critique » : plus de « élevées » ; les inconnues repassent avec l'option.
    expect((await put({ minSeverity: "CRITICAL", includeUnknown: true })).status).toBe(200);
    expect((await imageView(IMG_APP)).scan.current).toMatchObject({ counts: { critical: 1, high: 0, unknown: 5 }, total: 6, hidden: 9 });
    expect((await call("GET", "/api/v1/dashboard")).json.security.images).toMatchObject({ withCritical: 1, withHigh: 0 });
    expect((await put({})).status).toBe(200); // retour aux valeurs par défaut (LOW, inconnues incluses)
    expect((await imageView(IMG_APP)).scan.current).toMatchObject({ total: 15, hidden: 0 });
  });

  it("règle les périodes planifiées (0 = désactivé) et refuse les valeurs invalides", async () => {
    expect((await call("GET", "/api/v1/settings/security")).json).toEqual({ scanIntervalHours: 24, imageCheckIntervalHours: 24, minSeverity: "LOW", includeUnknown: true });
    expect((await call("PUT", "/api/v1/settings/security", { scanIntervalHours: 0, imageCheckIntervalHours: 12 })).status).toBe(200);
    expect((await call("GET", "/api/v1/settings/security")).json).toEqual({ scanIntervalHours: 0, imageCheckIntervalHours: 12, minSeverity: "LOW", includeUnknown: true });
    expect((await call("PUT", "/api/v1/settings/security", { scanIntervalHours: 0, imageCheckIntervalHours: 12, minSeverity: "URGENT" })).status).toBe(400);
    expect((await call("PUT", "/api/v1/settings/security", { scanIntervalHours: -1, imageCheckIntervalHours: 12 })).status).toBe(400);
    expect((await call("PUT", "/api/v1/settings/security", { scanIntervalHours: 1.5, imageCheckIntervalHours: 12 })).status).toBe(400);
  });

  const insertScan = (image: string, status: string, ageHours: number, extra = "") =>
    pool.query(
      `INSERT INTO image_scans (image_id, platform, host_id, image_ref, status, trigger, requested_by, created_at, finished_at, counts, total)
       VALUES ($1, 'linux/amd64', $2, 'x:1', $3, 'manual', 'test', now() - make_interval(hours => $4), ${status === "pending" || status === "running" ? "NULL" : "now() - make_interval(hours => $4)"}, ${status === "succeeded" ? "'{\"critical\":1,\"high\":0,\"medium\":0,\"low\":0,\"unknown\":0}'::jsonb" : "NULL"}, ${status === "succeeded" ? "1" : "NULL"})
       RETURNING id${extra}`,
      [image, hostId, status, ageHours],
    );

  /** Images « présentes » sur l'hôte (liste de l'inventaire) : un scan en attente sur une autre image serait abandonné. */
  const withImages = (host: string, ids: string[]) =>
    pool.query("UPDATE hosts SET images = coalesce(images, '[]'::jsonb) || $2::jsonb WHERE id = $1", [host, JSON.stringify(ids.map((id) => ({ id })))]);

  it("conserve le dernier scan réussi même après une longue série d'échecs", async () => {
    const img = sha("7");
    await insertScan(img, "succeeded", 240);
    for (let h = 1; h <= 6; h++) await insertScan(img, "failed", h);
    const running = (await insertScan(img, "running", 0)).rows[0].id as string;
    await built.scans.onResult(hostId, { type: "scan_result", scanId: running, status: "failed", error: "Trivy indisponible" } as never);
    const rows = (await pool.query("SELECT status FROM image_scans WHERE image_id = $1", [img])).rows as { status: string }[];
    expect(rows.filter((r) => r.status === "succeeded")).toHaveLength(1); // le dernier résultat réussi n'a pas été purgé
    expect(rows.length).toBeLessThanOrEqual(6); // l'historique reste borné
    expect((await built.scans.latestSucceeded(img, "linux/amd64"))?.total).toBe(1);
  });

  it("n'exécute jamais deux scans à la fois sur un hôte, même si deux démarrages se font concurrence", async () => {
    await pool.query("UPDATE image_scans SET status = 'failed', finished_at = now() WHERE status IN ('pending', 'running')");
    const [a, b] = [sha("8"), sha("9")];
    await withImages(hostId, [a, b]);
    await insertScan(a, "pending", 0);
    await insertScan(b, "pending", 0);
    await Promise.all([built.scans.pump(hostId), built.scans.pump(hostId), built.scans.pump(hostId)]);
    const running = (await pool.query("SELECT count(*)::int AS n FROM image_scans WHERE host_id = $1 AND status = 'running'", [hostId])).rows[0].n;
    expect(running).toBe(1);
    await pool.query("UPDATE image_scans SET status = 'failed', finished_at = now() WHERE status IN ('pending', 'running')");
  });

  it("un scan en attente sur un hôte hors ligne ne bloque pas l'image pour les autres hôtes", async () => {
    await pool.query("UPDATE image_scans SET status = 'failed', finished_at = now() WHERE status IN ('pending', 'running')");
    const other = (await pool.query("INSERT INTO hosts (name, secret_hash) VALUES ('autre-hote', 'x') RETURNING id")).rows[0].id as string;
    const sent: string[] = [];
    const svc = new ScanService(pool, { isOnline: (id) => id === hostId, send: (id, m) => (sent.push(`${id}:${m.type}`), true) });

    const img = sha("6");
    await pool.query(
      `INSERT INTO image_scans (image_id, platform, host_id, image_ref, status, trigger, requested_by, created_at) VALUES ($1, 'linux/amd64', $2, 'x:1', 'pending', 'manual', 'test', now())`,
      [img, other],
    );
    // Un autre hôte, en ligne, demande le même contenu : le scan bloqué est abandonné et un nouveau est lancé ici.
    const { scan, created } = await svc.request({ imageId: img, platform: "linux/amd64", hostId, imageRef: "x:1", trigger: "manual", requestedBy: "test" });
    expect(created).toBe(true);
    expect(scan.hostId).toBe(hostId);
    expect((await pool.query("SELECT status, error FROM image_scans WHERE host_id = $1 AND image_id = $2", [other, img])).rows[0]).toMatchObject({ status: "failed" });

    // Sans autre demande, un scan en attente depuis longtemps sur un hôte hors ligne est abandonné par la planification.
    const old = sha("5");
    await pool.query(
      `INSERT INTO image_scans (image_id, platform, host_id, image_ref, status, trigger, requested_by, created_at) VALUES ($1, 'linux/amd64', $2, 'x:1', 'pending', 'manual', 'test', now() - interval '30 minutes')`,
      [old, other],
    );
    await (svc as unknown as { abandonStalePending(): Promise<void> }).abandonStalePending();
    expect((await pool.query("SELECT status FROM image_scans WHERE image_id = $1", [old])).rows[0].status).toBe("failed");
    await pool.query("DELETE FROM hosts WHERE id = $1", [other]);
    await pool.query("UPDATE image_scans SET status = 'failed', finished_at = now() WHERE status IN ('pending', 'running')");
  });

  it("retire les vérifications de versions d'un service qui n'existe plus dans le Compose déployé", async () => {
    await pool.query(
      `INSERT INTO image_checks (stack_id, service, checked_at, status, kind, detail, last_success_at)
       VALUES ($1, 'fantome', now(), 'ok', 'update_available', '{"ref":"x:1","candidates":["x:2"],"notes":[],"contentChanged":false,"policy":"minor"}'::jsonb, now())`,
      [stackId],
    );
    expect((await pool.query("SELECT count(*)::int AS n FROM image_checks WHERE service = 'fantome'")).rows[0].n).toBe(1);
    await checkNow();
    expect((await pool.query("SELECT count(*)::int AS n FROM image_checks WHERE service = 'fantome'")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM image_checks WHERE stack_id = $1 AND service = 'web'", [stackId])).rows[0].n).toBe(1); // les services existants restent
  });

  it("scanne plusieurs images à la suite : un seul scan à la fois, file d'attente visible, annulation", async () => {
    await pool.query("DELETE FROM image_scans");
    const batch = (body: Record<string, unknown>) => call("POST", "/api/v1/images/scans", body);

    // Décompte (rien n'est lancé) selon le périmètre.
    expect((await batch({ scope: "never", dryRun: true })).json).toMatchObject({ dryRun: true, total: 3, requested: 3, alreadyQueued: 0, skippedOffline: 0 });
    expect((await batch({ scope: "never", managedOnly: true, dryRun: true })).json).toMatchObject({ total: 2, requested: 2 }); // l'image hors application est exclue
    expect((await pool.query("SELECT count(*)::int AS n FROM image_scans")).rows[0].n).toBe(0);

    // Lancement : un en cours, les autres en attente, dans l'ordre.
    const started = await batch({ scope: "never" });
    expect(started.status).toBe(202);
    expect(started.json).toMatchObject({ dryRun: false, requested: 3 });
    const counts = (await pool.query("SELECT status, count(*)::int AS n FROM image_scans GROUP BY status")).rows as { status: string; n: number }[];
    expect(counts.find((c) => c.status === "running")?.n).toBe(1);
    expect(counts.find((c) => c.status === "pending")?.n).toBe(2);

    const listing = (await call("GET", "/api/v1/images")).json;
    expect(listing.queue).toMatchObject({ pending: 2, running: 1, current: { imageRef: expect.any(String) } });
    const states = (listing.images as any[]).map((i) => [i.scan.state, i.scan.queuePosition]).sort();
    expect(states).toEqual([["pending", 1], ["pending", 2], ["running", null]]);

    // Une nouvelle demande n'ajoute rien : tout est déjà en file ou en cours.
    expect((await batch({ scope: "all" })).json).toMatchObject({ requested: 0, alreadyQueued: 3 });

    // Annulation : seuls les scans en attente sont retirés, celui en cours va à son terme.
    expect((await call("DELETE", "/api/v1/images/scans/queue")).json).toEqual({ removed: 2, interrupted: 0 });
    expect((await pool.query("SELECT count(*)::int AS n FROM image_scans WHERE status = 'running'")).rows[0].n).toBe(1);
    expect((await call("GET", "/api/v1/images")).json.queue).toMatchObject({ pending: 0, running: 1 });

    // Le scan en cours se termine ; « jamais scannées » ne le recompte plus, « périmées » le reprend quand il vieillit.
    const running = (await pool.query("SELECT id FROM image_scans WHERE status = 'running'")).rows[0].id as string;
    result(running);
    await waitFor(async () => (await pool.query("SELECT count(*)::int AS n FROM image_scans WHERE status = 'succeeded'")).rows[0].n === 1);
    expect((await batch({ scope: "never", dryRun: true })).json).toMatchObject({ total: 2, requested: 2 });
    expect((await batch({ scope: "outdated", dryRun: true })).json).toMatchObject({ total: 2 });
    await pool.query("UPDATE image_scans SET finished_at = now() - interval '10 days' WHERE status = 'succeeded'");
    expect((await batch({ scope: "outdated", dryRun: true })).json).toMatchObject({ total: 3 });
    expect((await batch({ scope: "all", dryRun: true })).json).toMatchObject({ total: 3 });
    expect((await batch({ scope: "inconnu" })).status).toBe(400);
    expect((await fetch(baseUrl + "/api/v1/images/scans", { method: "POST" })).status).toBe(401);
    await pool.query("DELETE FROM image_scans");
  });

  it("la file est unique pour tous les hôtes : un scan à la fois, le suivant démarre à la fin du précédent", async () => {
    await pool.query("DELETE FROM image_scans");
    const hostB = (await pool.query("INSERT INTO hosts (name, secret_hash) VALUES ('hote-b', 'x') RETURNING id")).rows[0].id as string;
    const sent: string[] = [];
    const svc = new ScanService(pool, { isOnline: () => true, send: (id, m) => (sent.push(`${id === hostId ? "A" : "B"}:${(m as { scanId: string }).scanId}`), true) });
    const request = (host: string, image: string) => svc.request({ imageId: image, platform: "linux/amd64", hostId: host, imageRef: "x:1", trigger: "manual", requestedBy: "test" });

    await withImages(hostId, [sha("1"), sha("3")]);
    const first = await request(hostId, sha("1"));
    const second = await request(hostB, sha("2")); // un autre hôte, mais la file est unique
    const third = await request(hostId, sha("3"));
    expect(sent).toHaveLength(1); // seul le premier a démarré
    const status = async (id: string) => (await pool.query("SELECT status FROM image_scans WHERE id = $1", [id])).rows[0].status as string;
    expect([await status(first.scan.id), await status(second.scan.id), await status(third.scan.id)]).toEqual(["running", "pending", "pending"]);

    // Fin du premier : le plus ancien en attente (celui de l'autre hôte) démarre, puis le troisième.
    await svc.onResult(hostId, { type: "scan_result", scanId: first.scan.id, status: "failed", error: "x" } as never);
    expect([await status(second.scan.id), await status(third.scan.id)]).toEqual(["running", "pending"]);
    expect(sent[1]).toBe(`B:${second.scan.id}`);
    await svc.onResult(hostB, { type: "scan_result", scanId: second.scan.id, status: "failed", error: "x" } as never);
    expect(await status(third.scan.id)).toBe("running");
    await pool.query("DELETE FROM image_scans");
    await pool.query("DELETE FROM hosts WHERE id = $1", [hostB]);
  });

  it("abandonne un scan en attente dont l'image a disparu de l'hôte (application mise à jour) et passe au suivant", async () => {
    await pool.query("DELETE FROM image_scans");
    const gone = sha("4"); // plus dans la liste d'images de l'hôte : remplacée par une mise à jour
    const present = sha("3");
    await withImages(hostId, [present]);
    const old = (await insertScan(gone, "pending", 2)).rows[0].id as string; // le plus ancien : il passerait en premier
    const next = (await insertScan(present, "pending", 1)).rows[0].id as string;
    await built.scans.pump(hostId);
    const status = async (id: string) => (await pool.query("SELECT status, error FROM image_scans WHERE id = $1", [id])).rows[0] as { status: string; error: string | null };
    expect(await status(old)).toMatchObject({ status: "failed", error: expect.stringContaining("retirée de l'hôte") });
    expect((await status(next)).status).toBe("running"); // la file n'est pas bloquée
    await pool.query("DELETE FROM image_scans");
  });

  it("fait avancer la file même quand la planification échoue", async () => {
    await pool.query("DELETE FROM image_scans");
    await withImages(hostId, [sha("2")]);
    await insertScan(sha("2"), "pending", 0);
    const svc = new ScanService(pool, { isOnline: () => true, send: () => true });
    vi.spyOn(svc, "scheduledPass").mockRejectedValue(new Error("planification en panne"));
    await svc.tick(); // ne lève pas, et la file avance malgré l'échec
    expect((await pool.query("SELECT status FROM image_scans WHERE image_id = $1", [sha("2")])).rows[0].status).toBe("running");
    await pool.query("DELETE FROM image_scans");
  });

  it("permet de débloquer la file : le scan en cours est déclaré perdu et les scans en attente reprennent", async () => {
    await pool.query("DELETE FROM image_scans");
    await withImages(hostId, [sha("5"), sha("6")]);
    const lost = (await insertScan(sha("5"), "running", 1)).rows[0].id as string;
    await pool.query("UPDATE image_scans SET started_at = now() - interval '15 minutes' WHERE id = $1", [lost]);
    const waiting = (await insertScan(sha("6"), "pending", 0)).rows[0].id as string;
    await built.scans.pump(hostId);
    expect((await pool.query("SELECT status FROM image_scans WHERE id = $1", [waiting])).rows[0].status).toBe("pending"); // bloquée derrière le scan perdu

    const out = await call("DELETE", "/api/v1/images/scans/queue?only=running");
    expect(out.json).toEqual({ removed: 0, interrupted: 1 });
    expect((await pool.query("SELECT status, error FROM image_scans WHERE id = $1", [lost])).rows[0]).toMatchObject({ status: "failed", error: expect.stringContaining("Interrompu") });
    expect((await pool.query("SELECT status FROM image_scans WHERE id = $1", [waiting])).rows[0].status).toBe("running"); // la file a repris
    expect((await call("DELETE", "/api/v1/images/scans/queue?only=inconnu")).status).toBe(400);
    await pool.query("DELETE FROM image_scans");
  });

  it("supprime un registre configuré", async () => {
    expect((await call("DELETE", `/api/v1/registries/${encodeURIComponent(registry.host)}`)).status).toBe(204);
    expect((await call("DELETE", `/api/v1/registries/${encodeURIComponent(registry.host)}`)).status).toBe(404);
    expect(((await call("GET", "/api/v1/registries")).json.registries as unknown[]).length).toBe(0);
  });
});
