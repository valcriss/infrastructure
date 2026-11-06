export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Erreur ${res.status}`, err?.details);
  }
  return data as T;
}

/** Message lisible pour une erreur d'API, avec les erreurs de Compose localisées. */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return "Erreur inattendue.";
  if (err.code === "invalid_compose" && Array.isArray(err.details)) {
    return (
      "Compose invalide : " +
      (err.details as { message: string; line?: number }[])
        .map((i) => (i.line ? `ligne ${i.line} — ${i.message}` : i.message))
        .join(" ; ")
    );
  }
  if (err.code === "revision_conflict") {
    return "La stack a été modifiée entre-temps. Rechargez la page pour récupérer la dernière révision.";
  }
  return err.message;
}

export interface Container {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  composeProject?: string;
  composeService?: string;
  health?: "healthy" | "unhealthy" | "starting" | "none";
  restartCount?: number;
  startedAt?: string;
  exitCode?: number;
  ports?: { privatePort: number; publicPort?: number; type: string; ip?: string }[];
  networks?: string[];
  mounts?: { type: string; source?: string; destination: string; rw: boolean }[];
  composeWorkingDir?: string;
  composeConfigFiles?: string;
}

/** Projet Compose dont on suit l'activité (stack gérée ou projet observé). */
export interface ProjectRef {
  hostId: string;
  name: string;
}

export interface Host {
  id: string;
  name: string;
  agentVersion: string | null;
  capabilities: string[];
  presence: "online" | "offline" | "pending";
  lastSeenAt: string | null;
  dockerVersion: string | null;
  inventoryObservedAt: string | null;
  containerCount: number | null;
}

export interface HostDetail extends Host {
  containers: Container[];
}

export interface StackSummary {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  hostPresence: "online" | "offline";
  description: string;
  currentRevision: number;
  deployedRevision: number | null;
  pendingDeploy: boolean;
  deployedAt: string | null;
  updatedAt: string;
  observed: { total: number; running: number; observedAt: string } | null;
}

export interface VariableView {
  name: string;
  value: string | null;
  sensitive: boolean;
}

export interface StackDetail extends StackSummary {
  compose: string;
  variables: VariableView[];
  files: string[];
  sensitiveFiles: string[];
  composeSensitive: boolean;
  containers: Container[];
}

export interface RevisionSummary {
  revision: number;
  digest: string;
  author: string;
  message: string | null;
  createdAt: string;
}

export interface RevisionDetail extends RevisionSummary {
  compose: string;
  variables: VariableView[];
  files: Record<string, string>;
  sensitiveFiles: string[];
  composeSensitive: boolean;
}

export type OperationStatus = "pending" | "running" | "succeeded" | "failed" | "unknown";

export interface OperationView {
  id: string;
  type: "deploy" | "stop" | "start";
  stackId: string;
  revision: number | null;
  status: OperationStatus;
  requestedBy: string;
  error: string | null;
  result: { images?: { service: string; image: string; repoDigests: string[] }[]; services?: { service: string; state: string; health?: string }[] } | null;
  log?: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChangeResult {
  revision: number;
  changed: boolean;
  backup: { status: string };
}

export const fmtDate = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString("fr-FR") : "jamais";

export interface ObservedProject {
  name: string;
  managedStackId: string | null;
  importable: boolean;
  total: number;
  running: number;
  services: { service: string; image: string }[];
}

export type BackupState = "not_configured" | "disabled" | "ok" | "pending" | "error" | "blocked";

export interface BackupStatus {
  state: BackupState;
  configured: boolean;
  enabled: boolean;
  repoUrl: string | null;
  username: string | null;
  branch: string | null;
  configRevision: number;
  pushedRevision: number;
  pendingRevisions: number;
  localCommit: string | null;
  pushedCommit: string | null;
  lastPushAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  nextRetryAt: string | null;
  hasRestorationKey: boolean;
  installationId: string;
}

export interface ConnectionTest {
  remote: "empty" | "branch_missing" | "has_backup" | "foreign_content";
  backup: { installationId: string; configRevision: number; formatVersion: number; sameInstallation: boolean } | null;
}

export interface RestorePreview {
  previewId: string;
  expiresAt: string;
  installationId: string;
  configRevision: number;
  hasSecrets: boolean;
  restorationKeyWillChange: boolean;
  stacks: { id: string; name: string; hostId: string; description: string; variables: number; files: number; conflict: "none" | "same_id" | "same_name" }[];
  backupHosts: { id: string; name: string }[];
  availableHosts: { id: string; name: string }[];
}

// --- Supervision ----------------------------------------------------------------------------

export type StackStatus = "running" | "degraded" | "stopped" | "unknown" | "not_deployed";
export type Severity = "critical" | "warning" | "info";

export interface DashboardStack {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  hostPresence: "online" | "offline";
  currentRevision: number;
  deployedRevision: number | null;
  status: StackStatus;
  reason: string;
  observedAt: string | null;
  containers: { total: number; running: number; unhealthy: number; restarting: number; noHealthcheck: number };
  missingServices: string[];
}

export interface DashboardAlert {
  id: string;
  severity: Severity;
  kind: string;
  title: string;
  message: string;
  target: { type: "host" | "stack" | "container" | "backup" | "operation" | "image"; id: string; name: string };
  since: string | null;
}

export interface HostInfo {
  cpus: number;
  memTotalBytes: number;
  os: string;
  serverVersion: string;
  containersRunning: number;
  containersPaused: number;
  containersStopped: number;
  images: number;
}

export interface Dashboard {
  generatedAt: string;
  agents: {
    total: number;
    online: number;
    offline: number;
    items: { id: string; name: string; presence: "online" | "offline"; lastSeenAt: string | null; agentVersion: string | null; dockerVersion: string | null; inventoryObservedAt: string | null; hostInfo: HostInfo | null }[];
  };
  stacks: { counts: Record<StackStatus, number>; items: DashboardStack[] };
  containers: { total: number; running: number; stopped: number; completed: number; failed: number; unhealthy: number; noHealthcheck: number; unmanagedProjects: number };
  usage: { top: { containerId: string; name: string; project: string | null; service: string | null; cpuPercent: number | null; memBytes: number; memLimitBytes: number; hostName: string }[] };
  backup: { state: BackupState; lastPushAt: string | null; pendingRevisions: number; configured: boolean } | null;
  security: { images: { images: number; never: number; failed: number; clean: number; vulnerable: number; critical: number; high: number; withCritical: number; withHigh: number; noSevere: number }; updates: { available: number; errors: number } };
  alerts: DashboardAlert[];
}

export type OverviewRange = "1h" | "6h" | "24h" | "7d";

export interface OverviewResult {
  rangeSec: number;
  stepSec: number;
  intervalSec: number;
  retentionDays: number;
  totals: { points: { t: string; cpu: number | null; mem: number; rxBps: number | null; txBps: number | null }[] };
  top: { cpu: { project: string; hostName: string; value: number }[]; mem: { project: string; hostName: string; value: number }[] };
  hosts: {
    hostId: string;
    name: string;
    cpus: number | null;
    latest: { cpuPercent: number | null; memUsed: number | null; memTotal: number | null; diskUsed: number | null; diskTotal: number | null; observedAt: string } | null;
    points: { t: string; cpu: number | null; mem: number | null; disk: number | null }[];
  }[];
}

export interface MetricPoint {
  t: string;
  cpu: number | null;
  mem: number;
  memLimit: number;
  rxBps: number | null;
  txBps: number | null;
}

export interface MetricsResult {
  rangeSec: number;
  stepSec: number;
  intervalSec: number;
  retentionDays: number;
  containers: { container: string; service: string | null; points: MetricPoint[] }[];
}

/** « il y a 3 min » à partir d'une date ISO. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "jamais";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} o`;
  const units = ["Kio", "Mio", "Gio", "Tio"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// --- Sécurité des images ----------------------------------------------------------------------

export type ScanStateName = "never" | "pending" | "running" | "failed" | "clean" | "vulnerable";
export type VulnSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface ScanSummary {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  trigger: "manual" | "scheduled";
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  trivyVersion: string | null;
  dbUpdatedAt: string | null;
  dbDownloadedAt: string | null;
  os: { family: string; name: string; eosl: boolean | null } | null;
  counts: { critical: number; high: number; medium: number; low: number; unknown: number } | null;
  total: number | null;
  /** Vulnérabilités masquées par le seuil de gravité des paramètres. */
  hidden?: number;
  truncated: boolean;
}

export interface ImageScanView {
  state: ScanStateName;
  stale: boolean;
  lastAttempt: ScanSummary | null;
  /** Dernier résultat réussi : conservé et daté même si la dernière tentative a échoué. */
  current: ScanSummary | null;
}

export interface ImageUserView {
  hostId: string;
  hostName: string;
  stackId: string | null;
  stackName: string | null;
  service: string | null;
  container: string;
  containerId: string;
  state: string;
  ref: string;
}

export interface ImageView {
  imageId: string;
  platform: string;
  refs: string[];
  repoDigests: string[];
  size: number | null;
  managed: boolean;
  usedBy: ImageUserView[];
  scan: ImageScanView;
}

export interface Vulnerability {
  id: string;
  pkg: string;
  installed: string;
  fixed: string | null;
  severity: VulnSeverity;
  title: string;
  url: string | null;
  status?: string;
}

export interface CheckDetailView {
  ref: string;
  registry: string | null;
  repository: string | null;
  tag: string | null;
  deployedDigest: string | null;
  remoteDigest: string | null;
  platform: string;
  contentChanged: boolean | null;
  candidates: string[];
  uncertain: boolean;
  tagsTruncated: boolean;
  notes: string[];
}

export type UpdatePolicyName = "same_tag" | "patch" | "minor" | "major" | "pattern";

export interface StackImageComponent {
  service: string;
  ref: string;
  image: ImageView;
  policy: { policy: UpdatePolicyName; pattern: string | null };
  check: {
    checkedAt: string;
    status: "ok" | "error";
    kind: "up_to_date" | "update_available" | "pinned" | "local" | "unsupported" | null;
    detail: CheckDetailView | null;
    error: string | null;
    lastSuccessAt: string | null;
  } | null;
}

export interface RegistryEntry {
  registry: string;
  username: string | null;
  hasPassword: boolean;
  insecure: boolean;
}

export type MinSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface SecuritySettings {
  scanIntervalHours: number;
  imageCheckIntervalHours: number;
  minSeverity: MinSeverity;
  includeUnknown: boolean;
}

export const shortId = (id: string): string => id.replace(/^sha256:/, "").slice(0, 12);

// --- Applications -----------------------------------------------------------------------------------

export interface ApplicationImage {
  imageId: string;
  platform: string;
  ref: string;
  scan: ScanStateName;
  stale: boolean;
  counts: { critical: number; high: number; medium: number; low: number; unknown: number } | null;
}

export interface Application {
  kind: "managed" | "observed";
  stackId: string | null;
  name: string;
  hostId: string;
  hostName: string;
  hostPresence: "online" | "offline";
  status: StackStatus;
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
