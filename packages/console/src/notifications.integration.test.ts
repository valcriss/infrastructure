import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION, type PatchResult } from "@infra/shared";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";
import { Notifier, buildPayload, deliverHttps, isPrivateAddress, normalizeBaseUrl, signPayload, validateWebhookUrl, type DeliverOptions, type EventType, type NotifyEvent } from "./notifications.js";
import { requiredRole } from "./permissions.js";
import { SecretBox } from "./secretbox.js";

const url = process.env.TEST_DATABASE_URL;
const sha = (c: string): string => `sha256:${c.repeat(64)}`;
const ALL_ON: Record<EventType, boolean> = { "remediation.ready": true, "remediation.failed": true, "remediation.auto_paused": true, "registry.gc_failed": true };

describe("adresses refusées", () => {
  it("reconnaît les adresses privées, locales et non routables (IPv4, IPv6, IPv4 mappée)", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "pas une ip"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("n'accepte qu'une adresse HTTPS publique, sans identifiants", () => {
    expect(validateWebhookUrl("https://hooks.exemple.fr/services/abc", false).hostname).toBe("hooks.exemple.fr");
    for (const bad of ["http://hooks.exemple.fr/x", "https://user:pass@hooks.exemple.fr/x", "ftp://x.fr", "pas une adresse", "https://localhost/x", "https://api.localhost/x", "https://service.internal/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://[::1]/x", "https://169.254.169.254/latest"]) {
      expect(() => validateWebhookUrl(bad, false), bad).toThrow();
    }
    // Service interne : autorisé explicitement, jamais en HTTP.
    expect(validateWebhookUrl("https://10.0.0.5/hook", true).hostname).toBe("10.0.0.5");
    expect(() => validateWebhookUrl("http://10.0.0.5/hook", true)).toThrow();
  });

  it("l'envoi lui-même refuse une adresse privée, y compris par résolution de nom", async () => {
    const o = (u: string, allowPrivate = false): DeliverOptions => ({ url: new URL(u), body: "{}", headers: {}, allowPrivate, timeoutMs: 3000 });
    await expect(deliverHttps(o("https://127.0.0.1:9/"))).rejects.toThrow(/privée/);
    await expect(deliverHttps(o("https://localhost:9/"))).rejects.toThrow(/privée/);
    // Avec l'autorisation, la connexion est tentée (et échoue ici : rien n'écoute), sans refus d'adresse.
    await expect(deliverHttps(o("https://127.0.0.1:9/", true))).rejects.not.toThrow(/privée/);
  });

  it("normalise l'adresse de la console aux seules origines", () => {
    expect(normalizeBaseUrl("https://console.exemple.fr/")).toBe("https://console.exemple.fr");
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl(null)).toBeNull();
    for (const bad of ["https://console.exemple.fr/chemin", "https://u:p@x.fr", "https://x.fr?a=1", "javascript:alert(1)", "n'importe quoi"]) expect(() => normalizeBaseUrl(bad), bad).toThrow();
  });
});

