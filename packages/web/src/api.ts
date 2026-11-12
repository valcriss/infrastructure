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
  healthProbe?: { exitCode: number; output: string; at: string; command?: string; failingStreak?: number; retries?: number };
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
  diskUsage: { observedAt: string; summary: DiskUsageSummary; truncated: boolean } | null;
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
  /** Module qui génère et entretient l'application (contenu non modifiable à la main), ou null. */
  managedBy: string | null;
  /** Empreinte du SVG personnalisé (null : icône par défaut) et couleur de fond personnalisée (« #rrggbb »). */
  iconTag: string | null;
  iconColor: string | null;
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
  /** Révision écartée : conservée dans l'historique, plus proposée au déploiement. */
  abandoned: { at: string; reason: string | null } | null;
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
  type: "deploy" | "stop" | "start" | "destroy";
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
  target: {
    type: "host" | "stack" | "container" | "backup" | "operation" | "image";
    id: string;
    name: string;
    hostId?: string;
    project?: string | null;
    stackId?: string | null;
    service?: string | null;
    stacks?: string[];
    stackName?: string;
  };
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
  security: { images: { images: number; never: number; failed: number; clean: number; vulnerable: number; critical: number; high: number; withCritical: number; withHigh: number; noSevere: number }; vulns: { filtered: VulnCounts; all: VulnCounts }; updates: { available: number; errors: number } };
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
export interface VulnCounts { critical: number; high: number; medium: number; low: number; unknown: number }
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
  /** Rang dans la file d'attente (1 = prochain), pour un scan en attente. */
  queuePosition?: number | null;
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
  /** Image du registre, de Traefik, de la console ou de son agent : jamais corrigée localement (dépendance circulaire). */
  infrastructure: boolean;
  usedBy: ImageUserView[];
  scan: ImageScanView;
  /** Mises à jour disponibles pour les services qui utilisent cette image. */
  updates: { service: string; stackId: string | null; tag: string | null; contentChanged: boolean; candidates: string[]; uncertain: boolean }[];
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
  /** Risque accepté pour cette vulnérabilité (justification, expiration) ; absent si elle compte. */
  accepted?: VulnAcceptance | null;
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
  /** Versions proposées par la règle mais écartées par l'utilisateur. */
  ignored?: string[];
  uncertain: boolean;
  tagsTruncated: boolean;
  notes: string[];
  /** Service construit sur l'hôte : cette vérification porte sur l'image de base (FROM) de ce Dockerfile. */
  built?: { dockerfile: string };
}

export type UpdatePolicyName = "same_tag" | "patch" | "minor" | "major" | "pattern";

export interface StackImageComponent {
  service: string;
  ref: string;
  image: ImageView;
  policy: { policy: UpdatePolicyName; pattern: string | null };
  ignoredTags: { tag: string; reason: string | null; createdBy: string; createdAt: string }[];
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
  /** Un compte de lecture seule existe (registre privé géré par la console). */
  separated?: boolean;
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
  /** Taille sur le disque des volumes et dossiers montés ; null tant que rien n'a été mesuré. */
  storageBytes: number | null;
  currentRevision: number | null;
  deployedRevision: number | null;
  pendingDeploy: boolean;
  lastDeployAt: string | null;
  importable: boolean;
  iconTag: string | null;
  iconColor: string | null;
}

// --- Conteneurs ---------------------------------------------------------------------------------------

/** Un conteneur d'un hôte, rattaché ou non à une application Compose. */
export interface ContainerRow {
  hostId: string;
  hostName: string;
  hostPresence: "online" | "offline";
  id: string;
  name: string;
  service: string | null;
  project: string | null;
  appKind: "managed" | "observed" | null;
  stackId: string | null;
  image: string;
  state: string;
  status: string;
  health: "healthy" | "unhealthy" | "starting" | "none" | null;
  restartCount: number;
  exitCode: number | null;
  startedAt: string | null;
  created: number;
  ports: { privatePort: number; publicPort?: number; type: string; ip?: string }[];
  usage: { cpuPercent: number; memBytes: number; memLimitBytes: number } | null;
  /** Conteneur de la console ou de son agent : ni action de cycle de vie, ni terminal. */
  protected: boolean;
}

// --- Espace disque Docker et nettoyage ----------------------------------------------------------------

export interface DiskUsageEntry {
  count: number;
  sizeBytes: number;
  reclaimableBytes: number;
}

export interface DiskUsageSummary {
  images: DiskUsageEntry;
  containers: DiskUsageEntry;
  volumes: DiskUsageEntry;
  buildCache: DiskUsageEntry;
}

