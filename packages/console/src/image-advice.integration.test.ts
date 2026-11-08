import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@infra/shared";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { suggestVariants } from "./candidate-routes.js";
import { withTag } from "./candidates.js";
import { createPool, migrate, type Pool } from "./db.js";
import { compareVersions, repoKey, summarizeVulns } from "./vuln-summary.js";

const url = process.env.TEST_DATABASE_URL;
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const IMG_CUR = sha("1");
const IMG_NEW = sha("2");
const REF = "myreg.invalid/team/app:1.0";

describe("aides à la décision sur les images", () => {
  it("compare les versions et résume les vulnérabilités corrigeables", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-r1", "2.0.0-r2")).toBeLessThan(0);
    const s = summarizeVulns([
      { pkg: "openssl", installed: "1.1", fixed: "1.1.2, 1.1.1", severity: "CRITICAL" },
      { pkg: "openssl", installed: "1.1", fixed: "1.1.3", severity: "LOW" },
      { pkg: "zlib", installed: "1.2", fixed: null, severity: "HIGH", status: "will_not_fix" },
      { pkg: "libc", installed: "2.3", fixed: null, severity: "MEDIUM" },
    ]);
    expect(s).toMatchObject({ total: 4, fixable: 2, unfixable: 2, willNotFix: 1 });
    expect(s.packages).toEqual([{ pkg: "openssl", installed: "1.1", fixableCount: 2, worst: "CRITICAL", fixedIn: "1.1.3" }]);
  });

  it("normalise le dépôt et change l'étiquette sans toucher au reste de la référence", () => {
    expect(repoKey("ghost:5-alpine")).toBe("docker.io/library/ghost");
    expect(repoKey("ghcr.io/o/app:1")).toBe("ghcr.io/o/app");
    expect(withTag("myreg.invalid:5000/team/app:1.0", "2.0")).toBe("myreg.invalid:5000/team/app:2.0");
    expect(withTag("ghost", "alpine")).toBe("ghost:alpine");
    expect(withTag("nginx:1.27@sha256:" + "a".repeat(64), "1.28")).toBe("nginx:1.28");
  });

  it("propose les variantes légères les plus proches, jamais les préversions", () => {
    const tags = ["5", "5.130.2", "5-alpine", "5.130.2-alpine", "6-alpine", "alpine", "5.9-alpine", "5-alpine-rc1", "latest", "4-alpine"];
    const v = suggestVariants("5.130.2", tags);
    expect(v.slice(0, 3)).toEqual(["5.130.2-alpine", "5.9-alpine", "5-alpine"]);
    expect(v).not.toContain("5-alpine-rc1");
    expect(v).not.toContain("latest");
    expect(suggestVariants("5-alpine", tags)).toEqual([]);
  });
});

