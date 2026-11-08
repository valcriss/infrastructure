import type { Container } from "@infra/shared";
import { describe, expect, it } from "vitest";
import { STALE_AFTER_SEC, deriveAlerts, deriveStackStatus, type AlertContext, type StackStatusInput } from "./dashboard.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const fresh = new Date(NOW - 20_000);

const ctr = (over: Partial<Container> & { svc: string }): Container => ({
  id: `id-${over.svc}`,
  names: [`proj-${over.svc}-1`],
  image: "img",
  imageId: "sha256:1",
  state: "running",
  status: "Up",
  created: 1,
  composeProject: "proj",
  composeService: over.svc,
  health: "none",
  restartCount: 0,
  startedAt: new Date(NOW - 3600_000).toISOString(),
  exitCode: 0,
  ...over,
});

const input = (over: Partial<StackStatusInput> = {}): StackStatusInput => ({
  deployedRevision: 1,
  hostOnline: true,
  inventoryObservedAt: fresh,
  now: NOW,
  containers: [ctr({ svc: "web" }), ctr({ svc: "db" })],
  expectedServices: [
    { name: "web", optional: false },
    { name: "db", optional: false },
  ],
  ...over,
});

describe("deriveStackStatus — ce qui est su et ce qui est inconnu", () => {
  it("running : tous les conteneurs en marche", () => {
    const h = deriveStackStatus(input());
    expect(h.status).toBe("running");
    expect(h.containers).toMatchObject({ total: 2, running: 2, unhealthy: 0, noHealthcheck: 2 });
  });

  it("never_deployed prime sur tout le reste", () => {
    expect(deriveStackStatus(input({ deployedRevision: null, hostOnline: false })).status).toBe("not_deployed");
  });

  it("hôte hors ligne → inconnu (jamais « arrêtée »), dernière observation conservée", () => {
    const h = deriveStackStatus(input({ hostOnline: false, containers: [] }));
    expect(h.status).toBe("unknown");
    expect(h.observedAt).toBe(fresh.toISOString());
    expect(h.reason).toMatch(/hors ligne/);
  });

  it("observation absente ou périmée → inconnu", () => {
    expect(deriveStackStatus(input({ inventoryObservedAt: null })).status).toBe("unknown");
    const old = new Date(NOW - (STALE_AFTER_SEC + 5) * 1000);
    expect(deriveStackStatus(input({ inventoryObservedAt: old })).status).toBe("unknown");
    const justOk = new Date(NOW - (STALE_AFTER_SEC - 5) * 1000);
    expect(deriveStackStatus(input({ inventoryObservedAt: justOk })).status).toBe("running");
  });

  it("stopped : aucun conteneur ou aucun en marche (dont arrêt propre code 0)", () => {
    expect(deriveStackStatus(input({ containers: [] })).status).toBe("stopped");
    const exited = [ctr({ svc: "web", state: "exited", exitCode: 0 }), ctr({ svc: "db", state: "exited", exitCode: 0 })];
    expect(deriveStackStatus(input({ containers: exited })).status).toBe("stopped");
  });

  it("degraded : conteneur planté, healthcheck en échec ou service absent", () => {
    const crashed = deriveStackStatus(input({ containers: [ctr({ svc: "web" }), ctr({ svc: "db", state: "exited", exitCode: 137 })] }));
    expect(crashed.status).toBe("degraded");
    expect(crashed.reason).toContain("db : exited (code 137)");

    const unhealthy = deriveStackStatus(input({ containers: [ctr({ svc: "web", health: "unhealthy" }), ctr({ svc: "db" })] }));
    expect(unhealthy.status).toBe("degraded");
    expect(unhealthy.containers.unhealthy).toBe(1);

    const missing = deriveStackStatus(input({ containers: [ctr({ svc: "web" })] }));
    expect(missing).toMatchObject({ status: "degraded", missingServices: ["db"] });

    const restarting = deriveStackStatus(input({ containers: [ctr({ svc: "web" }), ctr({ svc: "db", state: "restarting" })] }));
    expect(restarting.status).toBe("degraded");
    expect(restarting.containers.restarting).toBe(1);
  });

  it("n'alerte pas pour une tâche terminée avec succès, ni pour un service sous profile, ni pendant le démarrage", () => {
    const job = deriveStackStatus(input({ containers: [ctr({ svc: "web" }), ctr({ svc: "db" }), ctr({ svc: "migrate", state: "exited", exitCode: 0 })] }));
    expect(job.status).toBe("running");
    const optional = deriveStackStatus(input({ containers: [ctr({ svc: "web" }), ctr({ svc: "db" })], expectedServices: [{ name: "web", optional: false }, { name: "db", optional: false }, { name: "debug", optional: true }] }));
    expect(optional.status).toBe("running");
    const starting = deriveStackStatus(input({ containers: [ctr({ svc: "web", health: "starting" }), ctr({ svc: "db" })] }));
    expect(starting.status).toBe("running");
  });
});

const baseCtx = (over: Partial<AlertContext> = {}): AlertContext => ({
  now: NOW,
  hosts: [{ id: "h1", name: "hôte 1", online: true, lastSeenAt: fresh, inventoryObservedAt: fresh }],
  stacks: [],
  containers: [],
  backup: { state: "ok", lastError: null, pendingRevisions: 0, configured: true },
  unknownOperations: [],
  ...over,
});

