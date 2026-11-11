import { INVENTORY_INTERVAL_SEC, listComposeServices, type ComposeService, type Container, type HostInfo } from "@infra/shared";
import type { SeverityCounts } from "@infra/shared";
import type { BackupService, BackupStatus } from "./backup.js";
import { currentChecks, type CheckDetail, type ImageWatcher } from "./image-watch.js";
import { currentObservedChecks, type ObservedWatcher } from "./observed-watch.js";
import { hiddenProjects } from "./display.js";
import { briefOf, isScanStale, loadUsedImages, scanState, type ScanState } from "./images.js";
import type { ScanService } from "./scans.js";
import { getSecuritySettings, reportedCounts } from "./settings.js";
import type { Pool } from "./db.js";
import type { LatestSample, MetricsStore } from "./metrics-store.js";

/** Au-delà de ce délai sans inventaire, l'état observé n'est plus fiable. */
export const STALE_AFTER_SEC = INVENTORY_INTERVAL_SEC * 3;

export type StackStatus = "running" | "degraded" | "stopped" | "unknown" | "not_deployed";

export interface StackHealth {
  status: StackStatus;
  /** Explication lisible de l'état (jamais un simple code). */
  reason: string;
  /** Dernière observation de l'inventaire (conservée même si l'hôte est hors ligne). */
  observedAt: string | null;
  containers: { total: number; running: number; unhealthy: number; restarting: number; noHealthcheck: number };
  missingServices: string[];
}

export interface StackStatusInput {
  deployedRevision: number | null;
  hostOnline: boolean;
  inventoryObservedAt: Date | null;
  now: number;
  /** Conteneurs du projet Compose de la stack, d'après le dernier inventaire. */
  containers: Container[];
  /** Services du Compose déployé (vide si inconnus). */
  expectedServices: ComposeService[];
}

const count = (containers: Container[]): StackHealth["containers"] => ({
  total: containers.length,
  running: containers.filter((c) => c.state === "running").length,
  unhealthy: containers.filter((c) => c.state === "running" && c.health === "unhealthy").length,
  restarting: containers.filter((c) => c.state === "restarting").length,
  noHealthcheck: containers.filter((c) => c.state === "running" && c.health === "none").length,
});

/**
 * Déduit l'état d'une stack en distinguant ce qui est SU de ce qui est INCONNU :
 * un hôte hors ligne ou une observation périmée donnent « inconnu », jamais
 * « arrêtée » (cf. project.md §6).
 */
export function deriveStackStatus(input: StackStatusInput): StackHealth {
  const observedAt = input.inventoryObservedAt?.toISOString() ?? null;
  const counts = count(input.containers);
  const base = { observedAt, containers: counts, missingServices: [] as string[] };

  if (input.deployedRevision === null) {
    return { ...base, status: "not_deployed", reason: "Jamais déployée par la console." };
  }
  if (!input.hostOnline) {
    return { ...base, status: "unknown", reason: "Agent hors ligne : état inconnu, dernière observation conservée." };
  }
  if (!input.inventoryObservedAt) {
    return { ...base, status: "unknown", reason: "Aucune observation de l'hôte pour le moment." };
  }
  if (input.now - input.inventoryObservedAt.getTime() > STALE_AFTER_SEC * 1000) {
    return { ...base, status: "unknown", reason: "Observation périmée : l'hôte n'a pas remonté d'inventaire récemment." };
  }
  if (counts.total === 0) {
    return { ...base, status: "stopped", reason: "Aucun conteneur observé pour ce projet." };
  }
  if (counts.running === 0) {
    return { ...base, status: "stopped", reason: "Aucun conteneur en marche." };
  }

  const problems: string[] = [];
  // Un conteneur terminé avec le code 0 est considéré comme une tâche achevée (migration, init…).
  const crashed = input.containers.filter((c) => c.state !== "running" && !(c.state === "exited" && c.exitCode === 0));
  for (const c of crashed) {
    const name = c.composeService ?? c.names[0] ?? c.id.slice(0, 12);
    problems.push(`${name} : ${c.state}${c.state === "exited" && c.exitCode !== undefined ? ` (code ${c.exitCode})` : ""}`);
  }
  for (const c of input.containers.filter((x) => x.state === "running" && x.health === "unhealthy")) {
    problems.push(`${c.composeService ?? c.names[0] ?? c.id.slice(0, 12)} : healthcheck en échec`);
  }
  const present = new Set(input.containers.map((c) => c.composeService).filter(Boolean));
  const missing = input.expectedServices.filter((s) => !s.optional && !present.has(s.name)).map((s) => s.name);
  for (const m of missing) problems.push(`${m} : conteneur absent`);

  if (problems.length > 0) {
    return { ...base, missingServices: missing, status: "degraded", reason: problems.join(" ; ") };
  }
  return { ...base, status: "running", reason: `${counts.running}/${counts.total} conteneur(s) en marche.` };
}

