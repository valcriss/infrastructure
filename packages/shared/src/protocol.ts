import { z } from "zod";

/**
 * Protocole agent <-> console, version 1.
 * Actions typées uniquement : tout message hors de ces schémas est rejeté.
 */
export const PROTOCOL_VERSION = 1;

/** Taille maximale d'un message WebSocket accepté (octets). */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export const HEARTBEAT_INTERVAL_SEC = 15;
export const INVENTORY_INTERVAL_SEC = 60;
/** Période de collecte des métriques (paramétrable côté console). */
export const DEFAULT_METRICS_INTERVAL_SEC = 30;
/** Un hôte sans signe de vie depuis ce délai est considéré hors ligne. */
export const OFFLINE_AFTER_SEC = HEARTBEAT_INTERVAL_SEC * 3;

export const ContainerSchema = z.object({
  id: z.string().min(1),
  names: z.array(z.string()),
  image: z.string(),
  imageId: z.string(),
  state: z.string(),
  status: z.string(),
  created: z.number().int(),
  composeProject: z.string().optional(),
  composeService: z.string().optional(),
  /**
   * Healthcheck Docker : « none » = aucun healthcheck configuré (distinct de
   * « unhealthy ») ; absent = non renseigné par l'agent.
   */
  health: z.enum(["healthy", "unhealthy", "starting", "none"]).optional(),
  restartCount: z.number().int().min(0).optional(),
  /** Dernier test du healthcheck (conteneurs avec healthcheck uniquement) : sert à expliquer un échec. */
  healthProbe: z
    .object({
      exitCode: z.number().int(),
      output: z.string().max(600),
      at: z.string().max(40),
      /** Commande configurée (ex. « CMD-SHELL wget … »). */
      command: z.string().max(500).optional(),
      failingStreak: z.number().int().min(0).optional(),
      retries: z.number().int().min(0).optional(),
    })
    .optional(),
  /** Dernier démarrage du conteneur (ISO 8601), vide s'il n'a jamais démarré. */
  startedAt: z.string().max(40).optional(),
  exitCode: z.number().int().optional(),
  /** Ports publiés ou exposés (sans variables d'environnement ni configuration sensible). */
  ports: z.array(z.object({ privatePort: z.number().int(), publicPort: z.number().int().optional(), type: z.string().max(10), ip: z.string().max(64).optional() })).max(50).optional(),
  networks: z.array(z.string().max(128)).max(20).optional(),
  mounts: z.array(z.object({ type: z.string().max(20), source: z.string().max(500).optional(), destination: z.string().max(500), rw: z.boolean() })).max(50).optional(),
  /** Dossier du projet Compose et fichiers Compose, tels qu'indiqués par les libellés Docker (chemins de l'hôte). */
  composeWorkingDir: z.string().max(500).optional(),
  composeConfigFiles: z.string().max(1000).optional(),
});
export type Container = z.infer<typeof ContainerSchema>;

export const HostInfoSchema = z.object({
  cpus: z.number().int().min(0),
  memTotalBytes: z.number().min(0),
  os: z.string().max(200),
  serverVersion: z.string().max(64),
  containersRunning: z.number().int().min(0),
  containersPaused: z.number().int().min(0),
  containersStopped: z.number().int().min(0),
  images: z.number().int().min(0),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

/** Image locale utilisée par au moins un conteneur (pour les scans et le suivi des versions). */
export const ImageInfoSchema = z.object({
  /** Identifiant local (sha256:…). */
  id: z.string().min(1).max(100),
  /** Références `nom:tag` connues localement. */
  repoTags: z.array(z.string().max(300)).max(50),
  /** Digests de registre `nom@sha256:…` : vide pour une image construite ou chargée localement. */
  repoDigests: z.array(z.string().max(400)).max(50),
  size: z.number().min(0),
  /** Couches (diff_ids) : identité du contenu, indépendante de l'emballage index / manifeste du registre. */
  layers: z.array(z.string().max(100)).max(300).optional(),
  os: z.string().max(40).optional(),
  arch: z.string().max(40).optional(),
  variant: z.string().max(40).optional(),
});
export type ImageInfo = z.infer<typeof ImageInfoSchema>;

export const InventorySchema = z.object({
  observedAt: z.iso.datetime(),
  dockerVersion: z.string(),
  containers: z.array(ContainerSchema).max(5000),
  hostInfo: HostInfoSchema.optional(),
  images: z.array(ImageInfoSchema).max(2000).optional(),
});
export type Inventory = z.infer<typeof InventorySchema>;

export const AgentAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enrollment"), token: z.string().min(16).max(256) }),
  z.object({
    kind: z.literal("credentials"),
    agentId: z.uuid(),
    secret: z.string().min(16).max(256),
  }),
]);
export type AgentAuth = z.infer<typeof AgentAuthSchema>;

