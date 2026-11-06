import { RESERVED_STACK_NAMES, listComposeServices, type Container, type SeverityCounts } from "@infra/shared";
import { deriveStackStatus, type StackHealth } from "./dashboard.js";
import type { Pool } from "./db.js";
import type { ImageWatcher } from "./image-watch.js";
import { briefOf, isScanStale, loadUsedImages, scanState, type ScanState } from "./images.js";
import type { MetricsStore } from "./metrics-store.js";
import type { ScanService } from "./scans.js";
import { getSecuritySettings, reportedCounts } from "./settings.js";

export interface ApplicationImage {
  ref: string;
  imageId: string;
  platform: string;
  scan: ScanState;
  stale: boolean;
  /** Compteurs du dernier scan réussi ; null tant qu'aucun scan n'a abouti. */
  counts: SeverityCounts | null;
}

export interface Application {
  /** « managed » : pilotée par la console (stack) ; « observed » : projet Compose qui tourne sans que la console ait son Compose. */
  kind: "managed" | "observed";
  stackId: string | null;
  name: string;
  hostId: string;
  hostName: string;
  hostPresence: "online" | "offline";
  status: StackHealth["status"];
  reason: string;
  containers: { total: number; running: number; failed: number; completed: number; unhealthy: number };
  services: string[];
  usage: { cpuPercent: number; memBytes: number } | null;
  images: ApplicationImage[];
  updatesAvailable: number;
  currentRevision: number | null;
  deployedRevision: number | null;
  pendingDeploy: boolean;
  lastDeployAt: string | null;
  importable: boolean;
}

interface Deps {
  pool: Pool;
  metrics: MetricsStore;
  scans: ScanService;
  watcher: ImageWatcher;
  isOnline: (hostId: string) => boolean;
}

const isFailed = (c: Container): boolean => c.state === "dead" || c.state === "restarting" || (c.state === "exited" && c.exitCode !== undefined && c.exitCode !== 0);
const isCompleted = (c: Container): boolean => c.state === "exited" && c.exitCode === 0;

/** Statut d'un projet Compose observé (sans Compose connu : pas de service attendu ni de révision). */
function observedStatus(online: boolean, observedAt: Date | null, containers: Container[], now: number): { status: StackHealth["status"]; reason: string } {
  if (!online || !observedAt || now - observedAt.getTime() > 3 * 60_000) {
    return { status: "unknown", reason: "Hôte hors ligne ou observation périmée : l'état réel n'est pas connu." };
  }
  const active = containers.filter((c) => !isCompleted(c));
  if (active.length === 0) return { status: "stopped", reason: "Aucun conteneur actif (tâches terminées)." };
  const running = active.filter((c) => c.state === "running").length;
  if (running === 0) return { status: "stopped", reason: "Aucun conteneur en marche." };
  if (running < active.length || active.some((c) => c.health === "unhealthy")) return { status: "degraded", reason: "Au moins un conteneur est arrêté ou en échec de healthcheck." };
  return { status: "running", reason: `${running} conteneur(s) en marche.` };
}

/**
 * Applications : stacks gérées et projets Compose observés sur les hôtes, avec état, utilisation,
 * vulnérabilités des images et mises à jour. Même logique que le tableau de bord, par application.
 */
