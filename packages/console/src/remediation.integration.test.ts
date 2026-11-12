import { PROTOCOL_VERSION, type Container, type ImageInfo } from "@infra/shared";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { requiredRole } from "./permissions.js";

const url = process.env.TEST_DATABASE_URL;
const sha = (c: string) => "sha256:" + c.repeat(64);
const IMG = sha("a");
const IMG_EOL = sha("b");
const PLATFORM = "linux/amd64";
const REGISTRY = "registry.exemple.invalid";

const vuln = (id: string, severity: string, fixed: string | null, pkg = "libssl3") => ({ id, pkg, installed: "1.0", fixed, severity });
const counts = (vs: { severity: string }[]) => ({
  critical: vs.filter((v) => v.severity === "CRITICAL").length, high: vs.filter((v) => v.severity === "HIGH").length,
  medium: vs.filter((v) => v.severity === "MEDIUM").length, low: vs.filter((v) => v.severity === "LOW").length, unknown: 0,
});
const patchScan = (vs: ReturnType<typeof vuln>[]) => ({ counts: counts(vs), total: vs.length, vulnerabilities: vs, truncated: false });
const BEFORE = [vuln("CVE-1", "CRITICAL", "2"), vuln("CVE-2", "HIGH", "2", "zlib"), vuln("CVE-3", "LOW", null)];

