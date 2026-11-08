import { describe, expect, it } from "vitest";
import { mapLimit, parseInfo, parseInspect } from "./docker.js";
import { cpuCounters, cpuPercent, memoryUsage, networkTotals } from "./metrics.js";

describe("parseInspect", () => {
  it("distingue « aucun healthcheck » de « unhealthy »", () => {
    expect(parseInspect({ RestartCount: 0, State: { StartedAt: "2026-11-06T10:00:00Z", ExitCode: 0 } })?.health).toBe("none");
    expect(parseInspect({ State: { Health: { Status: "healthy" } } })?.health).toBe("healthy");
    expect(parseInspect({ State: { Health: { Status: "unhealthy" } } })?.health).toBe("unhealthy");
    expect(parseInspect({ State: { Health: { Status: "starting" } } })?.health).toBe("starting");
    expect(parseInspect({ State: { Health: { Status: "inconnu" } } })?.health).toBe("none");
  });

  it("lit redémarrages, dernier démarrage et code de sortie", () => {
    expect(parseInspect({ RestartCount: 4, State: { StartedAt: "2026-11-06T10:00:00Z", ExitCode: 137 } })).toEqual({
      health: "none",
      restartCount: 4,
      startedAt: "2026-11-06T10:00:00Z",
      exitCode: 137,
    });
  });

  it("extrait le dernier test du healthcheck (sortie, code, commande)", () => {
    const probe = parseInspect({
      State: { Health: { Status: "unhealthy", FailingStreak: 3, Log: [{ ExitCode: 0, Output: "ok", End: "t0" }, { ExitCode: 1, Output: "wget: can't connect\n", End: "2026-11-08T05:00:00Z" }] } },
      Config: { Healthcheck: { Test: ["CMD-SHELL", "wget -q http://127.0.0.1/"], Retries: 5 } },
    })?.healthProbe;
    expect(probe).toEqual({ exitCode: 1, output: "wget: can't connect", at: "2026-11-08T05:00:00Z", command: "CMD-SHELL wget -q http://127.0.0.1/", failingStreak: 3, retries: 5 });
    expect(parseInspect({ State: { Health: { Status: "starting", Log: [] } } })?.healthProbe).toBeUndefined();
    expect(parseInspect({ State: {} })?.healthProbe).toBeUndefined();
  });

  it("traite un conteneur jamais démarré et une réponse invalide", () => {
    expect(parseInspect({ State: { StartedAt: "0001-01-01T00:00:00Z" } })?.startedAt).toBe("");
    expect(parseInspect(null)).toBeNull();
    expect(parseInspect("x")).toBeNull();
  });
});

describe("parseInfo", () => {
  it("résume l'hôte Docker et ignore les valeurs invalides", () => {
    expect(
      parseInfo({ NCPU: 8, MemTotal: 16e9, OperatingSystem: "Debian", ServerVersion: "29.0", ContainersRunning: 3, ContainersPaused: 0, ContainersStopped: 2, Images: 10 }),
    ).toEqual({ cpus: 8, memTotalBytes: 16e9, os: "Debian", serverVersion: "29.0", containersRunning: 3, containersPaused: 0, containersStopped: 2, images: 10 });
    expect(parseInfo({ NCPU: -1, MemTotal: "x" })?.cpus).toBe(0);
    expect(parseInfo(undefined)).toBeUndefined();
  });
});

describe("calcul des métriques", () => {
  it("calcule le CPU comme docker stats, sans relevé précédent ni remise à zéro", () => {
    const a = cpuCounters({ cpu_stats: { cpu_usage: { total_usage: 1_000_000 }, system_cpu_usage: 10_000_000, online_cpus: 4 } });
    const b = cpuCounters({ cpu_stats: { cpu_usage: { total_usage: 1_500_000 }, system_cpu_usage: 12_000_000, online_cpus: 4 } });
    expect(cpuPercent(undefined, b)).toBeNull(); // premier échantillon
    expect(cpuPercent(a ?? undefined, b)).toBe(100); // 500k / 2M × 4 cœurs × 100
    const reset = cpuCounters({ cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 13_000_000, online_cpus: 4 } });
    expect(cpuPercent(b ?? undefined, reset)).toBeNull(); // conteneur redémarré
    expect(cpuCounters({})).toBeNull();
  });

  it("soustrait le cache de pages de la mémoire (cgroup v2, v1 et cache)", () => {
    expect(memoryUsage({ memory_stats: { usage: 100, stats: { inactive_file: 30 } } })).toBe(70);
    expect(memoryUsage({ memory_stats: { usage: 100, stats: { total_inactive_file: 20 } } })).toBe(80);
    expect(memoryUsage({ memory_stats: { usage: 100, stats: { cache: 10 } } })).toBe(90);
    expect(memoryUsage({ memory_stats: { usage: 100, stats: { inactive_file: 500 } } })).toBe(100); // incohérent : ignoré
    expect(memoryUsage({})).toBe(0);
  });

  it("additionne les interfaces réseau", () => {
    expect(networkTotals({ eth0: { rx_bytes: 10, tx_bytes: 4 }, eth1: { rx_bytes: 5, tx_bytes: 1 } })).toEqual({ rx: 15, tx: 5 });
    expect(networkTotals(undefined)).toEqual({ rx: 0, tx: 0 });
  });
});

describe("mapLimit", () => {
  it("conserve l'ordre et borne la concurrence", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
