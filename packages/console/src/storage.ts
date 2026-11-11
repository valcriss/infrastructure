import { randomUUID } from "node:crypto";
import { MAX_STORAGE_BINDS, MAX_STORAGE_VOLUMES, type ConsoleMessage, type Container, type StorageUsageMessage } from "@infra/shared";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";

/** Relevé périodique : un hôte est remesuré quand son dernier relevé a plus de 6 h. */
const REFRESH_MS = 6 * 3_600_000;
const TICK_MS = 10 * 60_000;
/** Au-delà, une mesure sans réponse est considérée perdue (agent redémarré, ancienne version…). */
const STALE_INFLIGHT_MS = 20 * 60_000;

export type MountKind = "volume" | "bind";

export interface MountSize {
  sizeBytes: number | null;
  note: string | null;
  measuredAt: Date;
}

export interface StorageItem {
  /** « tmpfs » : en mémoire, jamais mesuré. */
  kind: MountKind | "tmpfs";
  source: string | null;
  usedBy: { service: string; container: string; destination: string; rw: boolean }[];
  sizeBytes: number | null;
  /** Raison d'une taille absente (emplacement système, délai dépassé…). */
  note: string | null;
  measuredAt: string | null;
}

export interface StorageView {
  items: StorageItem[];
  /** Somme des tailles connues, chaque volume ou dossier n'étant compté qu'une fois. */
  totalBytes: number | null;
  unmeasured: number;
  measuredAt: string | null;
}

export const sizeKey = (kind: string, source: string): string => `${kind}:${source}`;

/** Montages distincts (volume ou dossier) des conteneurs, avec leur taille connue : fonction pure, testée. */
export function buildStorage(containers: Container[], sizes: Map<string, MountSize>): StorageView {
  const byKey = new Map<string, StorageItem>();
  for (const c of containers) {
    for (const m of c.mounts ?? []) {
      const kind = m.type === "volume" || m.type === "bind" ? m.type : m.type === "tmpfs" ? "tmpfs" : null;
      if (!kind) continue;
      const source = m.source ?? null;
      const key = kind === "tmpfs" || !source ? `${kind}:${c.id}:${m.destination}` : sizeKey(kind, source);
      let item = byKey.get(key);
      if (!item) {
        const known = kind !== "tmpfs" && source ? sizes.get(sizeKey(kind, source)) : undefined;
        item = { kind, source, usedBy: [], sizeBytes: known?.sizeBytes ?? null, note: known?.note ?? null, measuredAt: known?.measuredAt.toISOString() ?? null };
        byKey.set(key, item);
      }
      item.usedBy.push({ service: c.composeService ?? c.names[0] ?? c.id.slice(0, 12), container: c.names[0] ?? c.id.slice(0, 12), destination: m.destination, rw: m.rw });
    }
  }
  const items = [...byKey.values()].sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || (a.source ?? "").localeCompare(b.source ?? ""));
  const measurable = items.filter((i) => i.kind !== "tmpfs");
  const known = measurable.filter((i) => i.sizeBytes !== null);
  const at = known.map((i) => Date.parse(i.measuredAt ?? "")).filter(Number.isFinite);
  return {
    items,
    totalBytes: known.length > 0 ? known.reduce((s, i) => s + (i.sizeBytes ?? 0), 0) : null,
    unmeasured: measurable.length - known.length,
    measuredAt: at.length > 0 ? new Date(Math.max(...at)).toISOString() : null,
  };
}

/** Sources distinctes des volumes et dossiers « bind » de ces conteneurs. */
export function mountSources(containers: Container[]): { volumes: string[]; binds: string[] } {
  const volumes = new Set<string>();
  const binds = new Set<string>();
  for (const c of containers) {
    for (const m of c.mounts ?? []) {
      if (!m.source) continue;
      if (m.type === "volume") volumes.add(m.source);
      else if (m.type === "bind") binds.add(m.source);
    }
  }
  return { volumes: [...volumes], binds: [...binds] };
}

export async function loadSizes(pool: Pick<Pool, "query">, hostId?: string): Promise<Map<string, Map<string, MountSize>>> {
  const { rows } = await pool.query<{ host_id: string; kind: string; source: string; size_bytes: string | null; note: string | null; measured_at: Date }>(
    hostId ? "SELECT host_id, kind, source, size_bytes, note, measured_at FROM mount_sizes WHERE host_id = $1" : "SELECT host_id, kind, source, size_bytes, note, measured_at FROM mount_sizes",
    hostId ? [hostId] : [],
  );
  const out = new Map<string, Map<string, MountSize>>();
  for (const r of rows) {
    const m = out.get(r.host_id) ?? new Map<string, MountSize>();
    m.set(sizeKey(r.kind, r.source), { sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), note: r.note, measuredAt: r.measured_at });
    out.set(r.host_id, m);
  }
  return out;
}

