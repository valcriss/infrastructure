import type { Container, ImageInfo, SeverityCounts } from "@infra/shared";
import type { Pool } from "./db.js";
import { parseImageRef, platformOf } from "./image-ref.js";
import { reportedCounts, type SecuritySettings } from "./settings.js";

export interface ImageUser {
  hostId: string;
  hostName: string;
  stackId: string | null;
  stackName: string | null;
  service: string | null;
  /** Projet Compose du conteneur (géré ou observé). */
  project: string | null;
  container: string;
  containerId: string;
  state: string;
  /** Référence telle qu'utilisée par le conteneur (ou, à défaut, un tag connu de l'image). */
  ref: string;
}

export interface UsedImage {
  imageId: string;
  platform: string;
  refs: string[];
  info: ImageInfo | null;
  usedBy: ImageUser[];
}

interface HostRow {
  id: string;
  name: string;
  inventory: Container[] | null;
  images: ImageInfo[] | null;
}

export interface ImageFilter {
  hostId?: string;
  stackId?: string;
  /** Projet Compose (géré ou observé) : à combiner avec hostId. */
  project?: string;
  /** Service Compose (avec un projet ou une stack). */
  service?: string;
  /** Projets Compose à ignorer (les éléments de la console elle-même, quand ils sont masqués dans les vues). */
  excludeProjects?: string[];
}

/**
 * Images utilisées par les conteneurs des hôtes, regroupées par contenu
 * (identifiant + plateforme) : une même image sur deux hôtes n'apparaît
 * qu'une fois, avec tous ses utilisateurs (stacks, services, conteneurs).
 */
export async function loadUsedImages(pool: Pick<Pool, "query">, filter: ImageFilter = {}): Promise<UsedImage[]> {
  const [hosts, stacks] = await Promise.all([
    pool.query<HostRow>("SELECT id, name, inventory, images FROM hosts WHERE revoked_at IS NULL ORDER BY created_at"),
    pool.query<{ id: string; name: string; host_id: string }>("SELECT id, name, host_id FROM stacks"),
  ]);
  const stackOf = new Map(stacks.rows.map((s) => [`${s.host_id}:${s.name}`, s]));
  const filterStack = filter.stackId ? stacks.rows.find((s) => s.id === filter.stackId) : undefined;

  const byKey = new Map<string, UsedImage>();
  for (const h of hosts.rows) {
    if (filter.hostId && h.id !== filter.hostId) continue;
    const infoById = new Map((h.images ?? []).map((i) => [i.id, i]));
    for (const c of h.inventory ?? []) {
      if (!c.imageId) continue;
      if (c.composeProject && filter.excludeProjects?.includes(c.composeProject)) continue;
      if (filter.project && c.composeProject !== filter.project) continue;
      if (filter.service && c.composeService !== filter.service) continue;
      const stack = c.composeProject ? stackOf.get(`${h.id}:${c.composeProject}`) : undefined;
      if (filter.stackId && (!filterStack || stack?.id !== filterStack.id)) continue;
      const info = infoById.get(c.imageId) ?? null;
      const platform = info ? platformOf(info) : "";
      const key = `${c.imageId}|${platform}`;
      const entry = byKey.get(key) ?? { imageId: c.imageId, platform, refs: [], info, usedBy: [] };
      byKey.set(key, entry);
      const ref = c.image && !c.image.startsWith("sha256:") ? c.image : (info?.repoTags[0] ?? c.image);
      for (const r of [ref, ...(info?.repoTags ?? [])]) if (r && !r.startsWith("sha256:") && !entry.refs.includes(r)) entry.refs.push(r);
      entry.usedBy.push({
        hostId: h.id,
        hostName: h.name,
        stackId: stack?.id ?? null,
        stackName: stack?.name ?? null,
        service: c.composeService ?? null,
        project: c.composeProject ?? null,
        container: c.names[0] ?? c.id.slice(0, 12),
        containerId: c.id,
        state: c.state,
        ref,
      });
      if (!entry.info && info) entry.info = info;
    }
  }
  return [...byKey.values()].sort((a, b) => (a.refs[0] ?? a.imageId).localeCompare(b.refs[0] ?? b.imageId));
}

/**
 * Image de l'hôte portant cette référence (même registre, dépôt et étiquette), ou null : sert à retrouver l'image de
 * base d'un service construit, téléchargée lors de la construction.
 */
export async function findLocalImage(pool: Pick<Pool, "query">, hostId: string, ref: string): Promise<ImageInfo | null> {
  const wanted = parseImageRef(ref);
  if (!wanted) return null;
  const { rows } = await pool.query<{ images: ImageInfo[] | null }>("SELECT images FROM hosts WHERE id = $1", [hostId]);
  for (const img of rows[0]?.images ?? []) {
    for (const tag of img.repoTags) {
      const p = parseImageRef(tag);
      if (p && p.registry === wanted.registry && p.repository === wanted.repository && p.tag === wanted.tag) return img;
    }
  }
  return null;
}

// --- État d'un scan -----------------------------------------------------------------------

export type ScanState = "never" | "pending" | "running" | "failed" | "clean" | "vulnerable";

export interface ScanBrief {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  finishedAt: Date | null;
  total: number | null;
}

/**
 * Trois situations distinctes, jamais confondues : « aucune vulnérabilité
 * connue » (scan réussi, 0 résultat), « jamais scanné » et « scan en échec ».
 */
/** Résumé d'un scan pour `scanState` : le total ne compte que les gravités signalées par les réglages. */
export function briefOf(
  scan: { id: string; status: ScanBrief["status"]; finishedAt: Date | null; counts: SeverityCounts | null; total: number | null },
  settings: Pick<SecuritySettings, "minSeverity" | "includeUnknown">,
): ScanBrief {
  const reported = reportedCounts(scan.counts, settings);
  return { id: scan.id, status: scan.status, finishedAt: scan.finishedAt, total: reported ? reported.total : scan.total };
}

export function scanState(scan: ScanBrief | null): ScanState {
  if (!scan) return "never";
  if (scan.status === "pending") return "pending";
  if (scan.status === "running") return "running";
  if (scan.status === "failed") return "failed";
  return (scan.total ?? 0) === 0 ? "clean" : "vulnerable";
}

/** Un résultat plus ancien que deux périodes de scan n'est plus représentatif de la base de vulnérabilités. */
export function isScanStale(scan: Pick<ScanBrief, "finishedAt" | "status"> | null, intervalHours: number, now = Date.now()): boolean {
  if (!scan || scan.status !== "succeeded" || !scan.finishedAt || intervalHours === 0) return false;
  return now - scan.finishedAt.getTime() > intervalHours * 2 * 3600_000;
}