// --- Agent -> Console ---------------------------------------------------

export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number().int(),
  agentVersion: z.string().max(64),
  hostname: z.string().max(255),
  capabilities: z.array(z.string().max(64)).max(64),
  auth: AgentAuthSchema,
});

export const HeartbeatSchema = z.object({ type: z.literal("heartbeat") });

export const InventoryMessageSchema = z.object({
  type: z.literal("inventory"),
  inventory: InventorySchema,
});

export const OperationLogSchema = z.object({
  type: z.literal("operation_log"),
  operationId: z.uuid(),
  text: z.string().max(32 * 1024),
});

export const ImageUsedSchema = z.object({
  service: z.string(),
  image: z.string(),
  imageId: z.string(),
  repoDigests: z.array(z.string()),
});
export type ImageUsed = z.infer<typeof ImageUsedSchema>;

export const ServiceStateSchema = z.object({
  service: z.string(),
  state: z.string(),
  health: z.string().optional(),
});
export type ServiceState = z.infer<typeof ServiceStateSchema>;

export const OperationResultSchema = z.object({
  type: z.literal("operation_result"),
  operationId: z.uuid(),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().max(4096).optional(),
  /** Images réellement utilisées après un déploiement (digests inclus). */
  images: z.array(ImageUsedSchema).max(200).optional(),
  /** État observé après exécution, distinct du succès de la commande Compose. */
  services: z.array(ServiceStateSchema).max(200).optional(),
});

/** Lignes de logs d'un flux demandé par la console (suivi en direct). */
export const LogChunkSchema = z.object({
  type: z.literal("log_chunk"),
  streamId: z.uuid(),
  lines: z.array(z.string().max(8192)).max(500),
});

export const LogEndSchema = z.object({
  type: z.literal("log_end"),
  streamId: z.uuid(),
  reason: z.string().max(200),
});

// --- Terminal de conteneur ---------------------------------------------------------------------------

/** Octets d'entrée/sortie d'un terminal : encodés en base64 ; au plus 48 Kio par message. */
export const TERMINAL_MAX_CHUNK_BYTES = 48 * 1024;
const TerminalData = z.string().max(Math.ceil((TERMINAL_MAX_CHUNK_BYTES * 4) / 3) + 8);
const TerminalSize = { cols: z.number().int().min(10).max(500), rows: z.number().int().min(2).max(200) };

/** Sortie du terminal (agent -> console). */
export const TerminalDataSchema = z.object({ type: z.literal("terminal_data"), sessionId: z.uuid(), data: TerminalData });
/** Fin d'une session de terminal (shell terminé, refus, erreur, fermeture demandée). */
export const TerminalEndSchema = z.object({
  type: z.literal("terminal_end"),
  sessionId: z.uuid(),
  reason: z.string().max(300),
  exitCode: z.number().int().optional(),
});

// --- Sonde d'outils d'un conteneur, téléchargement d'images candidates ---------------------------------

/** Résultat de la sonde : quels outils (curl, wget, node…) existent dans le conteneur, pour proposer un healthcheck réalisable. */
export const ToolsResultSchema = z.object({
  type: z.literal("tools_result"),
  probeId: z.uuid(),
  /** Présent seulement en cas d'échec (conteneur introuvable, protégé, sans shell…). */
  error: z.string().max(300).optional(),
  tools: z.array(z.string().max(40)).max(40).default([]),
  /** Gestionnaire de paquets trouvé (apk, apt-get, dnf, yum…), pour un Dockerfile adapté. */
  packageManager: z.string().max(20).optional(),
  /** Utilisateur du conteneur (`Config.User`) ; vide = root. */
  user: z.string().max(100).default(""),
  shell: z.boolean().default(false),
});