describe.skipIf(!url)("CVE : corrigeables, risques acceptés, comparaison de versions (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let baseUrl: string;
  let cookie = "";
  let root: string;
  let hostId = "";
  let stackId = "";
  let agent: WebSocket;
  const inbox: Record<string, any>[] = [];

  const call = async (method: string, path: string, body?: unknown, ck = cookie) => {
    const res = await fetch(baseUrl + path, { method, headers: { cookie: ck, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any>, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  };
  const waitFor = async (check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > ms) throw new Error("délai dépassé");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const send = (m: unknown) => agent.send(JSON.stringify(m));

  const VULNS = [
    { id: "CVE-2026-0001", pkg: "openssl", installed: "1.1.1", fixed: "1.1.2", severity: "CRITICAL", title: "Débordement", url: null, status: "fixed" },
    { id: "CVE-2026-0002", pkg: "zlib", installed: "1.2.12", fixed: null, severity: "HIGH", title: "Lecture hors limites", url: null },
    { id: "CVE-2026-0003", pkg: "busybox", installed: "1.31", fixed: "1.32", severity: "LOW", title: "Mineure", url: null },
  ];

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    root = mkdtempSync(join(tmpdir(), "infra-adv-"));
    const sharedDir = mkdtempSync(join(root, "shared-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir, webDir: null, secureCookies: false, dataDir: mkdtempSync(join(root, "data-")), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    const setup = await call("POST", "/api/v1/setup", { setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" }, "");
    cookie = setup.cookie;
    agent = new WebSocket(baseUrl.replace("http", "ws") + "/agent/ws");
    await new Promise<void>((resolve, reject) => {
      agent.on("open", () => send({ type: "hello", protocol: PROTOCOL_VERSION, agentVersion: "t", hostname: "h", capabilities: ["scan.trivy", "image.pull"], auth: { kind: "enrollment", token: readFileSync(join(sharedDir, "bootstrap-token"), "utf8").trim() } }));
      agent.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, any>;
        if (msg.type === "welcome") {
          hostId = msg.agentId;
          resolve();
        } else if (msg.type !== "error") inbox.push(msg);
      });
      agent.on("error", reject);
    });
    stackId = (await call("POST", "/api/v1/stacks", { name: "app", hostId, compose: `services:\n  web:\n    image: ${REF}\n` })).json.id as string;
    send({
      type: "inventory",
      inventory: {
        observedAt: new Date().toISOString(),
        dockerVersion: "29",
        containers: [{ id: "c".repeat(64), names: ["app-web-1"], image: REF, imageId: IMG_CUR, state: "running", status: "Up", created: 1, composeProject: "app", composeService: "web" }],
        images: [{ id: IMG_CUR, repoTags: [REF], repoDigests: [], size: 5_000_000, os: "linux", arch: "amd64" }],
      },
    });
    await waitFor(async () => ((await pool.query("SELECT jsonb_array_length(images) AS n FROM hosts WHERE id = $1", [hostId])).rows[0]?.n ?? 0) === 1);
    // Scan réussi de l'image actuelle : 1 critique corrigeable, 1 élevée sans correctif, 1 faible corrigeable.
    await pool.query(
      `INSERT INTO image_scans (image_id, platform, host_id, image_ref, status, trigger, requested_by, finished_at, counts, total, vulnerabilities, os_family, os_name)
       VALUES ($1, 'linux/amd64', $2, $3, 'succeeded', 'manual', 'test', now(), $4, 3, $5, 'alpine', '3.19')`,
      [IMG_CUR, hostId, REF, JSON.stringify({ critical: 1, high: 1, medium: 0, low: 1, unknown: 0 }), JSON.stringify(VULNS)],
    );
  });

  afterAll(async () => {
    agent?.close();
    await built.app.close();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("résume les vulnérabilités corrigeables et filtre selon la présence d'un correctif", async () => {
    const r = await call("GET", `/api/v1/images/${IMG_CUR}/scan`);
    expect(r.status).toBe(200);
    expect(r.json.summary).toMatchObject({ total: 3, fixable: 2, unfixable: 1, accepted: 0 });
    expect(r.json.summary.packages.map((p: any) => [p.pkg, p.fixedIn])).toEqual([["openssl", "1.1.2"], ["busybox", "1.32"]]);
    expect((await call("GET", `/api/v1/images/${IMG_CUR}/scan?fixable=no`)).json.vulnerabilities.map((v: any) => v.id)).toEqual(["CVE-2026-0002"]);
    expect((await call("GET", `/api/v1/images/${IMG_CUR}/scan?fixable=yes`)).json.total).toBe(2);
  });

  it("accepte un risque : il sort des compteurs et des alertes, avec justification et expiration", async () => {
    const view = async () => ((await call("GET", "/api/v1/images")).json.images as any[]).find((i) => i.imageId === IMG_CUR).scan.current;
    expect((await view()).counts).toMatchObject({ critical: 1, high: 1, low: 1 });
    const dash = async () => (await call("GET", "/api/v1/dashboard")).json.security.vulns.all;
    expect(await dash()).toMatchObject({ critical: 1, high: 1, low: 1 });

    // Validation : justification obligatoire, durée prévue.
    expect((await call("POST", "/api/v1/vulnerability-acceptances", { cve: "CVE-2026-0002", justification: "court", days: 30 })).status).toBe(400);
    expect((await call("POST", "/api/v1/vulnerability-acceptances", { cve: "CVE-2026-0002", justification: "Non exploitable : service interne", days: 15 })).status).toBe(400);
    const ok = await call("POST", "/api/v1/vulnerability-acceptances", { cve: "cve-2026-0002", imageRef: REF, justification: "Non exploitable : service interne", days: 30 });
    expect(ok.status).toBe(201);
    expect((await call("POST", "/api/v1/vulnerability-acceptances", { cve: "CVE-2026-0002", imageRef: REF, justification: "Non exploitable : service interne", days: 30 })).status).toBe(409);

    // Compteurs ajustés partout ; le détail les met de côté et reste consultable.
    expect((await view()).counts).toMatchObject({ critical: 1, high: 0, low: 1 });
    expect(await dash()).toMatchObject({ critical: 1, high: 0, low: 1 });
    const details = (await call("GET", `/api/v1/images/${IMG_CUR}/scan`)).json;
    expect(details.total).toBe(2);
    expect(details.summary).toMatchObject({ unfixable: 0, accepted: 1 });
    const only = (await call("GET", `/api/v1/images/${IMG_CUR}/scan?accepted=only`)).json.vulnerabilities[0];
    expect(only).toMatchObject({ id: "CVE-2026-0002", accepted: { justification: "Non exploitable : service interne", createdBy: "admin" } });
    expect((await call("GET", `/api/v1/images/${IMG_CUR}/scan?accepted=include`)).json.total).toBe(3);

    // Un autre dépôt n'est pas concerné ; l'expiration remet le risque dans les compteurs.
    await pool.query("UPDATE vulnerability_acceptances SET repository = 'docker.io/library/autre'");
    expect((await view()).counts).toMatchObject({ high: 1 });
    await pool.query("UPDATE vulnerability_acceptances SET repository = NULL");
    expect((await view()).counts).toMatchObject({ high: 0 });
    await pool.query("UPDATE vulnerability_acceptances SET expires_at = now() - interval '1 minute'");
    expect((await view()).counts).toMatchObject({ high: 1 });
    await pool.query("UPDATE vulnerability_acceptances SET expires_at = now() + interval '1 day'");
    expect((await view()).counts).toMatchObject({ high: 0 });

    // Révocation : le risque est de nouveau compté. Seul un administrateur peut accepter ou révoquer.
    const list = (await call("GET", "/api/v1/vulnerability-acceptances")).json.acceptances;
    expect(list).toHaveLength(1);
    expect((await call("DELETE", `/api/v1/vulnerability-acceptances/${ok.json.id}`)).status).toBe(204);
    expect((await view()).counts).toMatchObject({ high: 1 });
    expect((await call("DELETE", `/api/v1/vulnerability-acceptances/${ok.json.id}`)).status).toBe(404);
  });

  it("compare une autre version : téléchargement, scan, puis retrait de l'image", async () => {
    inbox.length = 0;
    // Refus : version actuelle, étiquette invalide, service inconnu.
    expect((await call("POST", `/api/v1/stacks/${stackId}/services/web/candidate-scans`, { tag: "1.0" })).status).toBe(400);
    expect((await call("POST", `/api/v1/stacks/${stackId}/services/web/candidate-scans`, { tag: "pas bon" })).status).toBe(400);
    expect((await call("POST", `/api/v1/stacks/${stackId}/services/inconnu/candidate-scans`, { tag: "2.0" })).status).toBe(404);

    const started = await call("POST", `/api/v1/stacks/${stackId}/services/web/candidate-scans`, { tag: "2.0-alpine" });
    expect(started.status).toBe(202);
    await waitFor(() => inbox.some((m) => m.type === "image_pull"));
    const pull = inbox.find((m) => m.type === "image_pull") as Record<string, any>;
    expect(pull).toMatchObject({ ref: "myreg.invalid/team/app:2.0-alpine", pullId: started.json.id });
    // Une demande identique récente réutilise la comparaison en cours.
    expect((await call("POST", `/api/v1/stacks/${stackId}/services/web/candidate-scans`, { tag: "2.0-alpine" })).json).toMatchObject({ id: started.json.id, created: false });

    // L'image n'est pas dans l'inventaire : le scan démarre quand même (image candidate).
    send({ type: "image_pull_result", pullId: pull.pullId, status: "succeeded", imageId: IMG_NEW, platform: "linux/amd64" });
    await waitFor(() => inbox.some((m) => m.type === "scan"));
    const scan = inbox.find((m) => m.type === "scan") as Record<string, any>;
    expect(scan).toMatchObject({ imageId: IMG_NEW, imageRef: "myreg.invalid/team/app:2.0-alpine" });
    send({
      type: "scan_result",
      scanId: scan.scanId,
      status: "succeeded",
      trivy: { version: "0.76.1", dbVersion: 2, dbUpdatedAt: "2026-11-06T18:00:00Z", dbDownloadedAt: "2026-11-06T20:00:00Z" },
      os: { family: "alpine", name: "3.20", eosl: false },
      counts: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 },
      total: 1,
      vulnerabilities: [VULNS[1]],
      truncated: false,
    });
    await waitFor(async () => ((await pool.query("SELECT status FROM image_scans WHERE id = $1", [scan.scanId])).rows[0]?.status) === "succeeded");

    await built.candidates.tick();
    const list = (await call("GET", `/api/v1/stacks/${stackId}/candidate-scans`)).json.candidates as any[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      service: "web",
      tag: "2.0-alpine",
      status: "succeeded",
      result: { counts: { critical: 0, high: 1, low: 0 }, total: 1, fixable: 0, unfixable: 1 },
      current: { counts: { critical: 1, high: 1, low: 1 }, total: 3, fixable: 2, unfixable: 1 },
    });
    // L'image téléchargée est retirée de l'hôte, une seule fois.
    await waitFor(() => inbox.some((m) => m.type === "image_remove"));
    expect(inbox.find((m) => m.type === "image_remove")).toMatchObject({ imageId: IMG_NEW });
    await built.candidates.tick();
    expect(inbox.filter((m) => m.type === "image_remove")).toHaveLength(1);
  });

  it("remplace l'image d'un service par une image personnalisée : Dockerfile et Compose dans une seule révision", async () => {
    const rev = (await call("GET", `/api/v1/stacks/${stackId}`)).json.currentRevision as number;
    const body = { expectedRevision: rev, packageManager: "apk", packages: ["curl"], upgrade: true, user: "node" };
    const path = `/api/v1/stacks/${stackId}/services/web/custom-image`;

    const preview = await call("POST", `${path}/preview`, body);
    expect(preview.status).toBe(200);
    expect(preview.json.dockerfilePath).toBe("build/web/Dockerfile");
    expect(preview.json.dockerfile).toContain(`FROM ${REF}`);
    expect(preview.json.dockerfile).toContain("apk add --no-cache curl");
    expect(preview.json.after).toContain("build: ./build/web");
    expect(preview.json.after).toContain("image: app-web-custom:local");
    expect(preview.json.before).toContain(`image: ${REF}`);

    // Validations : paquet douteux, Dockerfile sans FROM, révision périmée, service inconnu.
    expect((await call("POST", `${path}/preview`, { ...body, packages: ["curl; rm -rf /"] })).status).toBe(400);
    expect((await call("POST", `${path}/preview`, { ...body, dockerfile: "RUN echo" })).status).toBe(400);
    expect((await call("POST", `${path}/preview`, { ...body, expectedRevision: rev + 5 })).status).toBe(409);
    expect((await call("POST", `/api/v1/stacks/${stackId}/services/inconnu/custom-image/preview`, body)).status).toBe(404);

    // Un Dockerfile modifié à la main remplace le texte généré.
    const edited = (await call("POST", `${path}/preview`, { ...body, dockerfile: "FROM alpine:3\nRUN echo perso\n" })).json;
    expect(edited.dockerfile).toBe("FROM alpine:3\nRUN echo perso\n");

    const saved = await call("PATCH", path, body);
    expect(saved.status).toBe(200);
    expect(saved.json.revision).toBe(rev + 1);
    const detail = (await call("GET", `/api/v1/stacks/${stackId}`)).json;
    expect(detail.compose).toContain("build: ./build/web");
    expect(detail.files).toContain("build/web/Dockerfile");
    const revision = (await call("GET", `/api/v1/stacks/${stackId}/revisions/${rev + 1}`)).json;
    expect(revision.files["build/web/Dockerfile"]).toContain("apk add --no-cache curl");

    // Déjà construit localement : on modifie son Dockerfile, pas de second remplacement.
    expect((await call("POST", `${path}/preview`, { ...body, expectedRevision: rev + 1 })).status).toBe(422);
  });

  it("crée une révision avec la version comparée : aperçu, validations, puis enregistrement sans déploiement", async () => {
    // Après le test précédent le service « web » est construit localement : on repart d'une pile dédiée.
    const fresh = (await call("POST", "/api/v1/stacks", { name: "retag", hostId, compose: `services:\n  web:\n    image: ${REF} # actuelle\n  cfg:\n    image: \${CFG_IMAGE:-x:1}\n`, variables: {} })).json.id as string;
    const base = `/api/v1/stacks/${fresh}/services`;
    const rev = (await call("GET", `/api/v1/stacks/${fresh}`)).json.currentRevision as number;

    const preview = await call("POST", `${base}/web/image-tag/preview`, { expectedRevision: rev, tag: "2.0-alpine" });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ from: REF, to: "myreg.invalid/team/app:2.0-alpine" });
    expect(preview.json.after).toContain("image: myreg.invalid/team/app:2.0-alpine # actuelle");

    expect((await call("POST", `${base}/web/image-tag/preview`, { expectedRevision: rev, tag: "pas bon" })).status).toBe(422);
    expect((await call("POST", `${base}/web/image-tag/preview`, { expectedRevision: rev, tag: "1.0" })).status).toBe(422);
    expect((await call("POST", `${base}/cfg/image-tag/preview`, { expectedRevision: rev, tag: "2" })).status).toBe(422);
    expect((await call("POST", `${base}/absent/image-tag/preview`, { expectedRevision: rev, tag: "2" })).status).toBe(404);
    expect((await call("POST", `${base}/web/image-tag/preview`, { expectedRevision: rev + 3, tag: "2" })).status).toBe(409);

    const saved = await call("PATCH", `${base}/web/image-tag`, { expectedRevision: rev, tag: "2.0-alpine" });
    expect(saved.status).toBe(200);
    expect(saved.json.revision).toBe(rev + 1);
    const detail = (await call("GET", `/api/v1/stacks/${fresh}`)).json;
    expect(detail.compose).toContain("image: myreg.invalid/team/app:2.0-alpine");
    expect(detail.deployedRevision).toBeNull();
  });

  it("signale l'échec d'un téléchargement refusé par le registre", async () => {
    inbox.length = 0;
    const started = await call("POST", `/api/v1/stacks/${stackId}/services/web/candidate-scans`, { tag: "9.9" });
    await waitFor(() => inbox.some((m) => m.type === "image_pull" && m.pullId === started.json.id));
    send({ type: "image_pull_result", pullId: started.json.id, status: "failed", error: "Téléchargement refusé : manifest unknown" });
    await waitFor(async () => ((await pool.query("SELECT status FROM candidate_scans WHERE id = $1", [started.json.id])).rows[0]?.status) === "failed");
    const failed = ((await call("GET", `/api/v1/stacks/${stackId}/candidate-scans`)).json.candidates as any[]).find((c) => c.id === started.json.id);
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("manifest unknown"), result: null });
  });

  it("masque les éléments de la console (conteneurs, images, applications, métriques) selon le réglage d'affichage", async () => {
    const IMG_SELF = sha("9");
    const ctr = (id: string, name: string, project: string, image: string, imageId: string) => ({ id: id.repeat(64).slice(0, 64), names: [name], image, imageId, state: "running", status: "Up", created: 1, composeProject: project, composeService: name });
    send({
      type: "inventory",
      inventory: {
        observedAt: new Date().toISOString(),
        dockerVersion: "29",
        containers: [ctr("c", "app-web-1", "app", REF, IMG_CUR), ctr("d", "console-1", "console-docker", "ghcr.io/x/infrastructure-console:1", IMG_SELF)],
        images: [
          { id: IMG_CUR, repoTags: [REF], repoDigests: [], size: 5_000_000, os: "linux", arch: "amd64" },
          { id: IMG_SELF, repoTags: ["ghcr.io/x/infrastructure-console:1"], repoDigests: [], size: 5_000_000, os: "linux", arch: "amd64" },
        ],
      },
    });
    await waitFor(async () => ((await pool.query("SELECT jsonb_array_length(images) AS n FROM hosts WHERE id = $1", [hostId])).rows[0]?.n ?? 0) === 2);
    const snapshot = async () => ({
      images: ((await call("GET", "/api/v1/images")).json.images as any[]).map((i) => i.imageId),
      containers: (await call("GET", "/api/v1/dashboard")).json.containers.total as number,
      apps: ((await call("GET", "/api/v1/applications")).json.applications as any[]).map((a) => a.name),
    });

    // Par défaut : tout est affiché.
    expect((await call("GET", "/api/v1/settings/display")).json).toMatchObject({ showConsole: true, selfProjects: expect.arrayContaining(["console-docker"]) });
    const shown = await snapshot();
    expect(shown.images).toContain(IMG_SELF);
    expect(shown.apps).toContain("console-docker");

    // Masqué : ni l'image, ni le conteneur, ni l'application de la console ; les autres restent.
    expect((await call("PUT", "/api/v1/settings/display", { showConsole: false })).json.showConsole).toBe(false);
    const hidden = await snapshot();
    expect(hidden.images).not.toContain(IMG_SELF);
    expect(hidden.images).toContain(IMG_CUR);
    expect(hidden.containers).toBe(shown.containers - 1);
    expect(hidden.apps).not.toContain("console-docker");
    expect(hidden.apps).toContain("app");
    // Le scan de l'image de la console reste possible (la planification ne dépend pas de l'affichage).
    expect((await call("POST", `/api/v1/images/${IMG_SELF}/scans`, {})).status).toBe(202);

    // Réaffiché : tout revient.
    expect((await call("PUT", "/api/v1/settings/display", { showConsole: true })).status).toBe(200);
    expect(await snapshot()).toEqual(shown);
    expect((await call("PUT", "/api/v1/settings/display", { showConsole: "oui" })).status).toBe(400);
  });
});