interface Transport {
  send(hostId: string, message: ConsoleMessage): boolean;
  isOnline(hostId: string): boolean;
}

/**
 * Tailles des montages des hôtes : mesure à la demande (fiche d'une application) et relevé périodique de tous les
 * hôtes en ligne. L'agent répond de façon asynchrone (un `du` peut durer des minutes) : une mesure à la fois par hôte.
 */
export class StorageService {
  private timer: NodeJS.Timeout | undefined;
  private readonly inflight = new Map<string, { requestId: string; startedAt: number }>();

  constructor(
    private readonly pool: Pool,
    private readonly transport: Transport,
    private readonly log: { error(obj: unknown, msg?: string): void } = { error: () => {} },
  ) {}

  start(tickMs = TICK_MS): void {
    this.timer = setInterval(() => void this.scheduledPass().catch((e: unknown) => this.log.error(e, "relevé périodique des montages")), tickMs);
    this.timer.unref();
    setTimeout(() => void this.scheduledPass().catch((e: unknown) => this.log.error(e, "relevé périodique des montages")), 2 * 60_000).unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  isMeasuring(hostId: string, now = Date.now()): boolean {
    const f = this.inflight.get(hostId);
    return !!f && now - f.startedAt < STALE_INFLIGHT_MS;
  }

  onDisconnect(hostId: string): void {
    this.inflight.delete(hostId);
  }

  /** Enregistre les tailles reçues ; une mesure échouée conserve la dernière taille connue (et sa date), avec la raison. */
  async onResult(hostId: string, msg: StorageUsageMessage): Promise<void> {
    const f = this.inflight.get(hostId);
    if (f && f.requestId === msg.requestId) this.inflight.delete(hostId);
    const rows: { kind: MountKind; source: string; size: number | null; note: string | null }[] = [
      ...msg.volumes.map((v) => ({ kind: "volume" as const, source: v.name, size: v.sizeBytes, note: null })),
      ...msg.binds.map((b) => ({ kind: "bind" as const, source: b.path, size: b.sizeBytes, note: b.note ?? null })),
    ];
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO mount_sizes (host_id, kind, source, size_bytes, note, measured_at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (host_id, kind, source) DO UPDATE SET
           size_bytes = COALESCE($4::bigint, mount_sizes.size_bytes),
           note = $5::text,
           measured_at = CASE WHEN $4::bigint IS NULL THEN mount_sizes.measured_at ELSE now() END`,
        [hostId, r.kind, r.source, r.size === null ? null : Math.round(r.size), r.note],
      );
    }
    // Les montages qui n'existent plus sur l'hôte ne sont pas conservés indéfiniment.
    await this.pool.query("DELETE FROM mount_sizes WHERE host_id = $1 AND measured_at < now() - interval '30 days'", [hostId]);
  }

  /** Demande la mesure de ces montages à l'agent (réponse asynchrone). Faux si une mesure est déjà en cours pour l'hôte. */
  async request(hostId: string, containers: Container[]): Promise<boolean> {
    if (!this.transport.isOnline(hostId)) throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne.");
    if (this.isMeasuring(hostId)) return false;
    const { volumes, binds } = mountSources(containers);
    if (volumes.length === 0 && binds.length === 0) return false;
    const requestId = randomUUID();
    if (!this.transport.send(hostId, { type: "request_storage", requestId, volumes: volumes.slice(0, MAX_STORAGE_VOLUMES), binds: binds.slice(0, MAX_STORAGE_BINDS) })) {
      throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne.");
    }
    this.inflight.set(hostId, { requestId, startedAt: Date.now() });
    return true;
  }

  /** Relevé de tous les montages des hôtes en ligne dont le dernier relevé est ancien. */
  async scheduledPass(now = Date.now()): Promise<number> {
    const { rows } = await this.pool.query<{ id: string; inventory: Container[] | null; last: Date | null }>(
      `SELECT h.id, h.inventory, (SELECT max(measured_at) FROM mount_sizes m WHERE m.host_id = h.id) AS last FROM hosts h WHERE h.revoked_at IS NULL`,
    );
    let started = 0;
    for (const h of rows) {
      if (!this.transport.isOnline(h.id) || this.isMeasuring(h.id, now)) continue;
      if (h.last && now - h.last.getTime() < REFRESH_MS) continue;
      try {
        if (await this.request(h.id, h.inventory ?? [])) started++;
      } catch {
        /* hôte déconnecté entre-temps */
      }
    }
    return started;
  }
}