/** Téléchargement d'une image (pour comparer ses vulnérabilités avant de l'adopter). */
export const ImagePullResultSchema = z.object({
  type: z.literal("image_pull_result"),
  pullId: z.uuid(),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().max(500).optional(),
  imageId: z.string().max(100).optional(),
  platform: z.string().max(60).optional(),
});

/** Échantillon de métriques d'un conteneur en cours d'exécution. */
export const MetricSampleSchema = z.object({
  containerId: z.string().min(1).max(80),
  name: z.string().max(200),
  project: z.string().max(100).optional(),
  service: z.string().max(200).optional(),
  /** Pourcentage de CPU (100 = un cœur) sur la période écoulée ; null au premier échantillon. */
  cpuPercent: z.number().min(0).nullable(),
  memBytes: z.number().min(0),
  memLimitBytes: z.number().min(0),
  /** Compteurs réseau cumulés depuis le démarrage du conteneur (octets). */
  netRxBytes: z.number().min(0),
  netTxBytes: z.number().min(0),
});
export type MetricSample = z.infer<typeof MetricSampleSchema>;

/** Utilisation de la machine hôte (CPU global, mémoire, disque de l'espace de travail). Champs absents si non mesurables. */
export const HostMetricsSchema = z.object({
  /** Pourcentage de l'ensemble des cœurs (0 à 100) ; null au premier relevé. */
  cpuPercent: z.number().min(0).max(100).nullable(),
  memTotalBytes: z.number().min(0).optional(),
  memUsedBytes: z.number().min(0).optional(),
  diskTotalBytes: z.number().min(0).optional(),
  diskUsedBytes: z.number().min(0).optional(),
});
export type HostMetrics = z.infer<typeof HostMetricsSchema>;

export const MetricsMessageSchema = z.object({
  type: z.literal("metrics"),
  observedAt: z.iso.datetime(),
  samples: z.array(MetricSampleSchema).max(1000),
  host: HostMetricsSchema.optional(),
});

// --- Espace disque Docker et nettoyage -------------------------------------------------------------

const UsageSchema = z.object({ count: z.number().int().min(0), sizeBytes: z.number().min(0), reclaimableBytes: z.number().min(0) });
export type DiskUsageEntry = z.infer<typeof UsageSchema>;

/** Le cache de build compte souvent des milliers d'entrées : on les garde presque toutes pour un aperçu exact des filtres d'âge. */
export const MAX_BUILD_CACHE_CANDIDATES = 5000;

/** Candidats au nettoyage : uniquement ce qui n'est utilisé par aucun conteneur actif et n'appartient pas à la console. */
export const DiskCandidatesSchema = z.object({
  containers: z.array(z.object({ id: z.string().max(80), name: z.string().max(200), image: z.string().max(300), project: z.string().max(100).optional(), service: z.string().max(200).optional(), state: z.string().max(30), created: z.number().int(), sizeBytes: z.number().min(0).nullable() })).max(300),
  images: z.array(z.object({ id: z.string().max(100), ref: z.string().max(300), created: z.number().int(), sizeBytes: z.number().min(0), dangling: z.boolean() })).max(300),
  networks: z.array(z.object({ id: z.string().max(80), name: z.string().max(200), created: z.string().max(40).nullable() })).max(300),
  volumes: z.array(z.object({ name: z.string().max(255), sizeBytes: z.number().min(0).nullable(), anonymous: z.boolean(), created: z.string().max(40).nullable(), project: z.string().max(100).optional() })).max(300),
  buildCache: z.array(z.object({ id: z.string().max(80), type: z.string().max(40), description: z.string().max(200).optional(), sizeBytes: z.number().min(0), lastUsedAt: z.string().max(40).nullable() })).max(MAX_BUILD_CACHE_CANDIDATES),
});
export type DiskCandidates = z.infer<typeof DiskCandidatesSchema>;

/** Équivalent de `docker system df` : totaux et part récupérable, plus la liste de ce qui pourrait être supprimé. */
export const DiskUsageMessageSchema = z.object({
  type: z.literal("disk_usage"),
  observedAt: z.iso.datetime(),
  summary: z.object({ images: UsageSchema, containers: UsageSchema, volumes: UsageSchema, buildCache: UsageSchema }),
  candidates: DiskCandidatesSchema,
  /** Une liste a été tronquée (les plus volumineux sont conservés). */
  truncated: z.boolean(),
});
export type DiskUsageMessage = z.infer<typeof DiskUsageMessageSchema>;