// --- Alertes ---------------------------------------------------------------------------

export type Severity = "critical" | "warning" | "info";

export interface Alert {
  /** Identifiant stable : la même anomalie garde le même identifiant d'un rafraîchissement à l'autre. */
  id: string;
  severity: Severity;
  kind: string;
  title: string;
  message: string;
  target: {
    type: "host" | "stack" | "container" | "backup" | "operation" | "image";
    id: string;
    name: string;
    /** Pour ouvrir le bon diagnostic : hôte, projet Compose, application gérée et service concernés, si connus. */
    hostId?: string;
    project?: string | null;
    stackId?: string | null;
    service?: string | null;
    /** Applications gérées qui utilisent l'image (alerte d'image). */
    stacks?: string[];
    /** Application d'une opération. */
    stackName?: string;
  };
  since: string | null;
}

export interface AlertHost {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: Date | null;
  inventoryObservedAt: Date | null;
}

export interface AlertStack {
  id: string;
  name: string;
  hostId: string;
  health: StackHealth;
}

export interface AlertContainer {
  hostId: string;
  stackId: string | null;
  container: Container;
}

/** Sécurité des images et mises à jour disponibles, pour les alertes. */
export interface SecurityAlertInput {
  images: {
    imageId: string;
    label: string;
    stacks: string[];
    state: ScanState;
    stale: boolean;
    counts: SeverityCounts | null;
    error: string | null;
    since: Date | null;
  }[];
  /** `observed` : projet Compose non géré (pas de stack) ; `stackId` contient alors le nom du projet. */
  updates: { stackId: string; stackName: string; service: string; detail: CheckDetail; since: Date; observed?: { hostId: string; project: string } }[];
  checkErrors: { stackId: string; stackName: string; service: string; error: string; since: Date; observed?: { hostId: string; project: string } }[];
}

