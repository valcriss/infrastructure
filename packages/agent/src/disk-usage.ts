import { MAX_BUILD_CACHE_CANDIDATES, type DiskCandidates, type DiskUsageMessage } from "@infra/shared";
import { dockerGet } from "./docker.js";
import type { RetainedBuildCache } from "./retained-cache.js";

/** Volume de cache de Trivy : jamais proposé au nettoyage. */
export const TRIVY_CACHE_VOLUME_NAME = "console-docker-trivy-cache";

const MAX_CANDIDATES = 300;
const PREDEFINED_NETWORKS = new Set(["bridge", "host", "none"]);

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface ParsedDf {
  images: Raw[];
  containers: Raw[];
  volumes: Raw[];
  buildCache: Raw[];
  /** Totaux calculés par Docker (versions récentes) : plus fiables que notre propre somme, notamment pour les couches partagées. */
  daemon: Partial<Record<"images" | "containers" | "volumes" | "buildCache", { count: number; size: number; reclaimable: number }>>;
}

/**
 * `GET /system/df` : Docker 29 renvoie à la fois les anciennes listes (Images, Containers, Volumes, BuildCache)
 * et de nouveaux objets `*Usage` (éléments + totaux). On accepte les deux formes.
 */
export function parseDf(raw: unknown): ParsedDf {
  const d = obj(raw);
  const pick = (classic: string, usage: string): { items: Raw[]; totals?: { count: number; size: number; reclaimable: number } } => {
    const u = obj(d[usage]);
    const items = Array.isArray(d[classic]) ? arr(d[classic]) : arr(u.Items);
    const totals = typeof u.TotalCount === "number" ? { count: num(u.TotalCount), size: num(u.TotalSize), reclaimable: num(u.Reclaimable) } : undefined;
    return { items, ...(totals ? { totals } : {}) };
  };
  const images = pick("Images", "ImageUsage");
  const containers = pick("Containers", "ContainerUsage");
  const volumes = pick("Volumes", "VolumeUsage");
  const build = pick("BuildCache", "BuildCacheUsage");
  return {
    images: images.items,
    containers: containers.items,
    volumes: volumes.items,
    buildCache: build.items,
    daemon: {
      ...(images.totals ? { images: images.totals } : {}),
      ...(containers.totals ? { containers: containers.totals } : {}),
      ...(volumes.totals ? { volumes: volumes.totals } : {}),
      ...(build.totals ? { buildCache: build.totals } : {}),
    },
  };
}

export interface NetworkInfo {
  id: string;
  name: string;
  created: string | null;
  project: string;
  inUse: boolean;
}

export interface BuildCacheCriteria {
  mode: "all" | "older";
  olderThanHours?: number;
}

/** Entrées du cache de build qui remplissent les critères d'un nettoyage (inutilisées, et assez anciennes selon leur date effective). */
export function matchingBuildCache(df: ParsedDf, criteria: BuildCacheCriteria, nowMs: number): { id: string; sizeBytes: number }[] {
  const effective = effectiveBuildCache(df.buildCache);
  const cutoff = criteria.mode === "older" && criteria.olderThanHours ? nowMs - criteria.olderThanHours * 3_600_000 : null;
  const out: { id: string; sizeBytes: number }[] = [];
  for (const b of df.buildCache) {
    const e = effective.get(str(b.ID));
    if (!e || e.inUse) continue;
    if (cutoff !== null && (e.lastUsedMs === null || e.lastUsedMs > cutoff)) continue;
    out.push({ id: str(b.ID), sizeBytes: Math.max(0, num(b.Size)) });
  }
  return out;
}

export interface BuildOptions {
  /** Entrées du cache de build que Docker a refusé de supprimer lors d'un nettoyage précédent : plus proposées. */
  retainedBuildCacheIds?: Set<string>;
  /** Projets Compose protégés (console et agent) : leurs conteneurs, réseaux et volumes ne sont jamais proposés. */
  protectedProjects: Set<string>;
  /** Références d'image jamais proposées (image de Trivy). */
  protectedImageRefs: string[];
  now?: number;
}

const labelOf = (item: Raw, key: string): string => str(obj(item.Labels)[key]);
const project = (item: Raw): string => labelOf(item, "com.docker.compose.project");

/** Entrées parentes d'un enregistrement du cache de build (Docker écrit la clé « " Parents" », avec une espace, dans certaines versions). */
const parentsOf = (b: Raw): string[] => {
  const list = [b.Parents, b[" Parents"], b.Parent].flatMap((p) => (Array.isArray(p) ? p : typeof p === "string" && p ? [p] : []));
  return list.filter((p): p is string => typeof p === "string");
};

/**
 * Pour chaque entrée du cache de build : date de dernière utilisation EFFECTIVE (la plus récente parmi elle et tous ses
 * descendants) et utilisation EFFECTIVE (en cours si elle ou un descendant l'est). BuildKit conserve en effet les parents
 * d'une entrée qu'il garde : une entrée ancienne dont un dérivé est récent ou utilisé n'est pas supprimée, même avec
 * « plus de 7 jours ». Sans ce calcul, l'aperçu proposerait indéfiniment des entrées que Docker refuse de supprimer.
 */