describe("message et signature", () => {
  const event: NotifyEvent = { type: "remediation.ready", title: "Correctif prêt", text: "alpine:3.22 : 4 CVE corrigées.", severity: "info", path: "/images", image: "alpine:3.22", status: "validated" };

  it("contient les champs de Slack (text) et de Discord (content), et un lien seulement si l'adresse de la console est connue", () => {
    const withLink = buildPayload(event, "https://console.exemple.fr", new Date("2026-11-12T10:00:00Z"));
    expect(withLink).toMatchObject({ event: "remediation.ready", url: "https://console.exemple.fr/images", image: "alpine:3.22", at: "2026-11-12T10:00:00.000Z" });
    expect(withLink.text).toBe(withLink.content);
    expect(withLink.text).toContain("https://console.exemple.fr/images");
    expect(buildPayload(event, null, new Date()).url).toBeNull();
    expect(buildPayload({ ...event, text: "x".repeat(5000) }, null, new Date()).text.length).toBeLessThanOrEqual(1900);
  });

  it("signe l'horodatage et le corps : le destinataire peut recalculer la signature", () => {
    const sig = signPayload("secret", "1700000000", '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signPayload("secret", "1700000000", '{"a":1}')).toBe(sig);
    expect(signPayload("autre", "1700000000", '{"a":1}')).not.toBe(sig);
    expect(signPayload("secret", "1700000001", '{"a":1}')).not.toBe(sig);
    expect(signPayload("secret", "1700000000", '{"a":2}')).not.toBe(sig);
  });
});

describe("permissions", () => {
  it("lecture pour tous, réglages, test et secret pour les administrateurs", () => {
    expect(requiredRole("GET", "/api/v1/settings/notifications")).toBe("viewer");
    for (const [m, p] of [["PUT", ""], ["POST", "/test"], ["POST", "/secret/reveal"], ["POST", "/secret/rotate"]] as const) expect(requiredRole(m, `/api/v1/settings/notifications${p}`)).toBe("admin");
  });
});

describe.skipIf(!url)("notifications (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let sharedDir: string;
  let agent: WebSocket;
  let hostId = "";
  let admin = "";
  let baseUrl = "";
  const sent: DeliverOptions[] = [];
  let behaviour: (n: number, o: DeliverOptions) => Promise<{ status: number }> | { status: number } = () => ({ status: 204 });
  const notifier = (): Notifier => new Notifier(pool, new SecretBox(KEY), { deliver: async (o) => { sent.push(o); return behaviour(sent.length, o); }, retryDelaysMs: [1, 1, 1] });
  const KEY = randomBytes(32);
  const WEBHOOK = "https://hooks.exemple.fr/services/T000/B000/secret-token-value";
  const event = (type: EventType = "remediation.ready"): NotifyEvent => ({ type, title: "Titre", text: "Texte", severity: "info", path: "/images" });
  const settings = (over: Record<string, unknown> = {}) => ({ enabled: true, url: WEBHOOK, baseUrl: "https://console.exemple.fr", events: ALL_ON, allowPrivate: false, maxPerHour: 20, ...over });
  const deliveries = async () => (await pool.query<{ event: string; status: string; attempts: number; error: string | null }>("SELECT event, status, attempts, error FROM notification_deliveries ORDER BY at")).rows;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, { method, headers: { cookie: admin, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text) as Record<string, any>; } catch { return {}; } })() };
  };

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    sharedDir = await mkdtemp(join(tmpdir(), "infra-shared-"));
    built = await buildApp({
      masterKey: KEY,
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
  });
  afterAll(async () => {
    agent.close();
    await built.app.close();
    await pool.end();
    await rm(sharedDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    sent.length = 0;
    behaviour = () => ({ status: 204 });
    await pool.query("DELETE FROM app_settings WHERE key = 'notifications'");
    await pool.query("DELETE FROM notification_deliveries");
    await pool.query("DELETE FROM remediation_jobs");
  });

  it("est désactivée par défaut : rien n'est envoyé", async () => {
    const n = notifier();
    expect(await n.view()).toMatchObject({ enabled: false, configured: false, urlHost: null, hasSecret: false });
    n.notify(event());
    await n.drain();
    expect(sent).toEqual([]);
  });

  it("chiffre l'adresse et le secret, ne renvoie que le nom d'hôte, et signe chaque envoi", async () => {
    const n = notifier();
    const view = await n.update(settings(), "boss");
    expect(view).toMatchObject({ enabled: true, configured: true, urlHost: "hooks.exemple.fr", hasSecret: true, baseUrl: "https://console.exemple.fr" });
    expect(JSON.stringify(view)).not.toContain("secret-token-value");
    const raw = JSON.stringify((await pool.query("SELECT value FROM app_settings WHERE key = 'notifications'")).rows[0]);
    expect(raw).not.toContain("secret-token-value");
    expect(raw).not.toContain("hooks.exemple.fr");

    n.notify(event());
    await n.drain();
    expect(sent).toHaveLength(1);
    const o = sent[0] as DeliverOptions;
    expect(o.url.toString()).toBe(WEBHOOK);
    const secret = (await n.secret()) as string;
    expect(o.headers["x-console-signature"]).toBe(signPayload(secret, o.headers["x-console-timestamp"] as string, o.body));
    expect(o.headers["x-console-event"]).toBe("remediation.ready");
    expect(JSON.parse(o.body)).toMatchObject({ event: "remediation.ready", url: "https://console.exemple.fr/images" });
    expect(await deliveries()).toEqual([{ event: "remediation.ready", status: "sent", attempts: 1, error: null }]);
    // Le journal ne garde ni l'adresse ni le contenu.
    expect(JSON.stringify(await deliveries())).not.toContain("hooks.exemple.fr");
  });

  it("refuse d'activer sans adresse, une adresse privée, ou le retrait de l'autorisation sur une adresse privée", async () => {
    const n = notifier();
    await expect(n.update(settings({ url: undefined }), "boss")).rejects.toMatchObject({ status: 400, code: "no_url" });
    await expect(n.update(settings({ url: "https://10.0.0.5/hook" }), "boss")).rejects.toMatchObject({ status: 400, code: "private_address" });
    await n.update(settings({ url: "https://10.0.0.5/hook", allowPrivate: true }), "boss");
    await expect(n.update(settings({ url: undefined, allowPrivate: false }), "boss")).rejects.toMatchObject({ code: "private_address" });
  });

  it("ignore un événement coupé", async () => {
    const n = notifier();
    await n.update(settings({ events: { ...ALL_ON, "remediation.ready": false } }), "boss");
    n.notify(event("remediation.ready"));
    n.notify(event("remediation.failed"));
    await n.drain();
    expect(sent.map((o) => o.headers["x-console-event"])).toEqual(["remediation.failed"]);
  });

  it("réessaie après une erreur du destinataire (5xx) ou du réseau, mais pas après une erreur 4xx", async () => {
    const n = notifier();
    await n.update(settings(), "boss");
    behaviour = (i) => (i < 3 ? { status: 503 } : { status: 200 });
    n.notify(event());
    await n.drain();
    expect(sent).toHaveLength(3);
    expect((await deliveries()).at(-1)).toMatchObject({ status: "sent", attempts: 3 });

    sent.length = 0;
    behaviour = () => { throw new Error("ECONNRESET"); };
    n.notify(event("remediation.failed"));
    await n.drain();
    expect(sent).toHaveLength(4); // 1 essai + 3 reprises
    expect((await deliveries()).at(-1)).toMatchObject({ status: "failed", attempts: 4, error: "ECONNRESET" });

    sent.length = 0;
    behaviour = () => ({ status: 404 });
    n.notify(event("registry.gc_failed"));
    await n.drain();
    expect(sent).toHaveLength(1);
    expect((await deliveries()).at(-1)).toMatchObject({ status: "failed", attempts: 1, error: "HTTP 404" });
  });

  it("plafonne les envois par heure (et le dit dans le journal)", async () => {
    const n = notifier();
    await n.update(settings({ maxPerHour: 2 }), "boss");
    for (let i = 0; i < 4; i++) {
      n.notify(event());
      await n.drain();
    }
    expect(sent).toHaveLength(2);
    expect((await deliveries()).map((d) => d.status)).toEqual(["sent", "sent", "skipped", "skipped"]);
  });

  it("envoie un message de test, sans reprise, et rend le résultat", async () => {
    const n = notifier();
    await expect(n.sendTest()).rejects.toMatchObject({ status: 409 });
    await n.update(settings({ enabled: false }), "boss");
    behaviour = () => ({ status: 200 });
    expect(await n.sendTest()).toMatchObject({ ok: true, status: 200, error: null });
    behaviour = () => ({ status: 500 });
    expect(await n.sendTest()).toMatchObject({ ok: false, status: 500 });
    expect(sent).toHaveLength(2);
    expect((await deliveries()).map((d) => d.event)).toEqual(["test", "test"]);
  });

  it("le secret ne se révèle qu'à la demande, et se renouvelle", async () => {
    const put = await call("PUT", "/api/v1/settings/notifications", settings({ enabled: false }));
    expect(put.status).toBe(200);
    expect(put.text).not.toContain("secret-token-value");
    const view = await call("GET", "/api/v1/settings/notifications");
    expect(view.json.settings).toMatchObject({ configured: true, urlHost: "hooks.exemple.fr", hasSecret: true });
    expect(view.text).not.toMatch(/secret"?:\s*"[A-Za-z0-9_-]{30,}/);
    const first = (await call("POST", "/api/v1/settings/notifications/secret/reveal")).json.secret as string;
    expect(first).toHaveLength(43);
    const second = (await call("POST", "/api/v1/settings/notifications/secret/rotate")).json.secret as string;
    expect(second).not.toBe(first);
    expect((await call("POST", "/api/v1/settings/notifications/secret/reveal")).json.secret).toBe(second);
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action IN ('settings.notifications.reveal', 'settings.notifications.secret')")).rowCount).toBe(3);
    expect((await call("PUT", "/api/v1/settings/notifications", settings({ maxPerHour: 999 }))).status).toBe(400);
  });

  describe("émissions du service de correctifs", () => {
    let spy: NotifyEvent[];
    let seq = 0;
    const job = async (status: string, by = "planification"): Promise<string> => {
      const n = ++seq;
      return (
        await pool.query<{ id: string }>(
          `INSERT INTO remediation_jobs (image_id, platform, host_id, image_ref, status, requested_by, registry_host, repository, source_tag, patched_tag, patch_number)
           VALUES ($1, 'linux/amd64', $2, 'alpine:3.22', $3, $4, 'registry.exemple.invalid', 'patched/x', 'src', $5, $6) RETURNING id`,
          [sha("a"), hostId, status, by, `t-patch.${n}`, n],
        )
      ).rows[0]?.id as string;
    };
    const vuln = (id: string, fixed: string | null) => ({ id, severity: "HIGH", pkg: "zlib", installed: "1", fixed, kind: "os" });
    const scan = (vs: ReturnType<typeof vuln>[]) => ({ counts: { critical: 0, high: vs.length, medium: 0, low: 0, unknown: 0 }, total: vs.length, vulnerabilities: vs, truncated: false });
    const ok = (id: string, after: ReturnType<typeof vuln>[], over: Partial<PatchResult> = {}): PatchResult => ({
      type: "patch_result", jobId: id, status: "succeeded", tools: { copa: "0.15.0", buildkit: "v0.35.0", trivy: "0.76.1" },
      source: { ref: "r:src", digest: sha("1") }, patched: { ref: "r:t", digest: sha("2") },
      before: scan([vuln("CVE-1", "2"), vuln("CVE-2", "2")]), after: scan(after), packageChanges: [], configChanges: [], labelsAdded: ["BaseImage"], vexStatements: 0, ...over,
    });
    beforeEach(async () => {
      spy = [];
      built.remediation.notifier = { notify: (e) => void spy.push(e) };
    });

    it("un correctif automatique validé est signalé « à relire », sans rien appliquer", async () => {
      const id = await job("patching");
      await built.remediation.onResult(hostId, ok(id, []));
      expect(spy).toHaveLength(1);
      expect(spy[0]).toMatchObject({ type: "remediation.ready", severity: "info", status: "validated", image: "alpine:3.22", path: "/images" });
      expect(spy[0]?.text).toContain("Rien n'a été appliqué ni déployé");
    });

    it("un correctif manuel validé ne notifie pas ; un correctif partiel automatique le fait avec un avertissement", async () => {
      await built.remediation.onResult(hostId, ok(await job("patching", "boss@example.com"), []));
      expect(spy).toEqual([]);
      await built.remediation.onResult(hostId, ok(await job("patching"), [vuln("CVE-1", "2")]));
      expect(spy[0]).toMatchObject({ type: "remediation.ready", severity: "warning", status: "partial" });
    });

    it("un correctif refusé ou en échec est signalé, sans détail de sortie d'outil", async () => {
      await built.remediation.onResult(hostId, ok(await job("patching", "boss@example.com"), [], { configChanges: ["Entrypoint"] }));
      expect(spy[0]).toMatchObject({ type: "remediation.failed", status: "rejected" });
      expect(spy[0]?.text).toContain("Entrypoint");
      spy.length = 0;
      await built.remediation.onResult(hostId, { type: "patch_result", jobId: await job("patching", "boss@example.com"), status: "failed", error: "docker: pull access denied, token=AbCdEf0123456789SECRET" });
      expect(spy).toHaveLength(1);
      expect(spy[0]).toMatchObject({ type: "remediation.failed", status: "failed" });
      expect(JSON.stringify(spy[0])).not.toMatch(/token|SECRET|docker:/);
    });

    it("trois échecs automatiques de suite signalent la pause, une seule fois", async () => {
      for (let i = 0; i < 2; i++) {
        await built.remediation.onResult(hostId, { type: "patch_result", jobId: await job("patching"), status: "failed", error: "x" });
        await pool.query("UPDATE remediation_jobs SET finished_at = now() WHERE status = 'failed'");
      }
      expect(spy.map((e) => e.type)).toEqual(["remediation.failed", "remediation.failed"]);
      await built.remediation.onResult(hostId, { type: "patch_result", jobId: await job("patching"), status: "failed", error: "x" });
      expect(spy.map((e) => e.type)).toEqual(["remediation.failed", "remediation.failed", "remediation.failed", "remediation.auto_paused"]);
      expect(spy.at(-1)).toMatchObject({ severity: "warning", path: "/settings?tab=security" });
    });
  });
});