export const PRUNE_PHASES = ["containers", "networks", "images", "volumes", "buildCache"] as const;
export type PrunePhase = (typeof PRUNE_PHASES)[number];

/** Avancement d'un nettoyage : phase en cours, élément en cours de suppression, compteurs. Envoyé à intervalles réguliers. */
export const PruneProgressSchema = z.object({
  type: z.literal("prune_progress"),
  operationId: z.uuid(),
  phase: z.enum(PRUNE_PHASES),
  /** Éléments traités / à traiter dans cette phase (le cache de build est supprimé d'un seul bloc). */
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  /** Nom de l'élément en cours de suppression. */
  current: z.string().max(200).optional(),
  /** Avancement global, toutes phases confondues. */
  overall: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }),
  removed: z.object({ containers: z.number().int().min(0), images: z.number().int().min(0), networks: z.number().int().min(0), volumes: z.number().int().min(0), buildCache: z.number().int().min(0) }),
  reclaimedBytes: z.number().min(0),
  /** Taille du cache de build ciblé (suppression sans détail intermédiaire). */
  buildCacheBytes: z.number().min(0).optional(),
});
export type PruneProgress = z.infer<typeof PruneProgressSchema>;

export const PruneResultSchema = z.object({
  type: z.literal("prune_result"),
  operationId: z.uuid(),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().max(2000).optional(),
  removed: z.object({ containers: z.number().int().min(0), images: z.number().int().min(0), networks: z.number().int().min(0), volumes: z.number().int().min(0), buildCache: z.number().int().min(0) }),
  /** Espace libéré : estimation d'après la taille des éléments supprimés, valeur mesurée par Docker pour le cache de build. */
  reclaimedBytes: z.number().min(0),
  /** Éléments demandés mais non supprimés par prudence (protégés, devenus utilisés, plus candidats). */
  skipped: z.array(z.string().max(300)).max(100),
  errors: z.array(z.string().max(300)).max(100),
});
export type PruneResult = z.infer<typeof PruneResultSchema>;

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** Nombre maximal de vulnérabilités détaillées renvoyées pour un scan (les compteurs restent exacts). */
export const MAX_SCAN_VULNERABILITIES = 2000;

export const VulnerabilitySchema = z.object({
  id: z.string().max(80),
  pkg: z.string().max(200),
  installed: z.string().max(120),
  fixed: z.string().max(300).nullable(),
  severity: z.enum(SEVERITIES),
  title: z.string().max(300),
  url: z.string().max(300).nullable(),
  /** Statut Trivy (fixed, affected, will_not_fix…). */
  status: z.string().max(40).optional(),
});
export type Vulnerability = z.infer<typeof VulnerabilitySchema>;

export const SeverityCountsSchema = z.object({
  critical: z.number().int().min(0),
  high: z.number().int().min(0),
  medium: z.number().int().min(0),
  low: z.number().int().min(0),
  unknown: z.number().int().min(0),
});
export type SeverityCounts = z.infer<typeof SeverityCountsSchema>;

/**
 * Résultat d'un scan Trivy. Seules des données normalisées et bornées sont
 * transmises : jamais la sortie brute (qui contient la configuration de l'image,
 * donc potentiellement des variables d'environnement sensibles).
 */