export interface AlertContext {
  now: number;
  security?: SecurityAlertInput;
  hosts: AlertHost[];
  stacks: AlertStack[];
  containers: AlertContainer[];
  backup: Pick<BackupStatus, "state" | "lastError" | "pendingRevisions" | "configured"> | null;
  unknownOperations: { id: string; type: string; stackName: string; finishedAt: Date | null }[];
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
/** Un conteneur qui redémarre en boucle : au moins 3 redémarrages et démarrage récent. */
const RESTART_LOOP_MIN = 3;
const RESTART_LOOP_WINDOW_MS = 10 * 60 * 1000;

/** Raison du dernier test de healthcheck, pour le message d'alerte. */
function probeReason(c: Container): string {
  const p = c.healthProbe;
  if (!p) return "";
  const out = p.output.replace(/\s+/g, " ").trim().slice(0, 160);
  return ` : ${out ? `« ${out} » ` : ""}(code de sortie ${p.exitCode})`;
}

export function deriveAlerts(ctx: AlertContext): Alert[] {
  const alerts: Alert[] = [];

  for (const h of ctx.hosts) {
    if (!h.online) {
      alerts.push({
        id: `agent_offline:${h.id}`,
        severity: "critical",
        kind: "agent_offline",
        title: `Agent hors ligne : ${h.name}`,
        message: "L'état des stacks de cet hôte est inconnu (dernière observation conservée). Aucune action ne peut être lancée.",
        target: { type: "host", id: h.id, name: h.name },
        since: h.lastSeenAt?.toISOString() ?? null,
      });
    } else if (h.inventoryObservedAt && ctx.now - h.inventoryObservedAt.getTime() > STALE_AFTER_SEC * 1000) {
      alerts.push({
        id: `inventory_stale:${h.id}`,
        severity: "warning",
        kind: "inventory_stale",
        title: `Observation périmée : ${h.name}`,
        message: "L'agent est connecté mais n'a pas remonté d'inventaire récemment (Docker injoignable ?).",
        target: { type: "host", id: h.id, name: h.name },
        since: h.inventoryObservedAt.toISOString(),
      });
    }
  }

  for (const s of ctx.stacks) {
    if (s.health.status === "degraded") {
      alerts.push({
        id: `stack_degraded:${s.id}`,
        severity: "warning",
        kind: "stack_degraded",
        title: `Stack dégradée : ${s.name}`,
        message: s.health.reason,
        target: { type: "stack", id: s.id, name: s.name },
        since: s.health.observedAt,
      });
    } else if (s.health.status === "stopped") {
      alerts.push({
        id: `stack_stopped:${s.id}`,
        severity: "info",
        kind: "stack_stopped",
        title: `Stack arrêtée : ${s.name}`,
        message: s.health.reason,
        target: { type: "stack", id: s.id, name: s.name },
        since: s.health.observedAt,
      });
    }
  }

  for (const { container: c, hostId, stackId } of ctx.containers) {
    const name = c.composeService ?? c.names[0] ?? c.id.slice(0, 12);
    const target = { type: "container" as const, id: c.id, name, hostId, project: c.composeProject ?? null, stackId, service: c.composeService ?? null };
    if (c.health === "unhealthy" && c.state === "running") {
      alerts.push({
        id: `container_unhealthy:${hostId}:${c.id}`,
        severity: "warning",
        kind: "container_unhealthy",
        title: `Healthcheck en échec : ${name}`,
        message: `Le conteneur ${c.names[0] ?? c.id.slice(0, 12)} est en marche mais son healthcheck échoue${probeReason(c)}.`,
        target,
        since: c.startedAt || null,
      });
    }
    const startedMs = c.startedAt ? Date.parse(c.startedAt) : Number.NaN;
    const recentlyStarted = Number.isFinite(startedMs) && ctx.now - startedMs < RESTART_LOOP_WINDOW_MS;
    if (stackId && (c.state === "restarting" || ((c.restartCount ?? 0) >= RESTART_LOOP_MIN && recentlyStarted))) {
      alerts.push({
        id: `restart_loop:${hostId}:${c.id}`,
        severity: "warning",
        kind: "restart_loop",
        title: `Redémarrages répétés : ${name}`,
        message: `${c.restartCount ?? 0} redémarrage(s) ; le conteneur ${c.state === "restarting" ? "redémarre en ce moment" : "a redémarré récemment"}.`,
        target,
        since: c.startedAt || null,
      });
    }
  }

  if (ctx.backup?.configured) {
    if (ctx.backup.state === "blocked" || ctx.backup.state === "error") {
      alerts.push({
        id: "backup_failed",
        severity: ctx.backup.state === "blocked" ? "critical" : "warning",
        kind: ctx.backup.state === "blocked" ? "backup_blocked" : "backup_failed",
        title: ctx.backup.state === "blocked" ? "Sauvegarde Git bloquée" : "Sauvegarde Git en échec",
        message: `${ctx.backup.lastError?.message ?? "Erreur inconnue"} (${ctx.backup.pendingRevisions} révision(s) non sauvegardée(s))`,
        target: { type: "backup", id: "git", name: "Sauvegarde Git" },
        since: ctx.backup.lastError?.at || null,
      });
    }
  } else if (ctx.backup && !ctx.backup.configured) {
    alerts.push({
      id: "backup_not_configured",
      severity: "info",
      kind: "backup_not_configured",
      title: "Sauvegarde Git non configurée",
      message: "La configuration n'est pas sauvegardée hors de cette console.",
      target: { type: "backup", id: "git", name: "Sauvegarde Git" },
      since: null,
    });
  }

  for (const img of ctx.security?.images ?? []) {
    const target = { type: "image" as const, id: img.imageId, name: img.label, stacks: img.stacks };
    if (img.counts && img.counts.critical > 0) {
      alerts.push({
        id: `vulnerabilities_critical:${img.imageId}`,
        severity: "warning",
        kind: "vulnerabilities_critical",
        title: `${img.counts.critical} vulnérabilité(s) critique(s) : ${img.label}`,
        message: `Image utilisée par ${img.stacks.join(", ")} (${img.counts.high} élevée(s) en plus). Aucun déploiement n'est bloqué.`,
        target,
        since: img.since?.toISOString() ?? null,
      });
    }
    if (img.state === "failed") {
      alerts.push({
        id: `scan_failed:${img.imageId}`,
        severity: "warning",
        kind: "scan_failed",
        title: `Scan en échec : ${img.label}`,
        message: `${img.error ?? "Erreur inconnue"} — l'image n'est PAS considérée comme saine.`,
        target,
        since: img.since?.toISOString() ?? null,
      });
    } else if (img.stale) {
      alerts.push({
        id: `scan_stale:${img.imageId}`,
        severity: "info",
        kind: "scan_stale",
        title: `Scan périmé : ${img.label}`,
        message: "Le dernier scan est ancien : la base de vulnérabilités a évolué depuis.",
        target,
        since: img.since?.toISOString() ?? null,
      });
    }
  }
  for (const u of ctx.security?.updates ?? []) {
    const parts: string[] = [];
    if (u.detail.contentChanged) parts.push(`le tag « ${u.detail.tag} » a un nouveau contenu`);
    if (u.detail.candidates.length > 0) parts.push(`versions plus récentes : ${u.detail.candidates.join(", ")}${u.detail.uncertain ? " (incertain)" : ""}`);
    alerts.push({
      id: u.observed ? `image_update:${u.observed.hostId}:${u.observed.project}:${u.service}` : `image_update:${u.stackId}:${u.service}`,
      severity: "info",
      kind: "image_update",
      title: `Mise à jour d'image disponible : ${u.stackName}/${u.service}`,
      message: `${parts.join(" ; ")}. Rien n'est déployé automatiquement.`,
      target: u.observed ? { type: "stack", id: u.stackId, name: u.stackName, hostId: u.observed.hostId, project: u.observed.project, stackId: null } : { type: "stack", id: u.stackId, name: u.stackName },
      since: u.since.toISOString(),
    });
  }
  for (const e of ctx.security?.checkErrors ?? []) {
    alerts.push({
      id: e.observed ? `image_check_failed:${e.observed.hostId}:${e.observed.project}:${e.service}` : `image_check_failed:${e.stackId}:${e.service}`,
      severity: "info",
      kind: "image_check_failed",
      title: `Vérification de version impossible : ${e.stackName}/${e.service}`,
      message: `${e.error} (la dernière observation réussie est conservée).`,
      target: e.observed ? { type: "stack", id: e.stackId, name: e.stackName, hostId: e.observed.hostId, project: e.observed.project, stackId: null } : { type: "stack", id: e.stackId, name: e.stackName },
      since: e.since.toISOString(),
    });
  }

  for (const o of ctx.unknownOperations) {
    alerts.push({
      id: `operation_unknown:${o.id}`,
      severity: "warning",
      kind: "operation_unknown",
      title: `Résultat d'opération inconnu : ${o.stackName}`,
      message: `L'opération « ${o.type} » a perdu la connexion à l'agent : vérifiez l'état réel avant de relancer. Rien n'a été rejoué.`,
      target: { type: "operation", id: o.id, name: `${o.type} ${o.stackName}`, stackName: o.stackName },
      since: o.finishedAt?.toISOString() ?? null,
    });
  }

  return alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title));
}