describe("deriveAlerts", () => {
  it("ne produit rien quand tout va bien", () => {
    expect(deriveAlerts(baseCtx())).toEqual([]);
  });

  it("signale un agent hors ligne (critique) et une observation périmée", () => {
    const off = deriveAlerts(baseCtx({ hosts: [{ id: "h1", name: "hôte 1", online: false, lastSeenAt: fresh, inventoryObservedAt: fresh }] }));
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ id: "agent_offline:h1", severity: "critical", since: fresh.toISOString() });

    const old = new Date(NOW - (STALE_AFTER_SEC + 1) * 1000);
    const stale = deriveAlerts(baseCtx({ hosts: [{ id: "h1", name: "hôte 1", online: true, lastSeenAt: fresh, inventoryObservedAt: old }] }));
    expect(stale[0]).toMatchObject({ kind: "inventory_stale", severity: "warning" });
  });

  it("signale stacks dégradées et arrêtées, mais pas les stacks inconnues (déjà couvertes par l'agent)", () => {
    const health = (status: "degraded" | "stopped" | "unknown") => ({ status, reason: "r", observedAt: null, containers: { total: 0, running: 0, unhealthy: 0, restarting: 0, noHealthcheck: 0 }, missingServices: [] });
    const alerts = deriveAlerts(
      baseCtx({
        stacks: [
          { id: "s1", name: "a", hostId: "h1", health: health("degraded") },
          { id: "s2", name: "b", hostId: "h1", health: health("stopped") },
          { id: "s3", name: "c", hostId: "h1", health: health("unknown") },
        ],
      }),
    );
    expect(alerts.map((a) => a.kind).sort()).toEqual(["stack_degraded", "stack_stopped"]);
    expect(alerts.find((a) => a.kind === "stack_stopped")?.severity).toBe("info");
  });

  it("détecte healthcheck en échec et redémarrages répétés récents", () => {
    const alerts = deriveAlerts(
      baseCtx({
        containers: [
          { hostId: "h1", stackId: "s1", container: ctr({ svc: "web", health: "unhealthy" }) },
          { hostId: "h1", stackId: "s1", container: ctr({ svc: "loop", restartCount: 5, startedAt: new Date(NOW - 60_000).toISOString() }) },
          { hostId: "h1", stackId: "s1", container: ctr({ svc: "ancien", restartCount: 5, startedAt: new Date(NOW - 3 * 3600_000).toISOString() }) },
          { hostId: "h1", stackId: null, container: ctr({ svc: "externe", restartCount: 9, startedAt: new Date(NOW - 1000).toISOString() }) },
        ],
      }),
    );
    expect(alerts.map((a) => a.id).sort()).toEqual(["container_unhealthy:h1:id-web", "restart_loop:h1:id-loop"]);
  });

  it("reprend la raison du dernier test dans l'alerte de healthcheck", () => {
    const alerts = deriveAlerts(
      baseCtx({
        containers: [
          { hostId: "h1", stackId: "s1", container: { ...ctr({ svc: "web", health: "unhealthy" }), healthProbe: { exitCode: 1, output: "wget: can't connect", at: "2026-11-08T05:00:00Z" } } },
        ],
      }),
    );
    expect(alerts[0]?.message).toContain("« wget: can't connect »");
    expect(alerts[0]?.message).toContain("code de sortie 1");
  });

  it("signale l'échec ou le blocage de la sauvegarde Git, et l'absence de configuration", () => {
    const failed = deriveAlerts(baseCtx({ backup: { state: "error", configured: true, pendingRevisions: 3, lastError: { code: "git_unreachable", message: "Serveur Git injoignable.", at: fresh.toISOString() } } }));
    expect(failed[0]).toMatchObject({ kind: "backup_failed", severity: "warning" });
    expect(failed[0]?.message).toContain("3 révision(s) non sauvegardée(s)");

    const blocked = deriveAlerts(baseCtx({ backup: { state: "blocked", configured: true, pendingRevisions: 1, lastError: { code: "diverged", message: "Divergence", at: "" } } }));
    expect(blocked[0]).toMatchObject({ kind: "backup_blocked", severity: "critical" });

    expect(deriveAlerts(baseCtx({ backup: { state: "not_configured", configured: false, pendingRevisions: 0, lastError: null } }))[0]?.kind).toBe("backup_not_configured");
    expect(deriveAlerts(baseCtx({ backup: null }))).toEqual([]);
  });

  it("signale les opérations au résultat inconnu et trie par gravité", () => {
    const alerts = deriveAlerts(
      baseCtx({
        hosts: [{ id: "h1", name: "hôte 1", online: false, lastSeenAt: fresh, inventoryObservedAt: fresh }],
        unknownOperations: [{ id: "op1", type: "deploy", stackName: "app", finishedAt: fresh }],
        backup: { state: "not_configured", configured: false, pendingRevisions: 0, lastError: null },
      }),
    );
    expect(alerts.map((a) => a.severity)).toEqual(["critical", "warning", "info"]);
    expect(alerts[1]?.message).toContain("Rien n'a été rejoué");
  });
});