export const ScanResultSchema = z.object({
  type: z.literal("scan_result"),
  scanId: z.uuid(),
  status: z.enum(["succeeded", "failed"]),
  error: z.string().max(2000).optional(),
  trivy: z
    .object({
      version: z.string().max(40),
      dbVersion: z.number().int().optional(),
      dbUpdatedAt: z.string().max(40).optional(),
      dbDownloadedAt: z.string().max(40).optional(),
    })
    .optional(),
  os: z.object({ family: z.string().max(40), name: z.string().max(80), eosl: z.boolean().optional() }).optional(),
  counts: SeverityCountsSchema.optional(),
  total: z.number().int().min(0).optional(),
  vulnerabilities: z.array(VulnerabilitySchema).max(MAX_SCAN_VULNERABILITIES).optional(),
  truncated: z.boolean().optional(),
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

export const AgentMessageSchema = z.discriminatedUnion("type", [
  HelloSchema,
  HeartbeatSchema,
  InventoryMessageSchema,
  MetricsMessageSchema,
  ScanResultSchema,
  DiskUsageMessageSchema,
  PruneProgressSchema,
  PruneResultSchema,
  OperationLogSchema,
  OperationResultSchema,
  LogChunkSchema,
  LogEndSchema,
  TerminalDataSchema,
  TerminalEndSchema,
  ToolsResultSchema,
  ImagePullResultSchema,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// --- Console -> Agent ---------------------------------------------------

export const WelcomeSchema = z.object({
  type: z.literal("welcome"),
  protocol: z.number().int(),
  agentId: z.uuid(),
  /** Présent uniquement après un enrôlement réussi. */
  credentials: z.object({ agentId: z.uuid(), secret: z.string() }).optional(),
  heartbeatIntervalSec: z.number().int().positive(),
  inventoryIntervalSec: z.number().int().positive(),
  metricsIntervalSec: z.number().int().positive().optional(),
  /** Heure de la console : l'agent en déduit son décalage d'horloge pour juger l'échéance des demandes. */
  serverTime: z.iso.datetime().optional(),
});

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.enum(["bad_request", "unauthorized", "protocol_mismatch", "revoked"]),
  message: z.string(),
});

export const RequestInventorySchema = z.object({ type: z.literal("request_inventory") });
export const RequestDiskUsageSchema = z.object({ type: z.literal("request_disk_usage") });

/** Éléments à supprimer, désignés un par un : l'agent ne supprime que ce qui reste candidat au moment de l'exécution. */
export const PruneSchema = z.object({
  type: z.literal("prune"),
  operationId: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
  targets: z.object({
    containers: z.array(z.string().regex(/^[0-9a-f]{12,64}$/)).max(300),
    images: z.array(z.string().regex(/^(sha256:)?[0-9a-f]{12,64}$/)).max(300),
    networks: z.array(z.string().regex(/^[0-9a-f]{12,64}$/)).max(300),
    volumes: z.array(z.string().min(1).max(255)).max(300),
    buildCache: z.object({ mode: z.enum(["all", "older"]), olderThanHours: z.number().int().min(1).max(87600).optional(), keepBytes: z.number().min(0).optional() }).optional(),
  }),
});
export type PruneMessage = z.infer<typeof PruneSchema>;

/** Contenu figé d'une révision, transmis à l'agent pour un déploiement. */
export const RevisionPayloadSchema = z.object({
  number: z.number().int().positive(),
  compose: z.string(),
  /** Variables d'interpolation de stack (nom -> valeur). */
  variables: z.record(z.string(), z.string()),
  /** Noms des variables sensibles : leurs valeurs sont masquées dans les logs. */
  sensitive: z.array(z.string()),
  files: z.record(z.string(), z.string()),
});
export type RevisionPayload = z.infer<typeof RevisionPayloadSchema>;

export const RunSchema = z.object({
  type: z.literal("run"),
  operationId: z.uuid(),
  /** Échéance de la demande : l'agent refuse une demande reçue après cette date. */
  expiresAt: z.iso.datetime().optional(),
  action: z.enum(["deploy", "stop", "start"]),
  stack: z.object({ id: z.uuid(), project: z.string() }),
  /** Obligatoire pour `deploy`, absent pour `stop` et `start`. */
  revision: RevisionPayloadSchema.optional(),
  options: z
    .object({
      pullImages: z.boolean(),
      forceRecreate: z.boolean(),
      /**
       * Premier déploiement d'une stack importée : autorise l'agent à reprendre
       * un projet Compose existant (sans supprimer les services hors Compose).
       */
      adoptExisting: z.boolean().optional(),
    })
    .optional(),
});
export type RunMessage = z.infer<typeof RunSchema>;

export const LogsStartSchema = z.object({
  type: z.literal("logs_start"),
  streamId: z.uuid(),
  /** Stack gérée par la console. Absente pour les logs d'un conteneur d'un projet observé (voir `containerId`). */
  stack: z.object({ id: z.uuid(), project: z.string() }).optional(),
  /** Conteneur d'un projet non géré : l'agent suit ses logs avec `docker logs`. */
  containerId: z.string().regex(/^[0-9a-f]{12,64}$/).optional(),
  /** Service Compose ciblé ; tous les services si absent. */
  service: z.string().min(1).max(128).optional(),
  tail: z.number().int().min(0).max(1000),
});
export type LogsStartMessage = z.infer<typeof LogsStartSchema>;

export const LogsStopSchema = z.object({
  type: z.literal("logs_stop"),
  streamId: z.uuid(),
});

/** Ouvre un shell interactif (`docker exec` avec terminal) dans un conteneur. L'agent refuse ceux de la console et de l'agent. */
export const TerminalOpenSchema = z.object({
  type: z.literal("terminal_open"),
  sessionId: z.uuid(),
  containerId: z.string().regex(/^[0-9a-f]{12,64}$/),
  ...TerminalSize,
});
export const TerminalInputSchema = z.object({ type: z.literal("terminal_input"), sessionId: z.uuid(), data: TerminalData });
export const TerminalResizeSchema = z.object({ type: z.literal("terminal_resize"), sessionId: z.uuid(), ...TerminalSize });
export const TerminalCloseSchema = z.object({ type: z.literal("terminal_close"), sessionId: z.uuid() });
export type TerminalOpenMessage = z.infer<typeof TerminalOpenSchema>;

/** Quels outils existent dans ce conteneur ? (lecture seule : simples tests de présence, rien n'est modifié) */
export const ToolsProbeSchema = z.object({
  type: z.literal("tools_probe"),
  probeId: z.uuid(),
  containerId: z.string().regex(/^[0-9a-f]{12,64}$/),
});

/** Télécharge une image du registre sur l'hôte (`docker pull`) ; l'agent répond par `image_pull_result`. */
export const ImagePullSchema = z.object({
  type: z.literal("image_pull"),
  pullId: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
  ref: z.string().min(1).max(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/),
});
export type ImagePullMessage = z.infer<typeof ImagePullSchema>;

/** Supprime une image téléchargée pour comparaison (sans forcer : refusée si un conteneur l'utilise). */
export const ImageRemoveSchema = z.object({ type: z.literal("image_remove"), imageId: z.string().min(8).max(100).regex(/^(sha256:)?[0-9a-f]{12,64}$/) });

/** Demande de scan d'une image locale (par identifiant) avec Trivy. */
export const ScanSchema = z.object({
  type: z.literal("scan"),
  scanId: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
  imageId: z.string().min(8).max(100).regex(/^(sha256:)?[0-9a-f]{12,64}$/),
  /** Référence lisible, pour les journaux uniquement. */
  imageRef: z.string().max(300),
});
export type ScanMessage = z.infer<typeof ScanSchema>;

export const ConsoleMessageSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  ErrorMessageSchema,
  RequestInventorySchema,
  RequestDiskUsageSchema,
  PruneSchema,
  RunSchema,
  ScanSchema,
  LogsStartSchema,
  LogsStopSchema,
  TerminalOpenSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalCloseSchema,
  ToolsProbeSchema,
  ImagePullSchema,
  ImageRemoveSchema,
]);
export type ConsoleMessage = z.infer<typeof ConsoleMessageSchema>;