// --- Tableau de bord ----------------------------------------------------------------------

interface HostRow {
  id: string;
  name: string;
  agent_version: string | null;
  last_seen_at: Date | null;
  docker_version: string | null;
  inventory: Container[] | null;
  inventory_observed_at: Date | null;
  host_info: HostInfo | null;
}

interface StackRow {
  id: string;
  name: string;
  host_id: string;
  current_revision: number;
  deployed_revision: number | null;
  compose: string | null;
}

export interface DashboardFilter {
  hostId?: string;
  stackId?: string;
}

export interface TopContainer extends LatestSample {
  hostId: string;
  hostName: string;
}

export class Dashboard {
  constructor(
    private readonly deps: {
      pool: Pool;
      metrics: MetricsStore;
      backup: BackupService;
      isOnline: (hostId: string) => boolean;
      scans: ScanService;
      watcher: ImageWatcher;
      /** Projets Compose non gérés ; absent : seules les stacks gérées alimentent les mises à jour. */
      observedWatcher?: ObservedWatcher;
    },
  ) {}

  async snapshot(filter: DashboardFilter = {}, now = Date.now()) {
    const { pool } = this.deps;
    const [hostRows, stackRows, unknownOps, backup] = await Promise.all([
      pool.query<HostRow>(
        `SELECT id, name, agent_version, last_seen_at, docker_version, inventory, inventory_observed_at, host_info
           FROM hosts WHERE revoked_at IS NULL ORDER BY created_at`,
      ),
      pool.query<StackRow>(
        `SELECT s.id, s.name, s.host_id, s.current_revision, s.deployed_revision, r.compose
           FROM stacks s LEFT JOIN stack_revisions r ON r.stack_id = s.id AND r.revision = s.deployed_revision
          ORDER BY s.name`,
      ),
      pool.query<{ id: string; type: string; stack_name: string; finished_at: Date | null }>(
        `SELECT o.id, o.type, s.name AS stack_name, o.finished_at
           FROM operations o JOIN stacks s ON s.id = o.stack_id
          WHERE o.status = 'unknown' AND o.finished_at > now() - interval '24 hours' ORDER BY o.finished_at DESC LIMIT 20`,
      ),
      this.deps.backup.status(),
    ]);

    let hosts = hostRows.rows;
    let stacks = stackRows.rows;
    if (filter.stackId) {
      stacks = stacks.filter((s) => s.id === filter.stackId);
      hosts = hosts.filter((h) => stacks.some((s) => s.host_id === h.id));
    } else if (filter.hostId) {
      hosts = hosts.filter((h) => h.id === filter.hostId);
      stacks = stacks.filter((s) => s.host_id === filter.hostId);
    }

    const hostById = new Map(hosts.map((h) => [h.id, h]));
    const stackViews = stacks.map((s) => {
      const host = hostById.get(s.host_id);
      const online = this.deps.isOnline(s.host_id);
      const health = deriveStackStatus({
        deployedRevision: s.deployed_revision,
        hostOnline: online,
        inventoryObservedAt: host?.inventory_observed_at ?? null,
        now,
        containers: (host?.inventory ?? []).filter((c) => c.composeProject === s.name),
        expectedServices: s.compose ? listComposeServices(s.compose) : [],
      });
      return { s, host, online, health };
    });

    // Éléments de la console elle-même : masqués des vues si le réglage « Affichage » le demande (ils restent scannés).
    const hidden = await hiddenProjects(pool);
    const managedProjects = new Set(stackRows.rows.map((s) => `${s.host_id}:${s.name}`));
    const containerRows: { hostId: string; stackId: string | null; container: Container }[] = [];
    let unmanagedProjects = 0;
    for (const h of hosts) {
      const projects = new Set<string>();
      for (const c of h.inventory ?? []) {
        if (c.composeProject && hidden.includes(c.composeProject)) continue;
        const stack = c.composeProject ? stackRows.rows.find((s) => s.host_id === h.id && s.name === c.composeProject) : undefined;
        if (filter.stackId && stack?.id !== filter.stackId) continue;
        containerRows.push({ hostId: h.id, stackId: stack?.id ?? null, container: c });
        if (c.composeProject && !managedProjects.has(`${h.id}:${c.composeProject}`)) projects.add(c.composeProject);
      }
      unmanagedProjects += projects.size;
    }

    // Sécurité : seules les images de stacks gérées alimentent les alertes (les autres restent consultables).
    const settings = await getSecuritySettings(pool);
    const [usedImages, scanMap, allChecks] = await Promise.all([loadUsedImages(pool, { ...filter, excludeProjects: hidden }), this.deps.scans.latestAll(), this.deps.watcher.allChecks()]);
    const securityImages: SecurityAlertInput["images"] = [];
    const sec = { images: 0, never: 0, failed: 0, clean: 0, vulnerable: 0, critical: 0, high: 0, withCritical: 0, withHigh: 0, noSevere: 0 };
    // Répartition des vulnérabilités par gravité : « filtered » applique le seuil des paramètres, « all » l'ignore.
    const zero = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
    const vulns = { filtered: zero(), all: zero() };
    const addCounts = (into: SeverityCounts, from: SeverityCounts | null | undefined): void => {
      if (!from) return;
      into.critical += from.critical;
      into.high += from.high;
      into.medium += from.medium;
      into.low += from.low;
      into.unknown += from.unknown;
    };
    // Les graphiques couvrent les images de tous les projets Compose (gérés ou observés) ; les alertes, seulement les gérées.
    const inCompose = new Set<string>();
    for (const h of hosts) for (const c of h.inventory ?? []) if (c.composeProject) inCompose.add(`${h.id}|${c.id}`);
    for (const img of usedImages) {
      const stackNames = [...new Set(img.usedBy.map((u) => u.stackName).filter((n): n is string => n !== null))];
      const managed = stackNames.length > 0;
      if (!managed && !img.usedBy.some((u) => inCompose.has(`${u.hostId}|${u.containerId}`))) continue;
      const entry = scanMap.get(`${img.imageId}|${img.platform}`);
      const state = scanState(entry ? briefOf(entry.attempt, settings) : null);
      // Seules les gravités signalées par les réglages comptent (seuil minimal, « inconnues »).
      const reported = reportedCounts(entry?.ok?.counts ?? null, settings)?.counts ?? null;
      sec.images++;
      if (state === "never") sec.never++;
      if (state === "failed") sec.failed++;
      if (state === "clean") sec.clean++;
      if (state === "vulnerable") sec.vulnerable++;
      // Répartition par image sur les seules CVE critiques et élevées : quasiment toute image a des vulnérabilités
      // mineures, ce qui n'est pas un signal utile. Un scan en échec ou absent n'est jamais rangé parmi les sains.
      if (state === "clean" || state === "vulnerable") {
        if ((reported?.critical ?? 0) > 0) sec.withCritical++;
        else if ((reported?.high ?? 0) > 0) sec.withHigh++;
        else sec.noSevere++;
      }
      addCounts(vulns.filtered, reported);
      addCounts(vulns.all, entry?.ok?.counts ?? null);
      sec.critical += reported?.critical ?? 0;
      sec.high += reported?.high ?? 0;
      if (!managed) continue;
      securityImages.push({
        imageId: img.imageId,
        label: img.refs[0] ?? img.imageId.slice(0, 19),
        stacks: stackNames,
        state,
        stale: isScanStale(entry?.ok ?? null, settings.scanIntervalHours, now),
        counts: reported,
        error: entry?.attempt.error ?? null,
        since: entry?.attempt.finishedAt ?? null,
      });
    }
    const visibleStacks = new Set(stackViews.map((v) => v.s.id));
    const checks = currentChecks(allChecks, usedImages).filter((c) => visibleStacks.has(c.stackId));
    // Projets non gérés (hors console, hors stack) : filtrés par hôte comme le reste, absents d'une vue par application.
    const observedChecks = filter.stackId ? [] : (await (this.deps.observedWatcher ? currentObservedChecks(pool, usedImages) : Promise.resolve([]))).filter(
      (c) => hostById.has(c.hostId) && !hidden.includes(c.project) && !managedProjects.has(`${c.hostId}:${c.project}`),
    );
    const staleError = (c: { status: string; lastSuccessAt: Date | null }): boolean => c.status === "error" && (!c.lastSuccessAt || now - c.lastSuccessAt.getTime() > 3 * 24 * 3600_000);
    const updates: SecurityAlertInput["updates"] = [
      ...checks
        .filter((c) => c.kind === "update_available" && c.detail)
        .map((c) => ({ stackId: c.stackId, stackName: c.stackName, service: c.service, detail: c.detail as CheckDetail, since: c.checkedAt })),
      ...observedChecks
        .filter((c) => c.kind === "update_available" && c.detail)
        .map((c) => ({ stackId: c.project, stackName: c.project, service: c.service, detail: c.detail as CheckDetail, since: c.checkedAt, observed: { hostId: c.hostId, project: c.project } })),
    ];
    const checkErrors: SecurityAlertInput["checkErrors"] = [
      ...checks.filter(staleError).map((c) => ({ stackId: c.stackId, stackName: c.stackName, service: c.service, error: c.error ?? "Erreur inconnue", since: c.checkedAt })),
      ...observedChecks.filter(staleError).map((c) => ({ stackId: c.project, stackName: c.project, service: c.service, error: c.error ?? "Erreur inconnue", since: c.checkedAt, observed: { hostId: c.hostId, project: c.project } })),
    ];

    const alerts = deriveAlerts({
      now,
      security: { images: securityImages, updates, checkErrors },
      hosts: hosts.map((h) => ({
        id: h.id,
        name: h.name,
        online: this.deps.isOnline(h.id),
        lastSeenAt: h.last_seen_at,
        inventoryObservedAt: h.inventory_observed_at,
      })),
      stacks: stackViews.map((v) => ({ id: v.s.id, name: v.s.name, hostId: v.s.host_id, health: v.health })),
      containers: containerRows.filter((c) => c.stackId !== null || !filter.stackId),
      backup: filter.stackId || filter.hostId ? null : backup,
      unknownOperations: unknownOps.rows
        .filter((o) => !filter.stackId || stackViews.some((v) => v.s.name === o.stack_name))
        .map((o) => ({ id: o.id, type: o.type, stackName: o.stack_name, finishedAt: o.finished_at })),
    });

    const counts = { running: 0, degraded: 0, stopped: 0, unknown: 0, not_deployed: 0 };
    for (const v of stackViews) counts[v.health.status]++;

    // Utilisation : derniers échantillons connus, uniquement pour les hôtes en ligne (sinon périmés).
    const top: TopContainer[] = [];
    for (const h of hosts) {
      if (!this.deps.isOnline(h.id)) continue;
      for (const m of await this.deps.metrics.latest(h.id)) {
        if (filter.stackId && m.project !== stackViews[0]?.s.name) continue;
        if (m.project && hidden.includes(m.project)) continue;
        top.push({ ...m, hostId: h.id, hostName: h.name });
      }
    }
    top.sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1));

    const containers = containerRows.map((r) => r.container);
    return {
      generatedAt: new Date(now).toISOString(),
      agents: {
        total: hosts.length,
        online: hosts.filter((h) => this.deps.isOnline(h.id)).length,
        offline: hosts.filter((h) => !this.deps.isOnline(h.id)).length,
        items: hosts.map((h) => ({
          id: h.id,
          name: h.name,
          presence: this.deps.isOnline(h.id) ? ("online" as const) : ("offline" as const),
          lastSeenAt: h.last_seen_at?.toISOString() ?? null,
          agentVersion: h.agent_version,
          dockerVersion: h.docker_version,
          inventoryObservedAt: h.inventory_observed_at?.toISOString() ?? null,
          hostInfo: h.host_info,
        })),
      },
      stacks: {
        counts,
        items: stackViews.map((v) => ({
          id: v.s.id,
          name: v.s.name,
          hostId: v.s.host_id,
          hostName: v.host?.name ?? "",
          hostPresence: v.online ? ("online" as const) : ("offline" as const),
          currentRevision: v.s.current_revision,
          deployedRevision: v.s.deployed_revision,
          ...v.health,
        })),
      },
      containers: {
        total: containers.length,
        running: containers.filter((c) => c.state === "running").length,
        stopped: containers.filter((c) => c.state !== "running").length,
        // Un conteneur terminé avec le code 0 (migration, tâche ponctuelle) n'est pas une erreur.
        completed: containers.filter((c) => c.state === "exited" && c.exitCode === 0).length,
        failed: containers.filter((c) => c.state === "dead" || c.state === "restarting" || (c.state === "exited" && c.exitCode !== undefined && c.exitCode !== 0)).length,
        // Un healthcheck « en échec » ne concerne que les conteneurs en marche ; un conteneur arrêté n'est pas « unhealthy ».
        unhealthy: containers.filter((c) => c.state === "running" && c.health === "unhealthy").length,
        noHealthcheck: containers.filter((c) => c.state === "running" && c.health === "none").length,
        unmanagedProjects,
      },
      usage: { top: top.slice(0, 10) },
      backup: filter.stackId || filter.hostId ? null : { state: backup.state, lastPushAt: backup.lastPushAt, pendingRevisions: backup.pendingRevisions, configured: backup.configured },
      security: { images: sec, vulns, updates: { available: updates.length, errors: checkErrors.length } },
      alerts,
    };
  }
}