describe.skipIf(!url)("remédiation des images (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let baseUrl: string;
  let admin = "";
  let hostId = "";
  let creds: { agentId: string; secret: string } | null = null;
  let ws: WebSocket;
  const received: Record<string, any>[] = [];

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, { method, headers: { cookie: admin, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: (() => { try { return JSON.parse(text) as Record<string, any>; } catch { return {}; } })() };
  };
  const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > ms) throw new Error("délai dépassé");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const connect = (auth: object, capabilities: string[]): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const sock = new WebSocket(baseUrl.replace("http", "ws") + "/agent/ws");
      sock.on("open", () => sock.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, agentVersion: "t", hostname: "h", capabilities, auth })));
      sock.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, any>;
        if (msg.type === "welcome") {
          if (msg.credentials) {
            hostId = msg.agentId;
            creds = msg.credentials;
          }
          resolve(sock);
        } else received.push(msg);
      });
      sock.on("error", reject);
    });
  const status = async (id: string) => (await call("GET", `/api/v1/remediations/${id}`)).json;

  const ctr = (svc: string, image: string, imageId: string, project = "app"): Container => ({
    id: `c-${project}-${svc}`, names: [`${project}-${svc}-1`], image, imageId, state: "running", status: "Up", created: 1,
    composeProject: project, composeService: svc, health: "none", restartCount: 0, startedAt: new Date().toISOString(), exitCode: 0,
  });
  const info = (id: string, tag: string): ImageInfo => ({ id, repoTags: [tag], repoDigests: [], size: 5_000_000, os: "linux", arch: "amd64" });
  const sendInventory = async () => {
    const containers = [ctr("web", "alpine:3.22.0", IMG), ctr("old", "alpine:3.12", IMG_EOL), ctr("api", "alpine:3.22.0", IMG, "app2"), ctr("shared", "alpine:3.22.0", IMG, "app3"), ctr("secret", "alpine:3.22.0", IMG, "app4"), ctr("multi", "alpine:3.22.0", IMG, "app5")];
    const images = [info(IMG, "alpine:3.22.0"), info(IMG_EOL, "alpine:3.12")];
    ws.send(JSON.stringify({ type: "inventory", inventory: { observedAt: new Date().toISOString(), dockerVersion: "29", containers, images } }));
    await waitFor(async () => ((await pool.query("SELECT jsonb_array_length(images) AS n FROM hosts WHERE id = $1", [hostId])).rows[0]?.n ?? 0) === 2);
  };
  /** Scan réussi pour une image (l'agent simulé répond à la demande de scan). */
  const scanned = async (imageId: string, os: Record<string, unknown>, vulns: ReturnType<typeof vuln>[]) => {
    const before = received.length;
    const r = await call("POST", `/api/v1/images/${imageId}/scans`, { platform: PLATFORM });
    expect([200, 202]).toContain(r.status);
    await waitFor(() => received.slice(before).some((m) => m.type === "scan"));
    const scan = received.slice(before).find((m) => m.type === "scan");
    ws.send(JSON.stringify({ type: "scan_result", scanId: scan?.scanId, status: "succeeded", os, counts: counts(vulns), total: vulns.length, vulnerabilities: vulns.map((v) => ({ ...v, title: "t", url: null, kind: "os" })), truncated: false }));
    await waitFor(async () => (await call("GET", `/api/v1/images/${imageId}/remediation/eligibility?platform=${PLATFORM}`)).json.reason !== "no_scan");
  };
  const start = async () => {
    const before = received.length;
    const r = await call("POST", `/api/v1/images/${IMG}/remediations`, { platform: PLATFORM });
    return { r, wait: async () => { await waitFor(() => received.slice(before).some((m) => m.type === "patch")); return received.slice(before).find((m) => m.type === "patch") as Record<string, any>; } };
  };
  const finish = (jobId: string, over: Record<string, unknown> = {}) =>
    ws.send(JSON.stringify({
      type: "patch_result", jobId, status: "succeeded",
      tools: { copa: "0.15.0", buildkit: "v0.35.0", trivy: "0.76.1" },
      source: { ref: `${REGISTRY}/r:src`, digest: sha("1") }, patched: { ref: `${REGISTRY}/r:t`, digest: sha("2") },
      before: patchScan(BEFORE), after: patchScan([vuln("CVE-3", "LOW", null)]),
      packageChanges: [{ name: "libssl3", from: "3.5.0-r0", to: "3.5.9-r0" }], configChanges: [], labelsAdded: ["BaseImage"], vexStatements: 2,
      ...over,
    }));

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
    ws = await connect({ kind: "enrollment", token }, ["scan.trivy", "image.patch"]);
    await sendInventory();
  });
  afterAll(async () => {
    ws.close();
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });

  it("refuse sans scan, puis détecte une distribution en fin de vie", async () => {
    const e = await call("GET", `/api/v1/images/${IMG}/remediation/eligibility?platform=${PLATFORM}`);
    expect(e.status).toBe(200);
    expect(e.json).toMatchObject({ eligible: false, reason: "no_scan", canStart: false });
    expect((await call("GET", "/api/v1/images/" + sha("9") + "/remediation/eligibility")).status).toBe(404);

    await scanned(IMG_EOL, { family: "alpine", name: "3.12.12", eosl: true }, [vuln("CVE-9", "CRITICAL", "2")]);
    const eol = (await call("GET", `/api/v1/images/${IMG_EOL}/remediation/eligibility?platform=${PLATFORM}`)).json;
    expect(eol).toMatchObject({ eligible: false, reason: "eol", canStart: false });
    const refused = await call("POST", `/api/v1/images/${IMG_EOL}/remediations`, { platform: PLATFORM });
    expect(refused.status).toBe(409);
    expect(refused.json.error?.code ?? refused.json.code).toBe("not_eligible_eol");
  });

  it("une image éligible attend un registre privé déployé", async () => {
    await scanned(IMG, { family: "alpine", name: "3.22.0", eosl: false }, BEFORE);
    const e = (await call("GET", `/api/v1/images/${IMG}/remediation/eligibility?platform=${PLATFORM}`)).json;
    expect(e).toMatchObject({ eligible: true, reason: "ok", fixableOs: 2, unfixable: 1, canStart: false, registry: { ready: false } });
    expect(e.hosts).toEqual([expect.objectContaining({ online: true, capable: true })]);
    expect((await call("POST", `/api/v1/images/${IMG}/remediations`, { platform: PLATFORM })).status).toBe(409);

    // Registre créé (Traefik puis registry), puis déployé.
    expect((await call("POST", "/api/v1/settings/traefik/application", { hostId, email: "a@exemple.fr", network: { mode: "create", name: "traefik-public" } })).status).toBe(201);
    expect((await call("POST", "/api/v1/settings/registry/application", { host: REGISTRY })).status).toBe(201);
    expect((await call("GET", `/api/v1/images/${IMG}/remediation/eligibility?platform=${PLATFORM}`)).json.registry.reason).toContain("pas déployée");
    await pool.query("UPDATE stacks SET deployed_revision = current_revision WHERE name = 'registry'");
    expect((await call("GET", `/api/v1/images/${IMG}/remediation/eligibility?platform=${PLATFORM}`)).json).toMatchObject({ canStart: true, registry: { ready: true, reason: null } });
  });

  it("lance un correctif : message figé vers l'agent, un seul job actif, mot de passe jamais exposé par l'API", async () => {
    const { r, wait } = await start();
    expect(r.status).toBe(202);
    const msg = await wait();
    expect(msg).toMatchObject({
      type: "patch", jobId: r.json.remediationId, imageId: IMG, platform: PLATFORM, timeoutSec: 1800,
      target: { registry: REGISTRY, repository: "patched/docker-io-library-alpine", sourceTag: "src-" + "a".repeat(12), patchedTag: "3.22.0-patch.1" },
    });
    expect(msg.registryAuths).toEqual([expect.objectContaining({ registry: REGISTRY, username: "infrastructure" })]);
    expect(Object.keys(msg).sort()).toEqual(["expiresAt", "imageId", "imageRef", "jobId", "platform", "registryAuths", "target", "timeoutSec", "type"]);

    expect((await status(r.json.remediationId)).status).toBe("preparing");
    // Même contenu d'image : le job actif est renvoyé, rien n'est dupliqué.
    const again = await call("POST", `/api/v1/images/${IMG}/remediations`, { platform: PLATFORM });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ remediationId: r.json.remediationId, created: false });
    expect((await pool.query("SELECT count(*)::int AS n FROM remediation_jobs")).rows[0].n).toBe(1);

    const password = msg.registryAuths[0].password as string;
    const detail = JSON.stringify((await status(r.json.remediationId)));
    expect(detail).not.toContain(password);
    expect(JSON.stringify((await call("GET", "/api/v1/remediations")).json)).not.toContain(password);

    ws.send(JSON.stringify({ type: "patch_progress", jobId: msg.jobId, stage: "patching" }));
    await waitFor(async () => (await status(msg.jobId)).status === "patching");
    // Un agent qui ne sait pas annuler (capacité absente) : refus clair, le job continue.
    const noCancel = await call("POST", `/api/v1/remediations/${msg.jobId}/cancel`);
    expect(noCancel.status).toBe(409);
    expect(noCancel.json.error?.code ?? noCancel.json.code).toBe("agent_cannot_cancel");
    expect((await status(msg.jobId)).status).toBe("patching");
  });

  it("calcule le verdict d'après les deux scans et publie la référence immuable", async () => {
    const jobId = (await call("GET", "/api/v1/remediations")).json.remediations[0].id as string;
    finish(jobId);
    await waitFor(async () => (await status(jobId)).status === "validated");
    const job = await status(jobId);
    expect(job).toMatchObject({
      status: "validated", active: false, patchedDigest: sha("2"), sourceDigest: sha("1"), patchedRef: `${REGISTRY}/patched/docker-io-library-alpine@${sha("2")}`,
      tools: { copa: "0.15.0" }, vexStatements: 2, configChanges: [], labelsAdded: ["BaseImage"],
    });
    expect(job.bilan.cves).toMatchObject({ before: 3, after: 1, fixableBefore: 2, resolved: 2, remainingFixable: 0, unfixable: 1, new: 0 });
    expect(job.bilan.resolved.map((v: any) => v.id)).toEqual(["CVE-1", "CVE-2"]);
    expect(job.packageChanges).toEqual([{ name: "libssl3", from: "3.5.0-r0", to: "3.5.9-r0" }]);
    // Dans la liste, les détails volumineux sont omis.
    const list = (await call("GET", `/api/v1/remediations?imageId=${IMG}`)).json.remediations;
    expect(list).toHaveLength(1);
    expect(list[0].bilan.resolved).toEqual([]);
    expect(list[0].packageChanges).toBeNull();
    // Un résultat rejoué est ignoré.
    finish(jobId, { before: patchScan([]), after: patchScan([]) });
    await new Promise((r) => setTimeout(r, 150));
    expect((await status(jobId)).status).toBe("validated");
  });

  it("refuse un correctif qui change la configuration, et prend le numéro de tag suivant", async () => {
    const { r, wait } = await start();
    expect(r.status).toBe(202);
    const msg = await wait();
    expect(msg.target.patchedTag).toBe("3.22.0-patch.2");
    finish(msg.jobId, { configChanges: ["Entrypoint"] });
    await waitFor(async () => (await status(msg.jobId)).status === "rejected");
    const job = await status(msg.jobId);
    expect(job.bilan.reasons.join(" ")).toContain("Entrypoint");
    expect(job.configChanges).toEqual(["Entrypoint"]);
  });

  it("enregistre un échec de l'agent sans verdict", async () => {
    const { r, wait } = await start();
    const msg = await wait();
    ws.send(JSON.stringify({ type: "patch_result", jobId: msg.jobId, status: "failed", error: "Aucune vulnérabilité corrigeable dans les paquets du système : rien à corriger." }));
    await waitFor(async () => (await status(r.json.remediationId)).status === "failed");
    expect((await status(r.json.remediationId)).error).toContain("rien à corriger");
  });

  it("une connexion perdue rend le résultat indéterminé ; abandon explicite, puis nouveau correctif possible", async () => {
    const { r, wait } = await start();
    const msg = await wait();
    ws.close();
    await waitFor(async () => (await status(r.json.remediationId)).status === "unknown");
    expect((await status(msg.jobId)).error).toContain("indéterminé");
    // Tant qu'il est indéterminé, il bloque une relance aveugle (même contenu d'image).
    const cancelled = await call("POST", `/api/v1/remediations/${msg.jobId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json).toMatchObject({ status: "cancelled" });
    expect(cancelled.json.error).toContain("Abandonné");
    expect((await call("POST", `/api/v1/remediations/${msg.jobId}/cancel`)).status).toBe(409);
    expect((await call("GET", "/api/v1/remediations/" + "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  describe("utiliser l'image corrigée dans une application", () => {
    const COMPOSE = "services:\n  web:\n    image: alpine:3.22.0 # à corriger\n    restart: always\n";
    let validatedId = "";
    let stackId = "";
    let apiStackId = "";
    let sharedStackId = "";
    const patchedRef = `${REGISTRY}/patched/docker-io-library-alpine@${sha("2")}`;
    const rev = async (id: string) => (await call("GET", `/api/v1/stacks/${id}`)).json;

    it("liste les services qui utilisent exactement l'image corrigée, et dit pourquoi les autres ne peuvent pas", async () => {
      validatedId = (await call("GET", "/api/v1/remediations?status=validated")).json.remediations[0].id as string;
      const created = await call("POST", "/api/v1/stacks", { name: "app", hostId, description: "", compose: COMPOSE, variables: {}, adopt: true });
      expect(created.status).toBe(201);
      stackId = created.json.id;
      apiStackId = (await call("POST", "/api/v1/stacks", { name: "app2", hostId, description: "", compose: "services:\n  api:\n    image: ${IMG:-alpine:3.22.0}\n", variables: {}, adopt: true })).json.id;
      // Cas refusés : variable utilisée ailleurs, variable sensible, image composée de plusieurs variables.
      sharedStackId = (await call("POST", "/api/v1/stacks", { name: "app3", hostId, description: "", compose: "services:\n  shared:\n    image: ${S}\n    environment:\n      A: ${S}\n", variables: { S: "alpine:3.22.0" }, adopt: true })).json.id;
      await call("POST", "/api/v1/stacks", { name: "app4", hostId, description: "", compose: "services:\n  secret:\n    image: ${T}\n", variables: { T: { value: "alpine:3.22.0", sensitive: true } }, adopt: true });
      await call("POST", "/api/v1/stacks", { name: "app5", hostId, description: "", compose: "services:\n  multi:\n    image: ${R:-reg.fr}/a:${V:-3.22.0}\n", variables: {}, adopt: true });

      // Le service reconnecté revient en ligne avec ses identifiants (la connexion a été coupée plus haut).
      ws = await connect({ kind: "credentials", ...(creds as object) }, ["scan.trivy", "image.patch"]);
      await sendInventory();
      const t = await call("GET", `/api/v1/remediations/${validatedId}/stack-targets`);
      expect(t.status).toBe(200);
      expect(t.json).toMatchObject({ patchedRef, verdict: "validated", registryReady: true });
      const web = t.json.targets.find((x: any) => x.service === "web");
      expect(web).toMatchObject({ stackName: "app", currentRevision: 1, deployedRevision: null, currentImage: "alpine:3.22.0", canApply: true, reason: null, alreadyApplied: false });
      const api = t.json.targets.find((x: any) => x.service === "api");
      expect(api).toMatchObject({ canApply: true, reason: null, mode: "variable", variable: "IMG", currentImage: "${IMG:-alpine:3.22.0}", effectiveImage: "alpine:3.22.0" });
      expect(web).toMatchObject({ mode: "image", variable: null });
      const byService = (n: string) => t.json.targets.find((x: any) => x.service === n);
      expect(byService("shared")).toMatchObject({ canApply: false, mode: "variable" });
      expect(byService("shared").reason).toContain("utilisée ailleurs");
      expect(byService("secret")).toMatchObject({ canApply: false });
      expect(byService("secret").reason).toContain("sensible");
      expect(byService("multi")).toMatchObject({ canApply: false, mode: "image" });
      expect(byService("multi").reason).toContain("plusieurs variables");
      // Le service qui utilise une autre image n'est pas concerné.
      expect(t.json.targets.some((x: any) => x.service === "old")).toBe(false);
      // Un correctif refusé ne propose rien.
      const rejectedId = (await call("GET", "/api/v1/remediations?status=rejected")).json.remediations[0].id as string;
      expect((await call("GET", `/api/v1/remediations/${rejectedId}/stack-targets`)).status).toBe(409);
    });

    it("prévisualise sans rien enregistrer, et refuse une révision périmée ou un service étranger", async () => {
      const body = { stackId, service: "web", expectedRevision: 1 };
      const p = await call("POST", `/api/v1/remediations/${validatedId}/stack-revision/preview`, body);
      expect(p.status).toBe(200);
      expect(p.json).toMatchObject({ from: "alpine:3.22.0", to: patchedRef });
      expect(p.json.after).toContain(`image: ${patchedRef} # à corriger`);
      expect(p.json.after).toContain("restart: always");
      expect((await rev(stackId)).currentRevision).toBe(1);
      expect((await call("POST", `/api/v1/remediations/${validatedId}/stack-revision/preview`, { ...body, expectedRevision: 9 })).status).toBe(409);
      expect((await call("POST", `/api/v1/remediations/${validatedId}/stack-revision/preview`, { ...body, service: "db" })).status).toBe(409);
      const refused = await call("POST", `/api/v1/remediations/${validatedId}/stack-revision`, { stackId: sharedStackId, service: "shared", expectedRevision: 1 });
      expect(refused.status).toBe(409);
      expect(refused.json.error?.code ?? refused.json.code).toBe("target_not_applicable");
    });

    it("image portée par une variable : l'aperçu montre la variable, pas le Compose, et rien n'est enregistré", async () => {
      const p = await call("POST", `/api/v1/remediations/${validatedId}/stack-revision/preview`, { stackId: apiStackId, service: "api", expectedRevision: 1 });
      expect(p.status).toBe(200);
      expect(p.json).toMatchObject({ mode: "variable", subject: "variables", variable: "IMG", from: "alpine:3.22.0", to: patchedRef });
      expect(p.json.before).not.toContain("IMG=");
      expect(p.json.after).toBe(`IMG=${patchedRef}\n`);
      expect((await rev(apiStackId)).currentRevision).toBe(1);
    });

    it("image portée par une variable : crée une révision non déployée qui ne change que la variable", async () => {
      const before = await rev(apiStackId);
      const r = await call("POST", `/api/v1/remediations/${validatedId}/stack-revision`, { stackId: apiStackId, service: "api", expectedRevision: 1 });
      expect(r.status).toBe(201);
      expect(r.json).toMatchObject({ revision: 2, changed: true, deployed: false });
      const after = await rev(apiStackId);
      expect(after.compose).toBe(before.compose);
      expect(after).toMatchObject({ currentRevision: 2, deployedRevision: null });
      const vars = (await pool.query<{ variables: Record<string, { value: string; sensitive: boolean }> }>("SELECT variables FROM stack_revisions WHERE stack_id = $1 AND revision = 2", [apiStackId])).rows[0]!.variables;
      expect(vars).toEqual({ IMG: { value: patchedRef, sensitive: false } });
      expect((await pool.query("SELECT count(*)::int AS n FROM operations")).rows[0].n).toBe(0);
      const job = await status(validatedId);
      expect(job.applied).toEqual(expect.arrayContaining([expect.objectContaining({ stackName: "app2", service: "api", revision: 2 })]));
      const again = (await call("GET", `/api/v1/remediations/${validatedId}/stack-targets`)).json.targets.find((x: any) => x.service === "api");
      expect(again).toMatchObject({ alreadyApplied: true, canApply: false, effectiveImage: patchedRef });
    });

    it("crée une nouvelle révision NON déployée qui ne change que l'image, et mémorise le lien", async () => {
      const r = await call("POST", `/api/v1/remediations/${validatedId}/stack-revision`, { stackId, service: "web", expectedRevision: 1 });
      expect(r.status).toBe(201);
      expect(r.json).toMatchObject({ revision: 2, changed: true, deployed: false, stackId });
      const s = await rev(stackId);
      expect(s).toMatchObject({ currentRevision: 2, deployedRevision: null, pendingDeploy: true });
      expect(s.compose).toBe(COMPOSE.replace("alpine:3.22.0", patchedRef));
      expect((await pool.query("SELECT count(*)::int AS n FROM operations")).rows[0].n).toBe(0);

      const job = await status(validatedId);
      expect(job.applied).toEqual(expect.arrayContaining([expect.objectContaining({ stackId, stackName: "app", service: "web", revision: 2, by: "boss@example.com" })]));
      // Rejeu ou concurrence : plus rien à proposer / révision périmée.
      expect((await call("POST", `/api/v1/remediations/${validatedId}/stack-revision`, { stackId, service: "web", expectedRevision: 2 })).status).toBe(409);
      const again = (await call("GET", `/api/v1/remediations/${validatedId}/stack-targets`)).json.targets.find((x: any) => x.service === "web");
      expect(again).toMatchObject({ alreadyApplied: true, canApply: false });
    });

    it("un correctif partiel exige une confirmation explicite", async () => {
      const { r, wait } = await start();
      expect(r.status).toBe(202);
      const msg = await wait();
      finish(msg.jobId, {
        patched: { ref: `${REGISTRY}/r:t3`, digest: sha("3") },
        after: patchScan([vuln("CVE-1", "CRITICAL", "2"), vuln("CVE-3", "LOW", null)]),
      });
      await waitFor(async () => (await status(msg.jobId)).status === "partial");
      const body = { stackId, service: "web", expectedRevision: 2 };
      const refused = await call("POST", `/api/v1/remediations/${msg.jobId}/stack-revision`, body);
      expect(refused.status).toBe(409);
      expect(refused.json.error?.code ?? refused.json.code).toBe("partial_requires_confirmation");
      const ok = await call("POST", `/api/v1/remediations/${msg.jobId}/stack-revision`, { ...body, acceptPartial: true });
      expect(ok.status).toBe(201);
      expect((await rev(stackId)).compose).toContain(`@${sha("3")}`);
    });

    it("les applications générées par la console restent verrouillées à toute modification manuelle", async () => {
      // Le registre est une application gérée : le contrôle de verrou (423) vaut aussi pour une révision d'image corrigée.
      const registryStack = (await pool.query<{ id: string; managed_by: string }>("SELECT id, managed_by FROM stacks WHERE name = 'registry'")).rows[0];
      expect(registryStack?.managed_by).toBe("registry");
      const locked = await call("PUT", `/api/v1/stacks/${registryStack?.id}/compose`, { expectedRevision: 1, compose: "services: {}\n" });
      expect(locked.status).toBe(423);
    });
  });

  describe("annuler un correctif en cours", () => {
    const cancels = (jobId: string) => received.filter((m) => m.type === "patch_cancel" && m.jobId === jobId);
    const running = async () => {
      const { r, wait } = await start();
      expect(r.status).toBe(202);
      const msg = await wait();
      ws.send(JSON.stringify({ type: "patch_progress", jobId: msg.jobId, stage: "patching" }));
      await waitFor(async () => (await status(msg.jobId)).status === "patching");
      return msg.jobId as string;
    };

    it("demande l'arrêt à l'agent, sans rien affirmer avant sa confirmation", async () => {
      ws.close();
      ws = await connect({ kind: "credentials", ...(creds as object) }, ["scan.trivy", "image.patch", "image.patch.cancel"]);
      await sendInventory();
      const id = await running();

      const asked = await call("POST", `/api/v1/remediations/${id}/cancel`);
      expect(asked.status).toBe(200);
      expect(asked.json).toMatchObject({ status: "patching", active: true, cancelRequested: true });
      await waitFor(() => cancels(id).length === 1);
      // Une seconde demande ne renvoie rien de plus à l'agent.
      expect((await call("POST", `/api/v1/remediations/${id}/cancel`)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      expect(cancels(id)).toHaveLength(1);

      ws.send(JSON.stringify({ type: "patch_result", jobId: id, status: "cancelled", error: "Correctif arrêté à la demande de la console." }));
      await waitFor(async () => (await status(id)).status === "cancelled");
      const job = await status(id);
      expect(job).toMatchObject({ active: false, cancelRequested: false, patchedDigest: null, patchedRef: null });
      expect(job.error).toContain("Annulé par boss@example.com");
      expect((await call("POST", `/api/v1/remediations/${id}/cancel`)).status).toBe(409);
      expect((await pool.query("SELECT 1 FROM audit_events WHERE action = 'remediation.cancel' AND target LIKE $1", [`${id}%`])).rowCount).toBe(1);
    });

    it("si le correctif se termine avant l'arrêt, son résultat reste valable", async () => {
      const id = await running();
      expect((await call("POST", `/api/v1/remediations/${id}/cancel`)).status).toBe(200);
      finish(id);
      await waitFor(async () => (await status(id)).status === "validated");
      expect(await status(id)).toMatchObject({ status: "validated", cancelRequested: false });
    });

    it("sans confirmation de l'agent, le résultat devient indéterminé (jamais « annulé »), puis une confirmation tardive est acceptée", async () => {
      const id = await running();
      expect((await call("POST", `/api/v1/remediations/${id}/cancel`)).status).toBe(200);
      await pool.query("UPDATE remediation_jobs SET cancel_requested_at = now() - interval '5 minutes' WHERE id = $1", [id]);
      await (built.remediation as unknown as { tick(): Promise<void> }).tick();
      const job = await status(id);
      expect(job.status).toBe("unknown");
      expect(job.error).toContain("n'a pas confirmé");
      ws.send(JSON.stringify({ type: "patch_result", jobId: id, status: "cancelled", error: "arrêté" }));
      await waitFor(async () => (await status(id)).status === "cancelled");
    });
  });

  describe("vérification de démarrage (facultative)", () => {
    const check = { image: "alpine", command: ["apk", "--version"], expectExit: 0, outputContains: "apk-tools" };
    const run = (ok: boolean, exitCode = ok ? 0 : 1) => ({ ok, exitCode, timedOut: false, outputMatched: ok ? true : false });
    const setChecks = (checks: unknown[]) => call("PUT", "/api/v1/settings/remediation/verification", { checks });

    it("se règle par image (sans étiquette), valide la commande et refuse les doublons", async () => {
      expect((await call("GET", "/api/v1/settings/remediation/verification")).json).toEqual({ checks: [] });
      const put = await setChecks([check]);
      expect(put.status).toBe(200);
      expect(put.json.checks).toEqual([{ image: "docker.io/library/alpine", command: ["apk", "--version"], expectExit: 0, outputContains: "apk-tools" }]);
      expect((await call("GET", "/api/v1/settings/remediation/verification")).json.checks).toHaveLength(1);
      // Une version n'est pas une image ; deux vérifications pour la même image sont ambiguës.
      expect((await setChecks([{ ...check, image: "alpine:3.22" }])).status).toBe(400);
      expect((await setChecks([check, { ...check, image: "docker.io/library/alpine" }])).status).toBe(400);
      for (const command of [[], [""], ["a\nb"], Array.from({ length: 17 }, () => "x"), ["x".repeat(201)]]) expect((await setChecks([{ ...check, command }])).status, JSON.stringify(command)).toBe(400);
      expect((await setChecks([{ ...check, expectExit: 256 }])).status).toBe(400);
      expect((await pool.query("SELECT 1 FROM audit_events WHERE action = 'settings.remediation.verification'")).rowCount).toBeGreaterThan(0);
      await setChecks([check]);
    });

    it("transmet la commande à l'agent, la conserve avec le correctif, et mentionne une vérification réussie", async () => {
      const { r, wait } = await start();
      expect(r.status).toBe(202);
      const msg = await wait();
      expect(msg.verify).toEqual({ command: ["apk", "--version"], expectExit: 0, outputContains: "apk-tools" });
      expect((await pool.query("SELECT verify_check FROM remediation_jobs WHERE id = $1", [msg.jobId])).rows[0].verify_check).toEqual(msg.verify);
      finish(msg.jobId, { verification: { source: run(true), patched: run(true) } });
      await waitFor(async () => (await status(msg.jobId)).status === "validated");
      const job = await status(msg.jobId);
      expect(job.bilan.verification).toMatchObject({ state: "passed", check: msg.verify, source: { ok: true }, patched: { ok: true } });
      // Seuls les résultats sont conservés : jamais la sortie de la commande.
      expect(JSON.stringify(job.bilan.verification)).not.toMatch(/output"|stdout|stderr/);
    });

    it("refuse un correctif qui régresse (réussit avant, échoue après)", async () => {
      const { wait } = await start();
      const msg = await wait();
      finish(msg.jobId, { verification: { source: run(true), patched: run(false, 127) } });
      await waitFor(async () => (await status(msg.jobId)).status === "rejected");
      const job = await status(msg.jobId);
      expect(job.bilan.verification.state).toBe("regression");
      expect(job.bilan.reasons.join(" ")).toContain("Régression détectée");
      expect(job.bilan.reasons.join(" ")).toContain("127");
    });

    it("une vérification non concluante ou non effectuée (agent ancien) ne change pas le verdict", async () => {
      const first = await (await start()).wait();
      finish(first.jobId, { verification: { source: run(false), patched: run(false) } });
      await waitFor(async () => (await status(first.jobId)).status === "validated");
      expect((await status(first.jobId)).bilan.verification.state).toBe("inconclusive");

      const second = await (await start()).wait();
      finish(second.jobId); // aucun résultat de vérification : agent qui ne la connaît pas
      await waitFor(async () => (await status(second.jobId)).status === "validated");
      expect((await status(second.jobId)).bilan.verification).toMatchObject({ state: "skipped", source: null, patched: null });
    });

    it("sans vérification configurée pour l'image : rien n'est demandé ni mentionné", async () => {
      await setChecks([]);
      const { wait } = await start();
      const msg = await wait();
      expect(msg).not.toHaveProperty("verify");
      finish(msg.jobId);
      await waitFor(async () => (await status(msg.jobId)).status === "validated");
      expect((await status(msg.jobId)).bilan.verification).toBeNull();
    });

    it("réserve la lecture à tous et l'écriture aux administrateurs", () => {
      expect(requiredRole("GET", "/api/v1/settings/remediation/verification")).toBe("viewer");
      expect(requiredRole("PUT", "/api/v1/settings/remediation/verification")).toBe("admin");
    });
  });

  it("limite l'accès : lecture pour tous, lancement et annulation pour les opérateurs", () => {
    expect(requiredRole("GET", "/api/v1/images/:imageId/remediation/eligibility")).toBe("viewer");
    expect(requiredRole("GET", "/api/v1/remediations")).toBe("viewer");
    expect(requiredRole("POST", "/api/v1/images/:imageId/remediations")).toBe("operator");
    expect(requiredRole("POST", "/api/v1/remediations/:id/cancel")).toBe("operator");
  });
});