// --- API ----------------------------------------------------------------

export const PasswordSchema = z.string().min(12).max(256);
export const UsernameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);

/** Identifiant de connexion : l'e-mail (ou, pour un ancien compte, son identifiant d'origine). */
export const LoginIdSchema = z.string().trim().min(3).max(254);
export const SetupRequestSchema = z.object({
  setupToken: z.string().min(1).max(256),
  username: LoginIdSchema,
  password: PasswordSchema,
});

export const ChangeCredentialsSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
    newPassword: PasswordSchema.optional(),
  })
  .refine((v) => v.newEmail !== undefined || v.newPassword !== undefined, {
    message: "Rien à modifier",
  });

export const LoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
  /** Code à usage unique (TOTP) ou code de secours, si le compte en a un. */
  code: z.string().trim().min(6).max(16).optional(),
});

export type HostPresence = "online" | "offline" | "pending";

export interface HostSummary {
  id: string;
  name: string;
  agentVersion: string | null;
  capabilities: string[];
  presence: HostPresence;
  lastSeenAt: string | null;
  dockerVersion: string | null;
  inventoryObservedAt: string | null;
  containerCount: number | null;
  /** Dernier relevé de l'espace disque Docker (équivalent de `docker system df`), null avant le premier. */
  diskUsage: { observedAt: string; summary: DiskUsageMessage["summary"]; truncated: boolean } | null;
}
