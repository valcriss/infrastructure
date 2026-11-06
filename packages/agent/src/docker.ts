import type { Container, HostInfo, Inventory } from "@infra/shared";
import { request } from "node:http";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/** Requête GET en lecture seule vers l'API Docker locale (socket Unix). */
export function dockerGet(socketPath: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET", timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error("réponse Docker trop volumineuse"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Docker a répondu ${res.statusCode} pour ${path}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(err);
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("délai Docker dépassé")));
    req.on("error", reject);
    req.end();
  });
}

interface RawContainer {
  Id?: unknown;
  Names?: unknown;
  Image?: unknown;
  ImageID?: unknown;
  State?: unknown;
  Status?: unknown;
  Created?: unknown;
  Labels?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Transforme la réponse `GET /containers/json` en conteneurs du protocole. */
export function mapContainers(raw: unknown): Container[] {
  if (!Array.isArray(raw)) return [];
  const out: Container[] = [];
  for (const item of raw as RawContainer[]) {
    const id = str(item.Id);
    if (!id) continue;
    const labels =
      item.Labels && typeof item.Labels === "object" ? (item.Labels as Record<string, unknown>) : {};
    const project = str(labels["com.docker.compose.project"]);
    const service = str(labels["com.docker.compose.service"]);
    out.push({
      id,
      names: Array.isArray(item.Names)
        ? item.Names.filter((n): n is string => typeof n === "string").map((n) => n.replace(/^\//, ""))
        : [],
      image: str(item.Image),
      imageId: str(item.ImageID),
      state: str(item.State),
      status: str(item.Status),
      created: typeof item.Created === "number" ? Math.trunc(item.Created) : 0,
      ...(project ? { composeProject: project } : {}),
      ...(service ? { composeService: service } : {}),
    });
  }
  return out;
}

type Health = NonNullable<Container["health"]>;

export interface InspectExtras {
  health: Health;
  restartCount: number;
  startedAt: string;
  exitCode: number;
}

/**
 * Extrait de `GET /containers/{id}/json` les informations de supervision.
 * « none » signifie qu'aucun healthcheck n'est configuré (≠ « unhealthy »).
 */
export function parseInspect(raw: unknown): InspectExtras | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { RestartCount?: unknown; State?: { Health?: { Status?: unknown }; StartedAt?: unknown; ExitCode?: unknown } };
  const status = o.State?.Health?.Status;
  const health: Health = status === "healthy" || status === "unhealthy" || status === "starting" ? status : "none";
  const started = typeof o.State?.StartedAt === "string" ? o.State.StartedAt : "";
  return {
    health,
    restartCount: typeof o.RestartCount === "number" && o.RestartCount >= 0 ? Math.trunc(o.RestartCount) : 0,
    // Docker renvoie « 0001-01-01T00:00:00Z » pour un conteneur jamais démarré.
    startedAt: started.startsWith("0001-") ? "" : started.slice(0, 40),
    exitCode: typeof o.State?.ExitCode === "number" ? Math.trunc(o.State.ExitCode) : 0,
  };
}

/** Résumé de `GET /info`. */
export function parseInfo(raw: unknown): HostInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    cpus: Math.trunc(num(o.NCPU)),
    memTotalBytes: num(o.MemTotal),
    os: str(o.OperatingSystem).slice(0, 200),
    serverVersion: str(o.ServerVersion).slice(0, 64),
    containersRunning: Math.trunc(num(o.ContainersRunning)),
    containersPaused: Math.trunc(num(o.ContainersPaused)),
    containersStopped: Math.trunc(num(o.ContainersStopped)),
    images: Math.trunc(num(o.Images)),
  };
}

/** Exécute `fn` sur chaque élément avec au plus `limit` appels simultanés. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export async function collectInventory(socketPath: string): Promise<Inventory> {
  const [version, containers, info] = await Promise.all([
    dockerGet(socketPath, "/version"),
    dockerGet(socketPath, "/containers/json?all=1"),
    dockerGet(socketPath, "/info").catch(() => null),
  ]);
  const dockerVersion =
    version && typeof version === "object" ? str((version as { Version?: unknown }).Version) : "";
  const mapped = mapContainers(containers);
  // Santé, redémarrages, dernier démarrage : un appel par conteneur (limité).
  // Un échec d'inspection n'empêche pas l'inventaire : les champs restent absents.
  const enriched = await mapLimit(mapped, 8, async (c) => {
    try {
      const extras = parseInspect(await dockerGet(socketPath, `/containers/${encodeURIComponent(c.id)}/json`));
      return extras ? { ...c, ...extras } : c;
    } catch {
      return c;
    }
  });
  const hostInfo = parseInfo(info);
  return {
    observedAt: new Date().toISOString(),
    dockerVersion: dockerVersion || "inconnue",
    containers: enriched,
    ...(hostInfo ? { hostInfo } : {}),
  };
}
