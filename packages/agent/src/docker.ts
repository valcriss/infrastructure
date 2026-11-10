import type { Container, HostInfo, ImageInfo, Inventory, NetworkInfo } from "@infra/shared";
import { request } from "node:http";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

/** Requête GET en lecture seule vers l'API Docker locale (socket Unix). */
export function dockerGet(socketPath: string, path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET", timeout: timeoutMs }, (res) => {
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

export interface DockerResponse {
  status: number;
  body: unknown;
}

/**
 * Requête d'écriture vers l'API Docker (suppression, nettoyage du cache de build). Contrairement à `dockerGet`, un statut
 * d'erreur n'est pas une exception : l'appelant décide (404 = déjà supprimé, 409 = en cours d'utilisation…).
 */
export function dockerRequest(socketPath: string, method: "DELETE" | "POST", path: string, timeoutMs = 60_000): Promise<DockerResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          /* corps non JSON : conservé tel quel */
        }
        resolve({ status: res.statusCode ?? 0, body });
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
  Ports?: unknown;
  Mounts?: unknown;
  NetworkSettings?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function mapPorts(raw: unknown): NonNullable<Container["ports"]> {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<Container["ports"]> = [];
  for (const p of raw.slice(0, 50) as { IP?: unknown; PrivatePort?: unknown; PublicPort?: unknown; Type?: unknown }[]) {
    if (typeof p?.PrivatePort !== "number") continue;
    out.push({
      privatePort: Math.trunc(p.PrivatePort),
      ...(typeof p.PublicPort === "number" ? { publicPort: Math.trunc(p.PublicPort) } : {}),
      type: str(p.Type).slice(0, 10) || "tcp",
      ...(str(p.IP) ? { ip: str(p.IP).slice(0, 64) } : {}),
    });
  }
  return out;
}

function mapMounts(raw: unknown): NonNullable<Container["mounts"]> {
  if (!Array.isArray(raw)) return [];
  const out: NonNullable<Container["mounts"]> = [];
  for (const m of raw.slice(0, 50) as { Type?: unknown; Source?: unknown; Name?: unknown; Destination?: unknown; RW?: unknown }[]) {
    const destination = str(m?.Destination).slice(0, 500);
    if (!destination) continue;
    // Volume nommé : on affiche son nom ; montage « bind » : le chemin de l'hôte.
    const source = (str(m.Type) === "volume" ? str(m.Name) : str(m.Source)).slice(0, 500);
    out.push({ type: str(m.Type).slice(0, 20) || "bind", ...(source ? { source } : {}), destination, rw: m.RW !== false });
  }
  return out;
}

function mapNetworks(raw: unknown): string[] {
  const nets = (raw as { Networks?: unknown } | null)?.Networks;
  if (!nets || typeof nets !== "object") return [];
  return Object.keys(nets).slice(0, 20).map((n) => n.slice(0, 128));
}

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
    const workingDir = str(labels["com.docker.compose.project.working_dir"]).slice(0, 500);
    const configFiles = str(labels["com.docker.compose.project.config_files"]).slice(0, 1000);
    const ports = mapPorts(item.Ports);
    const mounts = mapMounts(item.Mounts);
    const networks = mapNetworks(item.NetworkSettings);
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
      ...(ports.length ? { ports } : {}),
      ...(mounts.length ? { mounts } : {}),
      ...(networks.length ? { networks } : {}),
      ...(workingDir ? { composeWorkingDir: workingDir } : {}),
      ...(configFiles ? { composeConfigFiles: configFiles } : {}),
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
  healthProbe?: NonNullable<Container["healthProbe"]>;
}

interface RawHealth {
  State?: { Health?: { Status?: unknown; Log?: unknown; FailingStreak?: unknown }; StartedAt?: unknown; ExitCode?: unknown };
  Config?: { Healthcheck?: { Test?: unknown; Retries?: unknown } };
  RestartCount?: unknown;
}

/** Dernier test du healthcheck d'après `State.Health.Log` (le plus récent est en dernier). */
function parseProbe(raw: RawHealth): InspectExtras["healthProbe"] {
  const log = raw.State?.Health?.Log;
  if (!Array.isArray(log) || log.length === 0) return undefined;
  const last = log[log.length - 1] as { ExitCode?: unknown; Output?: unknown; End?: unknown } | null;
  if (!last || typeof last !== "object") return undefined;
  const test = raw.Config?.Healthcheck?.Test;
  const command = Array.isArray(test) ? test.filter((x): x is string => typeof x === "string").join(" ").slice(0, 500) : "";
  const streak = raw.State?.Health?.FailingStreak;
  const retries = raw.Config?.Healthcheck?.Retries;
  return {
    exitCode: typeof last.ExitCode === "number" ? Math.trunc(last.ExitCode) : -1,
    output: (typeof last.Output === "string" ? last.Output : "").trim().slice(-600),
    at: typeof last.End === "string" ? last.End.slice(0, 40) : "",
    ...(command ? { command } : {}),
    ...(typeof streak === "number" && streak >= 0 ? { failingStreak: Math.trunc(streak) } : {}),
    ...(typeof retries === "number" && retries >= 0 ? { retries: Math.trunc(retries) } : {}),
  };
}

