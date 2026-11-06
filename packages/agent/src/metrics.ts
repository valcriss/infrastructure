import type { MetricSample } from "@infra/shared";
import { dockerGet, mapLimit } from "./docker.js";

interface RawStats {
  cpu_stats?: { cpu_usage?: { total_usage?: number; percpu_usage?: unknown[] }; system_cpu_usage?: number; online_cpus?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Mémoire utilisée comme le fait `docker stats` : l'usage du cgroup moins le
 * cache de pages inactif (`inactive_file` en cgroup v2, `total_inactive_file`
 * en cgroup v1, ou `cache`).
 */
export function memoryUsage(stats: RawStats): number {
  const usage = num(stats.memory_stats?.usage);
  const s = stats.memory_stats?.stats ?? {};
  const cache = num(s.inactive_file ?? s.total_inactive_file ?? s.cache);
  return cache > 0 && cache < usage ? usage - cache : usage;
}

/** Somme des compteurs réseau de toutes les interfaces. */
export function networkTotals(networks: RawStats["networks"]): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(networks ?? {})) {
    rx += num(n.rx_bytes);
    tx += num(n.tx_bytes);
  }
  return { rx, tx };
}

export interface CpuCounters {
  total: number;
  system: number;
  cpus: number;
}

export function cpuCounters(stats: RawStats): CpuCounters | null {
  const total = stats.cpu_stats?.cpu_usage?.total_usage;
  const system = stats.cpu_stats?.system_cpu_usage;
  if (typeof total !== "number" || typeof system !== "number") return null;
  const cpus = num(stats.cpu_stats?.online_cpus) || (stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 0) || 1;
  return { total, system, cpus };
}

/**
 * Pourcentage de CPU entre deux relevés (100 = un cœur complet), calculé
 * comme `docker stats`. Retourne null sans relevé précédent ou si les
 * compteurs ont été remis à zéro (redémarrage du conteneur).
 */
export function cpuPercent(prev: CpuCounters | undefined, cur: CpuCounters | null): number | null {
  if (!prev || !cur) return null;
  const dTotal = cur.total - prev.total;
  const dSystem = cur.system - prev.system;
  if (dTotal < 0 || dSystem <= 0) return null;
  return Math.round((dTotal / dSystem) * cur.cpus * 100 * 100) / 100;
}

interface RunningContainer {
  Id?: string;
  Names?: string[];
  Labels?: Record<string, string>;
}

/** Collecte périodique des métriques des conteneurs en cours d'exécution. */
export class MetricsCollector {
  private readonly previous = new Map<string, CpuCounters>();

  constructor(private readonly socketPath: string) {}

  async collect(): Promise<MetricSample[]> {
    const list = (await dockerGet(this.socketPath, "/containers/json")) as RunningContainer[];
    const running = Array.isArray(list) ? list.filter((c) => typeof c.Id === "string") : [];
    const seen = new Set<string>();

    const samples = await mapLimit(running, 8, async (c): Promise<MetricSample | null> => {
      const id = c.Id as string;
      try {
        const stats = (await dockerGet(this.socketPath, `/containers/${encodeURIComponent(id)}/stats?stream=false&one-shot=true`)) as RawStats;
        const counters = cpuCounters(stats);
        const cpu = cpuPercent(this.previous.get(id), counters);
        if (counters) this.previous.set(id, counters);
        seen.add(id);
        const net = networkTotals(stats.networks);
        const project = c.Labels?.["com.docker.compose.project"];
        const service = c.Labels?.["com.docker.compose.service"];
        return {
          containerId: id.slice(0, 64),
          name: (c.Names?.[0] ?? id).replace(/^\//, "").slice(0, 200),
          ...(project ? { project: project.slice(0, 100) } : {}),
          ...(service ? { service: service.slice(0, 200) } : {}),
          cpuPercent: cpu,
          memBytes: memoryUsage(stats),
          memLimitBytes: num(stats.memory_stats?.limit),
          netRxBytes: net.rx,
          netTxBytes: net.tx,
        };
      } catch {
        return null; // conteneur arrêté entre-temps ou stats indisponibles
      }
    });

    for (const id of this.previous.keys()) if (!seen.has(id)) this.previous.delete(id);
    return samples.filter((s): s is MetricSample => s !== null);
  }
}