export function effectiveBuildCache(records: Raw[]): Map<string, { lastUsedMs: number | null; inUse: boolean }> {
  const byId = new Map<string, Raw>();
  const children = new Map<string, string[]>();
  for (const r of records) {
    const id = str(r.ID);
    if (!id) continue;
    byId.set(id, r);
    for (const p of parentsOf(r)) children.set(p, [...(children.get(p) ?? []), id]);
  }
  const memo = new Map<string, { lastUsedMs: number | null; inUse: boolean }>();
  const visiting = new Set<string>();
  const visit = (id: string): { lastUsedMs: number | null; inUse: boolean } => {
    const known = memo.get(id);
    if (known) return known;
    const r = byId.get(id);
    const own = r ? Date.parse(str(r.LastUsedAt)) : Number.NaN;
    let lastUsedMs: number | null = Number.isFinite(own) ? own : null;
    let inUse = r?.InUse === true;
    if (!visiting.has(id)) {
      visiting.add(id);
      for (const c of children.get(id) ?? []) {
        const k = visit(c);
        if (k.lastUsedMs !== null && (lastUsedMs === null || k.lastUsedMs > lastUsedMs)) lastUsedMs = k.lastUsedMs;
        inUse ||= k.inUse;
      }
      visiting.delete(id);
    }
    const out = { lastUsedMs, inUse };
    memo.set(id, out);
    return out;
  };
  for (const id of byId.keys()) visit(id);
  return memo;
}

