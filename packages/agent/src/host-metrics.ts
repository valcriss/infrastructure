import type { HostMetrics } from "@infra/shared";
import { readFile, statfs } from "node:fs/promises";

/** Compteurs cumulés de la ligne « cpu » de /proc/stat : [temps total, temps inactif]. */
export function parseCpuStat(text: string): { total: number; idle: number } | null {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1).map(Number);
  if (v.length < 4 || v.some((n) => !Number.isFinite(n))) return null;
  // user nice system idle iowait irq softirq steal : iowait compte comme inactif ; guest est déjà inclus dans user/nice.
  const idle = (v[3] ?? 0) + (v[4] ?? 0);
  const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
  return { total, idle };
}

/** Pourcentage d'occupation de l'ensemble des cœurs entre deux relevés (0 à 100). */
export function cpuUsage(prev: { total: number; idle: number } | null, cur: { total: number; idle: number } | null): number | null {
  if (!prev || !cur) return null;
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0 || dIdle < 0) return null;
  return Math.round(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)) * 10) / 10;
}

/** Mémoire totale et utilisée (hors cache récupérable : MemAvailable) d'après /proc/meminfo, en octets. */
export function parseMeminfo(text: string): { total: number; used: number } | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (total === null || available === null || total <= 0) return null;
  return { total, used: Math.max(0, total - available) };
}

/**
 * Utilisation de la machine hôte. Dans un conteneur Linux, /proc/stat et /proc/meminfo
 * décrivent l'hôte ; le disque mesuré est celui de la partition qui porte l'espace de
 * travail (monté au même chemin sur l'hôte). Tout ce qui n'est pas mesurable est omis.
 */
export class HostMetricsCollector {
  private previous: { total: number; idle: number } | null = null;

  constructor(
    private readonly workspaceDir: string,
    private readonly procDir = "/proc",
  ) {}

  async collect(): Promise<HostMetrics | null> {
    const out: HostMetrics = { cpuPercent: null };
    let measured = false;
    try {
      const cur = parseCpuStat(await readFile(`${this.procDir}/stat`, "utf8"));
      out.cpuPercent = cpuUsage(this.previous, cur);
      this.previous = cur;
      measured ||= cur !== null;
    } catch {
      /* hôte sans /proc (développement hors Linux) */
    }
    try {
      const mem = parseMeminfo(await readFile(`${this.procDir}/meminfo`, "utf8"));
      if (mem) {
        out.memTotalBytes = mem.total;
        out.memUsedBytes = mem.used;
        measured = true;
      }
    } catch {
      /* idem */
    }
    try {
      const fs = await statfs(this.workspaceDir);
      const total = fs.blocks * fs.bsize;
      if (total > 0) {
        out.diskTotalBytes = total;
        out.diskUsedBytes = Math.max(0, total - fs.bavail * fs.bsize);
        measured = true;
      }
    } catch {
      /* dossier absent */
    }
    return measured ? out : null;
  }
}
