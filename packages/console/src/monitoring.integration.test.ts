import { PROTOCOL_VERSION, type Container, type RunMessage } from "@infra/shared";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "./app.js";
import { createPool, migrate, type Pool } from "./db.js";

const url = process.env.TEST_DATABASE_URL;
const COMPOSE = "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n";

const ctr = (svc: string, over: Partial<Container> = {}): Container => ({
  id: `c-${svc}`,
  names: [`app-${svc}-1`],
  image: "img",
  imageId: "sha256:1",
  state: "running",
  status: "Up 2 minutes",
  created: 1,
  composeProject: "app",
  composeService: svc,
  health: "none",
  restartCount: 0,
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  exitCode: 0,
  ...over,
});

describe.skipIf(!url)("supervision (intégration)", () => {
  let pool: Pool;
  let built: BuiltApp;
  let baseUrl: string;
  let wsUrl: string;
  let cookie = "";
  let root: string;
  let hostId = "";
  let stackId = "";
  let secret = "";
  let ws: WebSocket;
  const runs: RunMessage[] = [];

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
  };

  const waitFor = async (check: () => boolean | Promise<boolean>, ms = 4000): Promise<void> => {
    const start = Date.now();
    while (!(await check())) {
      if (Date.now() - start > ms) throw new Error("délai dépassé");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  const connect = (auth: object): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const sock = new WebSocket(wsUrl);
      sock.on("open", () =>
        sock.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, agentVersion: "t", hostname: "h", capabilities: ["metrics"], auth })),
      );
      sock.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, any>;
        if (msg.type === "welcome") {
          if (msg.credentials) {
            hostId = msg.agentId;
            secret = msg.credentials.secret;
          }
          expect(msg.metricsIntervalSec).toBe(30);
          resolve(sock);
        } else if (msg.type === "run") runs.push(msg as unknown as RunMessage);
        else if (msg.type === "error") reject(new Error(msg.message));
      });
      sock.on("error", reject);
    });

  const sendInventory = async (containers: Container[]) => {
    ws.send(
      JSON.stringify({
        type: "inventory",
        inventory: {
          observedAt: new Date().toISOString(),
          dockerVersion: "29.0",
          containers,
          hostInfo: { cpus: 4, memTotalBytes: 8e9, os: "Linux", serverVersion: "29.0", containersRunning: 2, containersPaused: 0, containersStopped: 0, images: 3 },
        },
      }),
    );
    // jsonb ne conserve pas l'ordre des clés : on compare une empreinte lisible, pas le JSON brut.
    const fingerprint = (list: Container[]) => list.map((c) => `${c.id}/${c.state}/${c.health}/${c.exitCode}`).join(",");
    await waitFor(async () => {
      const row = (await pool.query<{ inventory: Container[] | null }>("SELECT inventory FROM hosts WHERE id = $1", [hostId])).rows[0];
      return row?.inventory ? fingerprint(row.inventory) === fingerprint(containers) : false;
    });
  };

  const dashboard = (query = "") => call("GET", `/api/v1/dashboard${query}`);

  beforeAll(async () => {
    pool = createPool(url as string);
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(pool);
    root = mkdtempSync(join(tmpdir(), "infra-mon-"));
    const sharedDir = mkdtempSync(join(root, "shared-"));
    built = await buildApp({
      masterKey: randomBytes(32),
      allowInsecureGit: true,
      config: { host: "127.0.0.1", port: 0, databaseUrl: url as string, sharedDir, webDir: null, secureCookies: false, dataDir: mkdtempSync(join(root, "data-")), gitCaFile: null, metricsIntervalSec: 30, metricsRetentionDays: 7, registryCaFile: null },
      pool,
    });
    baseUrl = await built.app.listen({ host: "127.0.0.1", port: 0 });
    wsUrl = baseUrl.replace("http", "ws") + "/agent/ws";
    const setup = await fetch(`${baseUrl}/api/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: built.setup.token, username: "admin", password: "mot-de-passe-solide-1" }),
    });
    cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    ws = await connect({ kind: "enrollment", token: readFileSync(join(sharedDir, "bootstrap-token"), "utf8").trim() });
    stackId = (await call("POST", "/api/v1/stacks", { name: "app", hostId, compose: COMPOSE })).json.id as string;
    // Déploiement réussi : la stack devient « déployée » (sinon son état est « jamais déployée »).
    const dep = (await call("POST", `/api/v1/stacks/${stackId}/deploy`)).json.operationId as string;
    await waitFor(() => runs.length > 0);
    ws.send(JSON.stringify({ type: "operation_result", operationId: dep, status: "succeeded" }));
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${dep}`)).json as any).status === "succeeded");
  });

  afterAll(async () => {
    ws?.close();
    await built.app.close();
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("exige une authentification", async () => {
    expect((await fetch(`${baseUrl}/api/v1/dashboard`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/v1/stacks/${stackId}/metrics`)).status).toBe(401);
  });

  it("affiche une stack en marche avec santé des conteneurs, hôte et projets non gérés", async () => {
    await sendInventory([
      ctr("web", { health: "healthy" }),
      ctr("db"),
      ctr("x", { id: "c-ext", names: ["legacy-x-1"], composeProject: "legacy", composeService: "x" }),
    ]);
    const d = (await dashboard()).json;
    expect(d.agents).toMatchObject({ total: 1, online: 1, offline: 0 });
    expect(d.agents.items[0].hostInfo).toMatchObject({ cpus: 4, images: 3 });
    expect(d.stacks.counts).toMatchObject({ running: 1, degraded: 0, unknown: 0 });
    const s = d.stacks.items[0];
    expect(s).toMatchObject({ name: "app", status: "running", hostPresence: "online" });
    expect(s.containers).toMatchObject({ total: 2, running: 2, unhealthy: 0, noHealthcheck: 1 }); // « non configuré » ≠ « en échec »
    expect(d.containers).toMatchObject({ total: 3, running: 3, unhealthy: 0, unmanagedProjects: 1 });
    expect(d.alerts.map((a: any) => a.kind)).toEqual(["backup_not_configured"]);
  });

  it("passe en « dégradée » avec des alertes explicites", async () => {
    await sendInventory([
      ctr("web", { health: "unhealthy" }),
      ctr("db", { state: "exited", exitCode: 137, status: "Exited (137)" }),
    ]);
    const d = (await dashboard()).json;
    expect(d.stacks.items[0]).toMatchObject({ status: "degraded", missingServices: [] });
    expect(d.stacks.items[0].reason).toContain("db : exited (code 137)");
    expect(d.stacks.items[0].reason).toContain("web : healthcheck en échec");
    const kinds = d.alerts.map((a: any) => a.kind);
    expect(kinds).toContain("stack_degraded");
    expect(kinds).toContain("container_unhealthy");
    expect(d.containers).toMatchObject({ unhealthy: 1, running: 1, stopped: 1 });
  });

  it("filtre par hôte et par stack", async () => {
    expect((await dashboard(`?hostId=${hostId}`)).json.stacks.items).toHaveLength(1);
    const other = (await dashboard("?hostId=00000000-0000-4000-8000-000000000000")).json;
    expect(other.stacks.items).toHaveLength(0);
    expect(other.agents.total).toBe(0);
    const one = (await dashboard(`?stackId=${stackId}`)).json;
    expect(one.stacks.items.map((s: any) => s.name)).toEqual(["app"]);
    expect(one.backup).toBeNull(); // les alertes globales ne polluent pas une vue filtrée
    expect((await dashboard("?hostId=pas-un-uuid")).status).toBe(400);
  });

  it("enregistre les métriques, ignore un envoi trop rapproché et calcule les débits réseau", async () => {
    const sample = (cpu: number | null) => ({ containerId: "c-web", name: "app-web-1", project: "app", service: "web", cpuPercent: cpu, memBytes: 50e6, memLimitBytes: 512e6, netRxBytes: 1000, netTxBytes: 500 });
    ws.send(JSON.stringify({ type: "metrics", observedAt: new Date().toISOString(), samples: [sample(null)] }));
    await waitFor(async () => (await pool.query("SELECT count(*)::int AS n FROM metric_samples")).rows[0].n === 1);
    // Un second envoi immédiat (< moitié de la période) est ignoré : protection contre un agent bavard.
    ws.send(JSON.stringify({ type: "metrics", observedAt: new Date().toISOString(), samples: [sample(12.5)] }));
    await new Promise((r) => setTimeout(r, 300));
    expect((await pool.query("SELECT count(*)::int AS n FROM metric_samples")).rows[0].n).toBe(1);

    // Série contrôlée : compteurs 0 → 3000 → 100 (redémarrage) sur des seaux de 30 s.
    await pool.query("DELETE FROM metric_samples");
    const base = Math.floor(Date.now() / 30000) * 30000 - 150_000;
    const rows: [number, number | null, number, number][] = [
      [0, 10, 0, 0],
      [30000, 20, 3000, 600],
      [60000, 30, 100, 90], // compteur remis à zéro
    ];
    for (const [off, cpu, rx, tx] of rows) {
      await pool.query(
        `INSERT INTO metric_samples (host_id, observed_at, container_id, container_name, project, service, cpu_percent, mem_bytes, mem_limit, net_rx, net_tx)
         VALUES ($1, to_timestamp($2), 'c-web', 'app-web-1', 'app', 'web', $3, 50000000, 512000000, $4, $5)`,
        [hostId, (base + off) / 1000, cpu, rx, tx],
      );
    }
    const m = (await call("GET", `/api/v1/stacks/${stackId}/metrics?range=1h`)).json;
    expect(m).toMatchObject({ stepSec: 30, intervalSec: 30, retentionDays: 7 });
    expect(m.containers).toHaveLength(1);
    const pts = m.containers[0].points;
    expect(pts.map((p: any) => p.cpu)).toEqual([10, 20, 30]);
    expect(pts.map((p: any) => p.rxBps)).toEqual([null, 100, null]); // 3000 o / 30 s, puis remise à zéro → inconnu
    expect(pts.map((p: any) => p.txBps)).toEqual([null, 20, null]);
    expect(pts[0]).toMatchObject({ mem: 50000000, memLimit: 512000000 });
  });

  it("regroupe les longues périodes (≤ 240 points) et valide les paramètres", async () => {
    const m = (await call("GET", `/api/v1/stacks/${stackId}/metrics?range=7d`)).json;
    expect(m.stepSec).toBe(2520); // 7 j / 240 points, multiple de la période de collecte
    expect((await call("GET", `/api/v1/stacks/${stackId}/metrics?range=1an`)).status).toBe(400);
    expect((await call("GET", `/api/v1/stacks/${stackId}/metrics?service=a%20b`)).status).toBe(400);
    expect((await call("GET", "/api/v1/stacks/00000000-0000-4000-8000-000000000000/metrics")).status).toBe(404);
    const filtered = (await call("GET", `/api/v1/stacks/${stackId}/metrics?service=db`)).json;
    expect(filtered.containers).toEqual([]);
  });

  it("purge les échantillons au-delà de la rétention (7 jours)", async () => {
    await pool.query(
      `INSERT INTO metric_samples (host_id, observed_at, container_id, container_name, project, service, cpu_percent, mem_bytes, mem_limit, net_rx, net_tx)
       VALUES ($1, now() - interval '8 days', 'c-old', 'app-old-1', 'app', 'old', 1, 1, 1, 1, 1),
              ($1, now() - interval '6 days', 'c-new', 'app-new-1', 'app', 'new', 1, 1, 1, 1, 1)`,
      [hostId],
    );
    expect(await built.metrics.prune()).toBe(1);
    const left = (await pool.query("SELECT container_id FROM metric_samples WHERE container_id IN ('c-old','c-new')")).rows.map((r) => r.container_id);
    expect(left).toEqual(["c-new"]);
  });

  it("alerte quand la sauvegarde Git échoue", async () => {
    await call("POST", "/api/v1/admin/restoration-key");
    await call("PUT", "/api/v1/backup/config", { url: join(root, "inexistant.git"), username: "u", token: "t", branch: "main" });
    await call("POST", "/api/v1/backup/sync?wait=true");
    const alert = (await dashboard()).json.alerts.find((a: any) => a.kind === "backup_failed");
    expect(alert).toMatchObject({ severity: "warning", target: { type: "backup" } });
    expect(alert.message).toContain("révision(s) non sauvegardée(s)");
    expect((await dashboard()).json.backup).toMatchObject({ configured: true });
  });

  it("une opération interrompue par la perte de l'agent devient une alerte, et l'état passe à « inconnu » (pas « arrêtée »)", async () => {
    const before = runs.length;
    const op = (await call("POST", `/api/v1/stacks/${stackId}/stop`)).json.operationId as string;
    await waitFor(() => runs.length > before);
    await new Promise<void>((r) => {
      ws.on("close", () => r());
      ws.close();
    });
    await waitFor(async () => ((await call("GET", `/api/v1/operations/${op}`)).json as any).status === "unknown");

    const d = (await dashboard()).json;
    expect(d.agents).toMatchObject({ online: 0, offline: 1 });
    // La stack n'est PAS « arrêtée » : on ne sait plus rien, et la dernière observation est conservée.
    expect(d.stacks.items[0]).toMatchObject({ status: "unknown", hostPresence: "offline" });
    expect(d.stacks.items[0].observedAt).not.toBeNull();
    expect(d.stacks.counts).toMatchObject({ unknown: 1, stopped: 0 });
    const kinds = d.alerts.map((a: any) => `${a.severity}:${a.kind}`);
    expect(kinds[0]).toBe("critical:agent_offline"); // trié par gravité
    expect(kinds).toContain("warning:operation_unknown");
    expect(d.usage.top).toEqual([]); // métriques d'un hôte hors ligne : périmées, non affichées

    // Reconnexion : l'état redevient connu à la prochaine observation.
    ws = await connect({ kind: "credentials", agentId: hostId, secret });
    await sendInventory([ctr("web"), ctr("db")]);
    expect((await dashboard()).json.stacks.items[0].status).toBe("running");
  });
});