/** Calcule résumé et candidats au nettoyage à partir des réponses de Docker (fonction pure, testée). */
export function buildDiskUsage(df: ParsedDf, networks: NetworkInfo[], opts: BuildOptions): DiskUsageMessage {
  const bySize = <T extends { sizeBytes: number | null }>(list: T[]): T[] => [...list].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  let truncated = false;
  const capBuild = <T,>(list: T[]): T[] => {
    if (list.length > MAX_BUILD_CACHE_CANDIDATES) truncated = true;
    return list.slice(0, MAX_BUILD_CACHE_CANDIDATES);
  };
  const cap = <T,>(list: T[]): T[] => {
    if (list.length > MAX_CANDIDATES) truncated = true;
    return list.slice(0, MAX_CANDIDATES);
  };

  // Conteneurs arrêtés (ni en marche, ni en pause, ni en cours de redémarrage).
  const stoppedContainers = df.containers.filter((c) => ["exited", "created", "dead"].includes(str(c.State)));
  const containers = stoppedContainers
    .filter((c) => !opts.protectedProjects.has(project(c)))
    .map((c) => ({
      id: str(c.Id),
      name: str(arr(c.Names)[0] ?? c.Names).replace(/^\//, "") || str(c.Id).slice(0, 12),
      image: str(c.Image),
      ...(project(c) ? { project: project(c) } : {}),
      ...(labelOf(c, "com.docker.compose.service") ? { service: labelOf(c, "com.docker.compose.service") } : {}),
      state: str(c.State),
      created: Math.trunc(num(c.Created)),
      sizeBytes: typeof c.SizeRw === "number" && c.SizeRw >= 0 ? c.SizeRw : null,
    }));

  // Images inutilisées (aucun conteneur, arrêté ou non).
  const unusedImages = df.images.filter((i) => i.Containers === 0);
  const images = unusedImages
    .filter((i) => !arr(i.RepoTags).length || !(i.RepoTags as string[]).some((t) => opts.protectedImageRefs.includes(t)))
    .map((i) => {
      const tags = (Array.isArray(i.RepoTags) ? (i.RepoTags as string[]) : []).filter((t) => t && t !== "<none>:<none>");
      return { id: str(i.Id), ref: tags[0] ?? str(i.Id).replace("sha256:", "").slice(0, 12), created: Math.trunc(num(i.Created)), sizeBytes: Math.max(0, num(i.Size)), dangling: tags.length === 0 };
    });

  // Récupérable « comme docker system df » : tout volume inutilisé ; les candidats, eux, excluent le protégé.
  const unusedVolumes = df.volumes.filter((v) => num(obj(v.UsageData).RefCount) === 0);
  const volumes = unusedVolumes
    .filter((v) => str(v.Name) !== TRIVY_CACHE_VOLUME_NAME && !opts.protectedProjects.has(project(v)))
    .map((v) => {
      const size = num(obj(v.UsageData).Size);
      const name = str(v.Name);
      const anonymous = "com.docker.volume.anonymous" in obj(v.Labels) || (/^[0-9a-f]{64}$/.test(name) && !project(v));
      return { name, sizeBytes: size >= 0 ? size : null, anonymous, created: str(v.CreatedAt) || null, ...(project(v) ? { project: project(v) } : {}) };
    });

  const unusedNetworks = networks.filter((n) => !n.inUse && !PREDEFINED_NETWORKS.has(n.name) && !opts.protectedProjects.has(n.project));

  const effective = effectiveBuildCache(df.buildCache);
  // Inutilisées : ni elles ni aucun de leurs dérivés ne sont en cours d'utilisation.
  const retained = opts.retainedBuildCacheIds ?? new Set<string>();
  const idle = df.buildCache.filter((b) => effective.get(str(b.ID))?.inUse !== true && !retained.has(str(b.ID)));
  const buildCache = idle.map((b) => {
    const at = effective.get(str(b.ID))?.lastUsedMs ?? null;
    return { id: str(b.ID), type: str(b.Type), ...(str(b.Description) ? { description: str(b.Description).slice(0, 120) } : {}), sizeBytes: Math.max(0, num(b.Size)), lastUsedAt: at === null ? null : new Date(at).toISOString() };
  });

  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const summary = {
    images: {
      count: df.daemon.images?.count ?? df.images.length,
      sizeBytes: df.daemon.images?.size ?? sum(df.images.map((i) => num(i.Size))),
      reclaimableBytes: df.daemon.images?.reclaimable ?? sum(unusedImages.map((i) => num(i.Size))),
    },
    containers: {
      count: df.daemon.containers?.count ?? df.containers.length,
      sizeBytes: df.daemon.containers?.size ?? sum(df.containers.map((c) => Math.max(0, num(c.SizeRw)))),
      reclaimableBytes: df.daemon.containers?.reclaimable ?? sum(stoppedContainers.map((c) => Math.max(0, num(c.SizeRw)))),
    },
    volumes: {
      count: df.daemon.volumes?.count ?? df.volumes.length,
      sizeBytes: df.daemon.volumes?.size ?? sum(df.volumes.map((v) => Math.max(0, num(obj(v.UsageData).Size)))),
      reclaimableBytes: df.daemon.volumes?.reclaimable ?? sum(unusedVolumes.map((v) => Math.max(0, num(obj(v.UsageData).Size)))),
    },
    buildCache: {
      count: df.daemon.buildCache?.count ?? df.buildCache.length,
      sizeBytes: df.daemon.buildCache?.size ?? sum(df.buildCache.map((b) => num(b.Size))),
      // Total de Docker moins ce qu'il a déjà refusé de supprimer (retenu par des dépendances).
      reclaimableBytes: df.daemon.buildCache
        ? Math.max(0, df.daemon.buildCache.reclaimable - sum(df.buildCache.filter((b) => retained.has(str(b.ID))).map((b) => num(b.Size))))
        : sum(idle.map((b) => num(b.Size))),
    },
  };

  const candidates: DiskCandidates = {
    containers: cap(bySize(containers)),
    images: cap(bySize(images)),
    networks: cap(unusedNetworks.map((n) => ({ id: n.id, name: n.name, created: n.created }))),
    volumes: cap(bySize(volumes)),
    buildCache: capBuild(bySize(buildCache)),
  };
  return { type: "disk_usage", observedAt: new Date(opts.now ?? Date.now()).toISOString(), summary, candidates, truncated };
}

/** Réseaux locaux avec leurs conteneurs (une inspection par réseau : Docker ne l'indique pas dans la liste). */
async function listNetworks(socket: string): Promise<NetworkInfo[]> {
  const list = arr(await dockerGet(socket, "/networks")).slice(0, 200);
  const out: NetworkInfo[] = [];
  for (const n of list) {
    const id = str(n.Id);
    const name = str(n.Name);
    if (!id || PREDEFINED_NETWORKS.has(name) || str(n.Scope) !== "local") continue;
    try {
      const info = obj(await dockerGet(socket, `/networks/${encodeURIComponent(id)}`));
      out.push({ id, name, created: str(info.Created) || null, project: str(obj(info.Labels)["com.docker.compose.project"]), inUse: Object.keys(obj(info.Containers)).length > 0 });
    } catch {
      /* réseau disparu entre-temps */
    }
  }
  return out;
}

export interface CollectDeps {
  socket: string;
  /** Parmi ces projets, lesquels sont protégés ? (console, agent, PROTECTED_PROJECTS) */
  protectedAmong: (projects: string[]) => Promise<Set<string>>;
  protectedImageRefs: string[];
  /** Mémoire des entrées de cache de build que Docker refuse de supprimer. */
  retained?: RetainedBuildCache;
}

/** Équivalent de `docker system df` avec les candidats au nettoyage. */
export async function collectDiskUsage(deps: CollectDeps): Promise<DiskUsageMessage> {
  const df = parseDf(await dockerGet(deps.socket, "/system/df", 120_000));
  const networks = await listNetworks(deps.socket);
  const projects = new Set<string>();
  for (const x of [...df.containers, ...df.volumes]) if (project(x)) projects.add(project(x));
  for (const n of networks) if (n.project) projects.add(n.project);
  const retained = deps.retained ? await deps.retained.load() : undefined;
  await deps.retained?.forgetMissing(new Set(df.buildCache.map((b) => str(b.ID))));
  return buildDiskUsage(df, networks, { protectedProjects: await deps.protectedAmong([...projects]), protectedImageRefs: deps.protectedImageRefs, ...(retained ? { retainedBuildCacheIds: retained } : {}) });
}
