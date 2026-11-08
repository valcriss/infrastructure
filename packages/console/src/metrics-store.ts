import type { HostMetrics, MetricSample } from "@infra/shared";
import type { Pool } from "./db.js";

export const RANGES: Record<string, number> = { "1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600, "7d": 7 * 24 * 3600 };
/** Nombre maximal de points renvoyés par série. */
const MAX_POINTS = 240;

export interface MetricPoint {
  t: string;
  cpu: number | null;
  mem: number;
  memLimit: number;
  rxBps: number | null;
  txBps: number | null;
}

export interface MetricSeries {
  container: string;
  service: string | null;
  points: MetricPoint[];
}

export interface MetricsQueryResult {
  rangeSec: number;
  stepSec: number;
  intervalSec: number;
  retentionDays: number;
  containers: MetricSeries[];
}

export interface OverviewPoint {
  t: string;
  /** Somme des CPU des conteneurs (100 = un cœur). */
  cpu: number | null;
  mem: number;
  rxBps: number | null;
  txBps: number | null;
}

export interface HostOverview {
  hostId: string;
  name: string;
  cpus: number | null;
  latest: { cpuPercent: number | null; memUsed: number | null; memTotal: number | null; diskUsed: number | null; diskTotal: number | null; observedAt: string } | null;
  points: { t: string; cpu: number | null; mem: number | null; disk: number | null }[];
}

export interface TopApp {
  project: string;
  hostName: string;
  value: number;
}

export interface OverviewResult {
  rangeSec: number;
  stepSec: number;
  intervalSec: number;
  retentionDays: number;
  totals: { points: OverviewPoint[] };
  top: { cpu: TopApp[]; mem: TopApp[] };
  hosts: HostOverview[];
}

export interface LatestSample {
  containerId: string;
  name: string;
  project: string | null;
  service: string | null;
  cpuPercent: number | null;
  memBytes: number;
  memLimitBytes: number;
  observedAt: string;
}

/**
 * Stockage des métriques : insertion groupée, requêtes agrégées (≤ 240 points
 * par série, débits réseau déduits des compteurs cumulés) et purge régulière.
 */
export class MetricsStore {
  private readonly lastIngest = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly pool: Pool,
    readonly intervalSec: number,
    readonly retentionDays: number,
  ) {}

  start(): void {
    void this.prune().catch(() => {});
    this.timer = setInterval(() => void this.prune().catch(() => {}), 60 * 60 * 1000);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Supprime les échantillons plus anciens que la rétention. Retourne le nombre de lignes supprimées. */
  async prune(): Promise<number> {
    const res = await this.pool.query("DELETE FROM metric_samples WHERE observed_at < now() - make_interval(days => $1)", [
      this.retentionDays,
    ]);
    await this.pool.query("DELETE FROM host_metric_samples WHERE observed_at < now() - make_interval(days => $1)", [this.retentionDays]);
    return res.rowCount ?? 0;
  }

  /**
   * Enregistre un lot. L'horodatage est celui de la console (pas celui de
   * l'agent) pour ne pas dépendre de l'horloge de l'hôte. Un agent qui
   * émettrait plus vite que la moitié de la période est ignoré (protection).
   */
  async ingest(hostId: string, samples: MetricSample[], host?: HostMetrics): Promise<boolean> {
    const now = Date.now();
    const last = this.lastIngest.get(hostId) ?? 0;
    if (now - last < (this.intervalSec * 1000) / 2) return false;
    this.lastIngest.set(hostId, now);
    if (host) {
      await this.pool.query(
        `INSERT INTO host_metric_samples (host_id, observed_at, cpu_percent, mem_total, mem_used, disk_total, disk_used)
         VALUES ($1, now(), $2, $3, $4, $5, $6)`,
        [
          hostId,
          host.cpuPercent,
          host.memTotalBytes === undefined ? null : Math.round(host.memTotalBytes),
          host.memUsedBytes === undefined ? null : Math.round(host.memUsedBytes),
          host.diskTotalBytes === undefined ? null : Math.round(host.diskTotalBytes),
          host.diskUsedBytes === undefined ? null : Math.round(host.diskUsedBytes),
        ],
      );
    }
    if (samples.length === 0) return true;
    await this.pool.query(
      `INSERT INTO metric_samples (host_id, observed_at, container_id, container_name, project, service,
                                   cpu_percent, mem_bytes, mem_limit, net_rx, net_tx)
       SELECT $1, now(), * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::real[],
                                       $7::bigint[], $8::bigint[], $9::bigint[], $10::bigint[])`,
      [
        hostId,
        samples.map((s) => s.containerId),
        samples.map((s) => s.name),
        samples.map((s) => s.project ?? null),
        samples.map((s) => s.service ?? null),
        samples.map((s) => s.cpuPercent),
        samples.map((s) => Math.round(s.memBytes)),
        samples.map((s) => Math.round(s.memLimitBytes)),
        samples.map((s) => Math.round(s.netRxBytes)),
        samples.map((s) => Math.round(s.netTxBytes)),
      ],
    );
    return true;
  }

  /** Séries d'un projet Compose sur une période, regroupées par conteneur. */
  async series(hostId: string, project: string, rangeSec: number, service?: string): Promise<MetricsQueryResult> {
    // Pas de regroupement : multiple de la période de collecte, ≤ MAX_POINTS points.
    const stepSec = Math.max(this.intervalSec, Math.ceil(rangeSec / MAX_POINTS / this.intervalSec) * this.intervalSec);
    const { rows } = await this.pool.query<{
      container_name: string;
      service: string | null;
      bucket: Date;
      cpu: number | null;
      mem: string;
      mem_limit: string;
      rx: string;
      tx: string;
    }>(
      `SELECT container_name, service,
              to_timestamp(floor(extract(epoch FROM observed_at) / $4) * $4) AS bucket,
              avg(cpu_percent) AS cpu, avg(mem_bytes) AS mem, max(mem_limit) AS mem_limit,
              max(net_rx) AS rx, max(net_tx) AS tx
         FROM metric_samples
        WHERE host_id = $1 AND project = $2 AND observed_at >= now() - make_interval(secs => $3)
          AND ($5::text IS NULL OR service = $5)
        GROUP BY container_name, service, bucket
        ORDER BY container_name, bucket`,
      [hostId, project, rangeSec, stepSec, service ?? null],
    );

    const byContainer = new Map<string, MetricSeries>();
    const prev = new Map<string, { t: number; rx: number; tx: number }>();
    for (const r of rows) {
      const series = byContainer.get(r.container_name) ?? { container: r.container_name, service: r.service, points: [] };
      byContainer.set(r.container_name, series);
      const t = r.bucket.getTime();
      const rx = Number(r.rx);
      const tx = Number(r.tx);
      const p = prev.get(r.container_name);
      // Débit = variation du compteur cumulé / durée ; un compteur qui baisse (redémarrage) donne « inconnu ».
      const dt = p ? (t - p.t) / 1000 : 0;
      series.points.push({
        t: r.bucket.toISOString(),
        cpu: r.cpu === null ? null : Math.round(r.cpu * 100) / 100,
        mem: Math.round(Number(r.mem)),
        memLimit: Number(r.mem_limit),
        rxBps: p && dt > 0 && rx >= p.rx ? Math.round((rx - p.rx) / dt) : null,
        txBps: p && dt > 0 && tx >= p.tx ? Math.round((tx - p.tx) / dt) : null,
      });
      prev.set(r.container_name, { t, rx, tx });
    }
    return { rangeSec, stepSec, intervalSec: this.intervalSec, retentionDays: this.retentionDays, containers: [...byContainer.values()] };
  }

  /**
   * Vue d'ensemble de tous les hôtes : totaux CPU / mémoire / réseau des conteneurs, applications
   * les plus gourmandes et utilisation de chaque machine, sur une période (≤ 240 points par série).
   */
  async overview(rangeSec: number, excludeProjects: string[] = []): Promise<OverviewResult> {
    const excluded = new Set(excludeProjects);
    const stepSec = Math.max(this.intervalSec, Math.ceil(rangeSec / MAX_POINTS / this.intervalSec) * this.intervalSec);
    const [containers, hostRows, hostSeries, hostInfo] = await Promise.all([
      this.pool.query<{ host_id: string; container_id: string; app: string; bucket: Date; cpu: number | null; mem: string; rx: string; tx: string }>(
        `SELECT host_id, container_id, coalesce(project, container_name) AS app,
                to_timestamp(floor(extract(epoch FROM observed_at) / $2) * $2) AS bucket,
                avg(cpu_percent) AS cpu, avg(mem_bytes) AS mem, max(net_rx) AS rx, max(net_tx) AS tx
           FROM metric_samples
          WHERE observed_at >= now() - make_interval(secs => $1)
          GROUP BY host_id, container_id, app, bucket
          ORDER BY container_id, bucket`,
        [rangeSec, stepSec],
      ),
      this.pool.query<{ id: string; name: string; host_info: { cpus?: number } | null }>(
        "SELECT id, name, host_info FROM hosts WHERE revoked_at IS NULL ORDER BY created_at",
      ),
      this.pool.query<{ host_id: string; bucket: Date; cpu: number | null; mem: string | null; disk: string | null }>(
        `SELECT host_id, to_timestamp(floor(extract(epoch FROM observed_at) / $2) * $2) AS bucket,
                avg(cpu_percent) AS cpu, avg(mem_used) AS mem, avg(disk_used) AS disk
           FROM host_metric_samples
          WHERE observed_at >= now() - make_interval(secs => $1)
          GROUP BY host_id, bucket ORDER BY bucket`,
        [rangeSec, stepSec],
      ),
      this.pool.query<{ host_id: string; observed_at: Date; cpu_percent: number | null; mem_total: string | null; mem_used: string | null; disk_total: string | null; disk_used: string | null }>(
        `SELECT DISTINCT ON (host_id) host_id, observed_at, cpu_percent, mem_total, mem_used, disk_total, disk_used
           FROM host_metric_samples WHERE observed_at >= now() - make_interval(secs => $1)
          ORDER BY host_id, observed_at DESC`,
        [this.intervalSec * 3],
      ),
    ]);
    const hostNames = new Map(hostRows.rows.map((h) => [h.id, h.name]));

    // Totaux par instant : somme des conteneurs. Le débit réseau se déduit des compteurs de chaque conteneur.
    const totals = new Map<number, { cpu: number | null; mem: number; rx: number | null; tx: number | null }>();
    const apps = new Map<string, { app: string; host: string; byBucket: Map<number, { cpu: number; mem: number }> }>();
    const prev = new Map<string, { t: number; rx: number; tx: number }>();
    for (const r of containers.rows) {
      if (!hostNames.has(r.host_id) || excluded.has(r.app)) continue;
      const t = r.bucket.getTime();
      const slot = totals.get(t) ?? { cpu: null, mem: 0, rx: null, tx: null };
      totals.set(t, slot);
      if (r.cpu !== null) slot.cpu = (slot.cpu ?? 0) + r.cpu;
      slot.mem += Number(r.mem);
      const rx = Number(r.rx);
      const tx = Number(r.tx);
      const p = prev.get(r.container_id);
      const dt = p ? (t - p.t) / 1000 : 0;
      if (p && dt > 0 && rx >= p.rx && tx >= p.tx) {
        slot.rx = (slot.rx ?? 0) + (rx - p.rx) / dt;
        slot.tx = (slot.tx ?? 0) + (tx - p.tx) / dt;
      }
      prev.set(r.container_id, { t, rx, tx });

      const key = `${r.host_id}|${r.app}`;
      const a = apps.get(key) ?? { app: r.app, host: hostNames.get(r.host_id) ?? "", byBucket: new Map() };
      apps.set(key, a);
      const b = a.byBucket.get(t) ?? { cpu: 0, mem: 0 };
      b.cpu += r.cpu ?? 0;
      b.mem += Number(r.mem);
      a.byBucket.set(t, b);
    }
    const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const ranked = [...apps.values()].map((a) => {
      const v = [...a.byBucket.values()];
      return { project: a.app, hostName: a.host, cpu: avg(v.map((x) => x.cpu)), mem: avg(v.map((x) => x.mem)) };
    });
    const top = (key: "cpu" | "mem"): TopApp[] =>
      ranked
        .filter((a) => a[key] > 0)
        .sort((x, y) => y[key] - x[key])
        .slice(0, 5)
        .map((a) => ({ project: a.project, hostName: a.hostName, value: Math.round(a[key] * 100) / 100 }));

    const latest = new Map(hostInfo.rows.map((r) => [r.host_id, r]));
    const num = (v: string | null): number | null => (v === null ? null : Number(v));
    return {
      rangeSec,
      stepSec,
      intervalSec: this.intervalSec,
      retentionDays: this.retentionDays,
      totals: {
        points: [...totals.entries()]
          .sort(([a], [b]) => a - b)
          .map(([t, v]) => ({
            t: new Date(t).toISOString(),
            cpu: v.cpu === null ? null : Math.round(v.cpu * 100) / 100,
            mem: Math.round(v.mem),
            rxBps: v.rx === null ? null : Math.round(v.rx),
            txBps: v.tx === null ? null : Math.round(v.tx),
          })),
      },
      top: { cpu: top("cpu"), mem: top("mem") },
      hosts: hostRows.rows.map((h) => {
        const l = latest.get(h.id);
        return {
          hostId: h.id,
          name: h.name,
          cpus: h.host_info?.cpus ?? null,
          latest: l
            ? { cpuPercent: l.cpu_percent, memUsed: num(l.mem_used), memTotal: num(l.mem_total), diskUsed: num(l.disk_used), diskTotal: num(l.disk_total), observedAt: l.observed_at.toISOString() }
            : null,
          points: hostSeries.rows
            .filter((r) => r.host_id === h.id)
            .map((r) => ({ t: r.bucket.toISOString(), cpu: r.cpu === null ? null : Math.round(r.cpu * 10) / 10, mem: num(r.mem), disk: num(r.disk) })),
        };
      }),
    };
  }

  /** Dernier échantillon connu de chaque conteneur d'un hôte (≤ 3 périodes). */
  async latest(hostId: string): Promise<LatestSample[]> {
    const { rows } = await this.pool.query<{
      container_id: string;
      container_name: string;
      project: string | null;
      service: string | null;
      cpu_percent: number | null;
      mem_bytes: string;
      mem_limit: string;
      observed_at: Date;
    }>(
      `SELECT DISTINCT ON (container_id) container_id, container_name, project, service, cpu_percent,
              mem_bytes, mem_limit, observed_at
         FROM metric_samples
        WHERE host_id = $1 AND observed_at >= now() - make_interval(secs => $2)
        ORDER BY container_id, observed_at DESC`,
      [hostId, this.intervalSec * 3],
    );
    return rows.map((r) => ({
      containerId: r.container_id,
      name: r.container_name,
      project: r.project,
      service: r.service,
      cpuPercent: r.cpu_percent,
      memBytes: Number(r.mem_bytes),
      memLimitBytes: Number(r.mem_limit),
      observedAt: r.observed_at.toISOString(),
    }));
  }
}