export interface PruneOptions {
  containers: { enabled: boolean; olderThanDays?: number };
  images: { mode: "off" | "dangling" | "unused"; olderThanDays?: number };
  networks: { enabled: boolean };
  volumes: { mode: "off" | "anonymous" | "all" };
  buildCache: { mode: "off" | "all" | "older"; olderThanDays?: number; keepGB?: number };
}

export interface PrunePlan {
  observedAt: string;
  items: {
    containers: { id: string; name: string; image: string; project?: string; service?: string; created: number; sizeBytes: number | null }[];
    images: { id: string; ref: string; created: number; sizeBytes: number; dangling: boolean }[];
    networks: { id: string; name: string }[];
    volumes: { name: string; sizeBytes: number | null; anonymous: boolean; project?: string }[];
    buildCache: { mode: "off" | "all" | "older"; count: number; sizeBytes: number; olderThanDays: number | null; keepGB: number | null; sample: { id: string; description?: string; sizeBytes: number; lastUsedAt: string | null }[] };
  };
  totals: { items: number; reclaimableBytes: number };
  warnings: { level: "info" | "warning" | "danger"; text: string }[];
  requiresHostConfirmation: boolean;
  truncated: boolean;
}

export interface PruneRun {
  id: string;
  hostId: string;
  requestedBy: string;
  status: "running" | "succeeded" | "failed" | "unknown";
  result: { removed: { containers: number; images: number; networks: number; volumes: number; buildCache: number }; reclaimedBytes: number; skipped: string[]; errors: string[] } | null;
  /** Dernier avancement reçu de l'agent pendant le nettoyage. */
  progress: {
    phase: "containers" | "networks" | "images" | "volumes" | "buildCache";
    done: number;
    total: number;
    current?: string;
    overall: { done: number; total: number };
    removed: { containers: number; images: number; networks: number; volumes: number; buildCache: number };
    reclaimedBytes: number;
    buildCacheBytes?: number;
  } | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// --- Utilisateurs, rôles et moyens de connexion --------------------------------------------------------

export type Role = "viewer" | "operator" | "admin";

export const ROLE_LABELS: Record<Role, string> = { viewer: "Lecteur", operator: "Opérateur", admin: "Administrateur" };

export interface SessionInfo {
  username: string;
  email: string;
  displayName: string;
  role: Role;
  terminalAllowed: boolean;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  /** Le compte a un mot de passe (sinon : clé d'accès seule). */
  hasPassword: boolean;
  passkeysAvailable: boolean;
  /** Un deuxième facteur a été présenté récemment (nécessaire pour ouvrir un terminal). */
  mfaRecent: boolean;
}

export interface UserView {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  role: Role;
  terminalAllowed: boolean;
  active: boolean;
  hasPassword: boolean;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  passkeys: number;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  transports: string[];
}

export interface SecurityInfo extends SessionInfo {
  recoveryCodesRemaining: number;
  passkeys: PasskeyView[];
}

// --- Aide à la décision sur les CVE ---------------------------------------------------------------------

export interface VulnAcceptance {
  id: string;
  justification: string;
  expiresAt: string;
  createdBy: string;
}

export interface PackageToUpdate {
  pkg: string;
  installed: string;
  fixableCount: number;
  worst: VulnSeverity;
  fixedIn: string;
}

export interface VulnScanSummary {
  total: number;
  fixable: number;
  unfixable: number;
  willNotFix: number;
  packages: PackageToUpdate[];
  packagesTruncated: boolean;
  accepted: number;
}

export interface AcceptedRisk {
  id: string;
  cve: string;
  repository: string | null;
  justification: string;
  expiresAt: string;
  expired: boolean;
  createdBy: string;
  createdAt: string;
}

export interface CandidateResult {
  counts: { critical: number; high: number; medium: number; low: number; unknown: number };
  total: number;
  fixable: number;
  unfixable: number;
  os: { family: string; name: string; eosl: boolean | null } | null;
  finishedAt: string | null;
}

export interface CandidateView {
  id: string;
  service: string;
  ref: string;
  tag: string;
  status: "pulling" | "scanning" | "succeeded" | "failed";
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  result: CandidateResult | null;
  current: CandidateResult | null;
  /** Déjà dans la révision enregistrée (à déployer) : plus de bouton « Utiliser cette version ». */
  adopted: boolean;
}

export interface TagSuggestions {
  current: string | null;
  newer: string[];
  variants: string[];
  /** La liste de tags du registre est incomplète : les versions les plus récentes peuvent manquer. */
  truncated?: boolean;
  /** Faux quand la liste des versions du registre n'a pas pu être lue (absence de suggestion ≠ aucune version plus récente). */
  listed?: boolean;
  note?: string | null;
}

/** Ce que la suppression d'une application retirerait (réservé aux administrateurs). */
export interface RemovalHostPlan {
  available: true;
  containers: { id: string; name: string; state: string; image: string }[];
  running: number;
  networks: { id: string; name: string }[];
  volumes: { name: string; sizeBytes: number | null }[];
  images: { ref: string; id: string; usedByOthers: number }[];
  /** Dossiers de l'hôte montés dans les conteneurs : jamais supprimés. */
  binds: string[];
  workspace: boolean;
}
export interface RemovalPlanView {
  stack: { id: string; name: string; deployed: boolean };
  busy: boolean;
  host: RemovalHostPlan | { available: false; reason: string };
  console: { revisions: number; operations: number; imageChecks: number };
}

// --- Stockage -----------------------------------------------------------------------------------------

/** Un volume ou dossier monté (distinct), avec les services qui l'utilisent et sa taille sur le disque. */
export interface StorageItem {
  kind: "volume" | "bind" | "tmpfs";
  source: string | null;
  usedBy: { service: string; container: string; destination: string; rw: boolean }[];
  sizeBytes: number | null;
  note: string | null;
  measuredAt: string | null;
}

export interface StorageView {
  items: StorageItem[];
  totalBytes: number | null;
  unmeasured: number;
  measuredAt: string | null;
  measuring: boolean;
}

// --- Remédiation des images ----------------------------------------------------------------------------

export type RemediationStatus =
  | "queued" | "preparing" | "scanning_before" | "patching" | "scanning_after" | "verifying"
  | "validated" | "partial" | "rejected" | "failed" | "unknown" | "cancelled";

export interface RemediationBilanVuln { id: string; severity: VulnSeverity; pkg: string; installed: string; fixed: string | null }

export interface RemediationVerifyRun { ok: boolean; exitCode: number | null; timedOut: boolean; outputMatched: boolean | null }
/** Vérification de démarrage : réussie, régression (refusée), non concluante (échoue déjà sur l'image d'origine), non effectuée (agent ancien). */
export interface RemediationVerification {
  state: "passed" | "regression" | "inconclusive" | "skipped";
  check: { command: string[]; expectExit: number; outputContains: string | null };
  source: RemediationVerifyRun | null;
  patched: RemediationVerifyRun | null;
}

export interface RemediationBilan {
  verdict: "validated" | "partial" | "rejected";
  reasons: string[];
  cves: { before: number; after: number; fixableBefore: number; resolved: number; remainingFixable: number; unfixable: number; new: number; newHighOrCritical: number };
  findings: { before: number; after: number };
  resolved: RemediationBilanVuln[];
  remaining: RemediationBilanVuln[];
  added: RemediationBilanVuln[];
  truncatedLists: boolean;
  verification: RemediationVerification | null;
}

export interface RemediationJob {
  id: string;
  imageId: string;
  platform: string;
  hostId: string;
  imageRef: string;
  policy: string;
  status: RemediationStatus;
  active: boolean;
  requestedBy: string;
  registry: string;
  repository: string;
  patchedTag: string;
  patchedRef: string | null;
  sourceDigest: string | null;
  patchedDigest: string | null;
  tools: { copa?: string; buildkit?: string; trivy?: string } | null;
  bilan: RemediationBilan | null;
  packageChanges: { name: string; from: string; to: string }[] | null;
  configChanges: string[] | null;
  labelsAdded: string[] | null;
  vexStatements: number | null;
  error: string | null;
  applied: { stackId: string; stackName: string; service: string; revision: number; by: string; at: string }[];
  imageDeleted: boolean;
  /** Un arrêt a été demandé à l'agent et n'est pas encore confirmé. */
  cancelRequested: boolean;
  /** Préparé par la planification, et non à la demande d'un utilisateur. */
  automatic: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RemediationEligibility {
  imageId: string;
  platform: string;
  eligible: boolean;
  reason: "ok" | "no_scan" | "unsupported_os" | "eol" | "nothing_fixable" | "app_only" | "infrastructure";
  message: string;
  fixableOs: number;
  fixableApp: number;
  unfixable: number;
  hosts: { id: string; name: string; online: boolean; capable: boolean }[];
  registry: { ready: boolean; reason: string | null };
  activeJob: { id: string; status: RemediationStatus } | null;
  canStart: boolean;
}

export interface RemediationTarget {
  stackId: string;
  stackName: string;
  service: string;
  hostName: string;
  currentRevision: number;
  deployedRevision: number | null;
  currentImage: string | null;
  /** « image » : le Compose change ; « variable » : seule la variable de la stack qui porte l'image change. */
  mode: "image" | "variable";
  variable: string | null;
  /** Image réellement utilisée après interpolation. */
  effectiveImage: string | null;
  canApply: boolean;
  reason: string | null;
  alreadyApplied: boolean;
}