export async function listApplications(deps: Deps, now = Date.now()): Promise<Application[]> {
  const { pool } = deps;
  const [hostRows, stackRows, deploys, usedImages, scanMap, checks, settings] = await Promise.all([
    pool.query<{ id: string; name: string; inventory: Container[] | null; inventory_observed_at: Date | null }>(
      "SELECT id, name, inventory, inventory_observed_at FROM hosts WHERE revoked_at IS NULL ORDER BY created_at",
    ),
    pool.query<{ id: string; name: string; host_id: string; current_revision: number; deployed_revision: number | null; compose: string | null }>(
      `SELECT s.id, s.name, s.host_id, s.current_revision, s.deployed_revision, r.compose
         FROM stacks s LEFT JOIN stack_revisions r ON r.stack_id = s.id AND r.revision = s.deployed_revision ORDER BY s.name`,
    ),
    pool.query<{ stack_id: string; finished_at: Date }>(
      `SELECT DISTINCT ON (stack_id) stack_id, finished_at FROM operations
        WHERE type = 'deploy' AND status = 'succeeded' AND finished_at IS NOT NULL ORDER BY stack_id, finished_at DESC`,
    ),
    loadUsedImages(pool),
    deps.scans.latestAll(),
    deps.watcher.allChecks(),
    getSecuritySettings(pool),
  ]);

  // Dernier échantillon de chaque conteneur, par hôte en ligne (les autres sont périmés).
  const usage = new Map<string, Map<string, { cpu: number; mem: number }>>();
  await Promise.all(
    hostRows.rows
      .filter((h) => deps.isOnline(h.id))
      .map(async (h) => {
        const byProject = new Map<string, { cpu: number; mem: number }>();
        for (const s of await deps.metrics.latest(h.id)) {
          if (!s.project) continue;
          const u = byProject.get(s.project) ?? { cpu: 0, mem: 0 };
          u.cpu += s.cpuPercent ?? 0;
          u.mem += s.memBytes;
          byProject.set(s.project, u);
        }
        usage.set(h.id, byProject);
      }),
  );

  // Image (identifiant + plateforme) de chaque conteneur.
  const imageOf = new Map<string, (typeof usedImages)[number]>();
  for (const img of usedImages) for (const u of img.usedBy) imageOf.set(`${u.hostId}|${u.containerId}`, img);

  const deployedAt = new Map(deploys.rows.map((d) => [d.stack_id, d.finished_at]));
  const stackByKey = new Map(stackRows.rows.map((s) => [`${s.host_id}|${s.name}`, s]));
  const updates = new Map<string, number>();
  for (const c of checks) if (c.kind === "update_available") updates.set(c.stackId, (updates.get(c.stackId) ?? 0) + 1);

  const imagesOf = (hostId: string, containers: Container[]): ApplicationImage[] => {
    const seen = new Map<string, ApplicationImage>();
    for (const c of containers) {
      const img = imageOf.get(`${hostId}|${c.id}`);
      const key = img ? `${img.imageId}|${img.platform}` : c.imageId;
      if (seen.has(key)) continue;
      const entry = img ? scanMap.get(key) : undefined;
      seen.set(key, {
        // Une image sans nom (étiquette déplacée par une reconstruction) est désignée par son identifiant court.
        imageId: img?.imageId ?? c.imageId,
        platform: img?.platform ?? "",
        ref: img?.refs[0] ?? (c.image.startsWith("sha256:") ? `image locale ${c.image.slice(7, 19)}` : c.image),
        scan: scanState(entry ? briefOf(entry.attempt, settings) : null),
        stale: isScanStale(entry?.ok ?? null, settings.scanIntervalHours, now),
        counts: reportedCounts(entry?.ok?.counts ?? null, settings)?.counts ?? null,
      });
    }
    return [...seen.values()];
  };

  const counts = (containers: Container[]): Application["containers"] => ({
    total: containers.length,
    running: containers.filter((c) => c.state === "running").length,
    failed: containers.filter(isFailed).length,
    completed: containers.filter(isCompleted).length,
    unhealthy: containers.filter((c) => c.state === "running" && c.health === "unhealthy").length,
  });

  const out: Application[] = [];
  for (const h of hostRows.rows) {
    const online = deps.isOnline(h.id);
    const projects = new Map<string, Container[]>();
    for (const c of h.inventory ?? []) if (c.composeProject) projects.set(c.composeProject, [...(projects.get(c.composeProject) ?? []), c]);

    // Stacks gérées de cet hôte (même sans conteneur : « jamais déployée », arrêtée…).
    for (const s of stackRows.rows.filter((x) => x.host_id === h.id)) {
      const containers = projects.get(s.name) ?? [];
      projects.delete(s.name);
      const health = deriveStackStatus({
        deployedRevision: s.deployed_revision,
        hostOnline: online,
        inventoryObservedAt: h.inventory_observed_at,
        now,
        containers,
        expectedServices: s.compose ? listComposeServices(s.compose) : [],
      });
      const u = usage.get(h.id)?.get(s.name);
      out.push({
        kind: "managed",
        stackId: s.id,
        name: s.name,
        hostId: h.id,
        hostName: h.name,
        hostPresence: online ? "online" : "offline",
        status: health.status,
        reason: health.reason,
        containers: counts(containers),
        services: [...new Set(containers.map((c) => c.composeService).filter((x): x is string => Boolean(x)))].sort(),
        usage: u ? { cpuPercent: Math.round(u.cpu * 100) / 100, memBytes: u.mem } : null,
        images: imagesOf(h.id, containers),
        updatesAvailable: updates.get(s.id) ?? 0,
        currentRevision: s.current_revision,
        deployedRevision: s.deployed_revision,
        pendingDeploy: s.deployed_revision !== s.current_revision,
        lastDeployAt: deployedAt.get(s.id)?.toISOString() ?? null,
        importable: false,
      });
    }

    // Projets Compose qui tournent sans stack correspondante.
    for (const [name, containers] of projects) {
      if (stackByKey.has(`${h.id}|${name}`)) continue;
      const st = observedStatus(online, h.inventory_observed_at, containers, now);
      const u = usage.get(h.id)?.get(name);
      out.push({
        kind: "observed",
        stackId: null,
        name,
        hostId: h.id,
        hostName: h.name,
        hostPresence: online ? "online" : "offline",
        status: st.status,
        reason: st.reason,
        containers: counts(containers),
        services: [...new Set(containers.map((c) => c.composeService).filter((x): x is string => Boolean(x)))].sort(),
        usage: u ? { cpuPercent: Math.round(u.cpu * 100) / 100, memBytes: u.mem } : null,
        images: imagesOf(h.id, containers),
        updatesAvailable: 0,
        currentRevision: null,
        deployedRevision: null,
        pendingDeploy: false,
        lastDeployAt: null,
        importable: !RESERVED_STACK_NAMES.includes(name),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