/**
 * Extrait de `GET /containers/{id}/json` les informations de supervision.
 * « none » signifie qu'aucun healthcheck n'est configuré (≠ « unhealthy »).
 */
export function parseInspect(raw: unknown): InspectExtras | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as RawHealth;
  const status = o.State?.Health?.Status;
  const health: Health = status === "healthy" || status === "unhealthy" || status === "starting" ? status : "none";
  const started = typeof o.State?.StartedAt === "string" ? o.State.StartedAt : "";
  const probe = health === "none" ? undefined : parseProbe(o);
  return {
    health,
    ...(probe ? { healthProbe: probe } : {}),
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

/** Résumé d'une image à partir de `GET /images/{id}/json`. */
export function parseImage(raw: unknown): ImageInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { Id?: unknown; RepoTags?: unknown; RepoDigests?: unknown; Size?: unknown; Os?: unknown; Architecture?: unknown; Variant?: unknown; RootFS?: { Layers?: unknown } };
  const id = str(o.Id);
  if (!id) return null;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : []);
  const opt = (v: unknown): { v: string } | Record<string, never> => (typeof v === "string" && v ? { v: v.slice(0, 40) } : {});
  const os = opt(o.Os);
  const arch = opt(o.Architecture);
  const variant = opt(o.Variant);
  return {
    id,
    repoTags: strings(o.RepoTags),
    repoDigests: strings(o.RepoDigests),
    size: typeof o.Size === "number" && o.Size >= 0 ? o.Size : 0,
    ...(Array.isArray(o.RootFS?.Layers) && o.RootFS.Layers.length > 0 ? { layers: o.RootFS.Layers.filter((l): l is string => typeof l === "string").slice(0, 300) } : {}),
    ...("v" in os ? { os: os.v } : {}),
    ...("v" in arch ? { arch: arch.v } : {}),
    ...("v" in variant ? { variant: variant.v } : {}),
  };
}

const PREDEFINED_NETWORKS = new Set(["bridge", "host", "none"]);

/**
 * Réseaux de l'hôte à partir de `GET /networks` : les réseaux prédéfinis de Docker sont écartés. La liste n'indique pas
 * les conteneurs attachés (la console les déduit de l'inventaire des conteneurs).
 */
export function parseNetworks(raw: unknown): NetworkInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: NetworkInfo[] = [];
  for (const n of raw.slice(0, 300)) {
    if (!n || typeof n !== "object") continue;
    const o = n as { Name?: unknown; Driver?: unknown; Scope?: unknown; Internal?: unknown; Labels?: unknown };
    const name = str(o.Name).slice(0, 128);
    if (!name || PREDEFINED_NETWORKS.has(name)) continue;
    const labels = o.Labels && typeof o.Labels === "object" ? (o.Labels as Record<string, unknown>) : {};
    const project = str(labels["com.docker.compose.project"]).slice(0, 128);
    out.push({ name, driver: str(o.Driver).slice(0, 40), scope: str(o.Scope).slice(0, 20), internal: o.Internal === true, ...(project ? { project } : {}) });
  }
  return out;
}

export async function collectInventory(socketPath: string): Promise<Inventory> {
  const [version, containers, info, networksRaw] = await Promise.all([
    dockerGet(socketPath, "/version"),
    dockerGet(socketPath, "/containers/json?all=1"),
    dockerGet(socketPath, "/info").catch(() => null),
    // Facultatif : un échec n'empêche pas l'inventaire (le champ reste absent).
    dockerGet(socketPath, "/networks").catch(() => null),
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
  // Images utilisées par au moins un conteneur : digests de registre, plateforme et taille.
  const imageIds = [...new Set(enriched.map((c) => c.imageId).filter(Boolean))];
  const images = (
    await mapLimit(imageIds, 8, async (id) => {
      try {
        return parseImage(await dockerGet(socketPath, `/images/${encodeURIComponent(id)}/json`));
      } catch {
        return null;
      }
    })
  ).filter((i): i is ImageInfo => i !== null);
  const hostInfo = parseInfo(info);
  return {
    observedAt: new Date().toISOString(),
    dockerVersion: dockerVersion || "inconnue",
    containers: enriched,
    ...(hostInfo ? { hostInfo } : {}),
    images,
    ...(networksRaw !== null ? { networks: parseNetworks(networksRaw) } : {}),
  };
}
