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

/** Réseau Docker de l'hôte (liste, sans les conteneurs attachés : la console les déduit des conteneurs). */
export const NetworkInfoSchema = z.object({
  name: z.string().min(1).max(128),
  driver: z.string().max(40),
  scope: z.string().max(20),
  /** Réseau sans accès à l'extérieur (option « internal »). */
  internal: z.boolean().default(false),
  /** Projet Compose qui a créé ce réseau, s'il y en a un. */
  project: z.string().max(128).optional(),
});
export type NetworkInfo = z.infer<typeof NetworkInfoSchema>;

export const InventorySchema = z.object({
  observedAt: z.iso.datetime(),
  dockerVersion: z.string(),
  containers: z.array(ContainerSchema).max(5000),
  hostInfo: HostInfoSchema.optional(),
  images: z.array(ImageInfoSchema).max(2000).optional(),
  /** Réseaux de l'hôte ; absent si l'agent ne sait pas les lister (ancienne version). */
  networks: z.array(NetworkInfoSchema).max(300).optional(),
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
  /** Tous les gestionnaires de paquets présents (le premier est aussi dans `packageManager`). */
  packageManagers: z.array(z.string().max(20)).max(10).default([]),
  /** Identifiant de la distribution (`/etc/os-release` : alpine, debian…), s'il est lisible. */
  os: z.string().max(40).optional(),
  /** Utilisateur du conteneur (`Config.User`) ; vide = root. */
  user: z.string().max(100).default(""),
  shell: z.boolean().default(false),
});

/** Résultat d'une action sur un conteneur isolé (démarrer, arrêter, redémarrer). */
export const ContainerActionResultSchema = z.object({
  type: z.literal("container_action_result"),
  actionId: z.uuid(),
  status: z.enum(["succeeded", "failed"]),
  /** Présent seulement en cas d'échec. */
  error: z.string().max(300).optional(),
});

/** Ce que la suppression d'une application retirerait de l'hôte, observé par l'agent (rien n'est modifié). */
export const RemovalPlanResultSchema = z.object({
  type: z.literal("removal_plan_result"),
  planId: z.uuid(),
  error: z.string().max(300).optional(),
  /** Conteneurs du projet (arrêtés ou non) : `running` > 0 interdit la suppression. */
  containers: z.array(z.object({ id: z.string().max(80), name: z.string().max(200), state: z.string().max(30), image: z.string().max(300) })).max(200).default([]),
  running: z.number().int().min(0).default(0),
  /** Réseaux créés par le projet (jamais les réseaux externes). */
  networks: z.array(z.object({ id: z.string().max(80), name: z.string().max(200) })).max(100).default([]),
  /** Volumes nommés du projet, avec leur taille si Docker l'a fournie. */
  volumes: z.array(z.object({ name: z.string().max(255), sizeBytes: z.number().min(0).nullable() })).max(200).default([]),
  /** Images des conteneurs du projet ; `usedByOthers` = conteneurs d'autres projets qui les utilisent (alors non supprimables). */
  images: z.array(z.object({ ref: z.string().max(300), id: z.string().max(100), usedByOthers: z.number().int().min(0) })).max(100).default([]),
  /** Dossiers de l'hôte montés dans les conteneurs : jamais supprimés par la console. */
  binds: z.array(z.string().max(500)).max(100).default([]),
  /** Le dossier de travail de la stack (Compose, .env, Dockerfiles) existe sur l'hôte. */
  workspace: z.boolean().default(false),
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

export const MAX_STORAGE_VOLUMES = 200;
export const MAX_STORAGE_BINDS = 100;

/**
 * Taille sur le disque des montages d'un hôte : volumes nommés (d'après `/system/df`) et dossiers ou fichiers « bind »
 * (mesurés par un conteneur éphémère en lecture seule). Une taille `null` = non mesurée (`note` en donne la raison).
 */
export const StorageUsageMessageSchema = z.object({
  type: z.literal("storage_usage"),
  requestId: z.string().max(80),
  observedAt: z.iso.datetime(),
  volumes: z.array(z.object({ name: z.string().max(255), sizeBytes: z.number().min(0).nullable() })).max(MAX_STORAGE_VOLUMES),
  binds: z.array(z.object({ path: z.string().max(500), sizeBytes: z.number().min(0).nullable(), note: z.string().max(200).optional() })).max(MAX_STORAGE_BINDS),
});
export type StorageUsageMessage = z.infer<typeof StorageUsageMessageSchema>;

export const PRUNE_PHASES =["containers", "networks", "images", "volumes", "buildCache"] as const;
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
  /** Nature du constat : paquet du système (os) ou dépendance applicative (lang). Absent sur les anciens scans. */
  kind: z.enum(["os", "lang"]).optional(),
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

/** Version et base de Trivy utilisées pour un scan. */
const TrivyInfoSchema = z.object({
  version: z.string().max(40),
  dbVersion: z.number().int().optional(),
  dbUpdatedAt: z.string().max(40).optional(),
  dbDownloadedAt: z.string().max(40).optional(),
});

/** Constat allégé (sans titre ni lien) : un rapport avant/après en contient jusqu'à 2 x 2000, sous la limite des messages. */
export const PatchVulnerabilitySchema = VulnerabilitySchema.pick({ id: true, pkg: true, installed: true, fixed: true, severity: true, kind: true });
export type PatchVulnerability = z.infer<typeof PatchVulnerabilitySchema>;

/** Résultat normalisé d'un scan de l'image avant ou après correctif (mêmes options Trivy des deux côtés). */
export const PatchScanSchema = z.object({
  trivy: TrivyInfoSchema.optional(),
  os: z.object({ family: z.string().max(40), name: z.string().max(80), eosl: z.boolean().optional() }).optional(),
  counts: SeverityCountsSchema,
  total: z.number().int().min(0),
  vulnerabilities: z.array(PatchVulnerabilitySchema).max(MAX_SCAN_VULNERABILITIES),
  truncated: z.boolean().optional(),
});
export type PatchScan = z.infer<typeof PatchScanSchema>;

export const PATCH_STAGES = ["preparing", "scanning_before", "patching", "scanning_after", "verifying"] as const;
export type PatchStage = (typeof PATCH_STAGES)[number];

/** Progression d'un correctif (étape en cours), pour le suivi et le journal. */
export const PatchProgressSchema = z.object({
  type: z.literal("patch_progress"),
  jobId: z.uuid(),
  stage: z.enum(PATCH_STAGES),
  message: z.string().max(300).optional(),
});
export type PatchProgress = z.infer<typeof PatchProgressSchema>;

export const PatchPackageChangeSchema = z.object({ name: z.string().max(200), from: z.string().max(120), to: z.string().max(120) });
export type PatchPackageChange = z.infer<typeof PatchPackageChangeSchema>;

export const MAX_PATCH_PACKAGES = 2000;

/**
 * Résultat d'un correctif. Seules des données normalisées et bornées sont transmises : ni rapport brut, ni valeurs de
 * la configuration de l'image (les variables d'environnement peuvent contenir des secrets) : seuls les NOMS des champs
 * modifiés sont rapportés.
 */
export const PatchResultSchema = z.object({
  type: z.literal("patch_result"),
  jobId: z.uuid(),
  /** « cancelled » : arrêté à la demande de la console (rien n'est conservé que le registre n'ait déjà reçu). */
  status: z.enum(["succeeded", "failed", "cancelled"]),
  error: z.string().max(2000).optional(),
  /** Versions des outils utilisés (journalisées pour la provenance). */
  tools: z.object({ copa: z.string().max(60), buildkit: z.string().max(60), trivy: z.string().max(60) }).optional(),
  /** Copie de l'image source dans le registre (digest du manifeste publié). */
  source: z.object({ ref: z.string().max(400), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).optional(),
  patched: z.object({ ref: z.string().max(400), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).optional(),
  before: PatchScanSchema.optional(),
  after: PatchScanSchema.optional(),
  packageChanges: z.array(PatchPackageChangeSchema).max(MAX_PATCH_PACKAGES).optional(),
  /** Champs de configuration de l'image modifiés (Entrypoint, Cmd, User, Env…), sans leurs valeurs. */
  configChanges: z.array(z.string().max(40)).max(30).optional(),
  /** Libellés ajoutés par le moteur (BaseImage…). */
  labelsAdded: z.array(z.string().max(100)).max(30).optional(),
  /** Nombre de déclarations du document VEX produit par le moteur. */
  vexStatements: z.number().int().min(0).optional(),
});
export type PatchResult = z.infer<typeof PatchResultSchema>;

/**
 * Résultat du ramasse-miettes du registre géré (agent -> console). Seule la fin de la sortie est transmise.
 */
export const RegistryGcResultSchema = z.object({
  type: z.literal("registry_gc_result"),
  requestId: z.uuid(),
  status: z.enum(["succeeded", "failed"]),
  dryRun: z.boolean(),
  error: z.string().max(1000).optional(),
  /** Fin de la sortie du ramasse-miettes. */
  output: z.string().max(6000).optional(),
  /** Espace occupé par le stockage du registre avant / après, en Kio. */
  usedBeforeKb: z.number().int().min(0).optional(),
  usedAfterKb: z.number().int().min(0).optional(),
});
export type RegistryGcResult = z.infer<typeof RegistryGcResultSchema>;

export const AgentMessageSchema = z.discriminatedUnion("type", [
  RegistryGcResultSchema,
  PatchProgressSchema,
  PatchResultSchema,
  HelloSchema,
  HeartbeatSchema,
  InventoryMessageSchema,
  MetricsMessageSchema,
  ScanResultSchema,
  DiskUsageMessageSchema,
  StorageUsageMessageSchema,
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
  RemovalPlanResultSchema,
  ContainerActionResultSchema,
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
/**
 * Mesure de montages. L'agent ne mesure un chemin que s'il est la source d'un montage « bind » d'un conteneur existant :
 * la console ne peut pas lui faire parcourir un dossier quelconque.
 */
export const RequestStorageSchema = z.object({
  type: z.literal("request_storage"),
  requestId: z.string().max(80),
  volumes: z.array(z.string().max(255)).max(MAX_STORAGE_VOLUMES),
  binds: z.array(z.string().max(500)).max(MAX_STORAGE_BINDS),
});

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

/**
 * Identifiants d'un registre d'images privé, transmis à l'agent pour la durée d'une commande seulement
 * (jamais stockés sur l'hôte). `registry` est le nom canonique (Docker Hub : `docker.io`).
 */
export const RegistryAuthSchema = z.object({
  registry: z.string().min(1).max(255),
  username: z.string().min(1).max(255),
  password: z.string().min(1).max(1024),
});
export type RegistryAuth = z.infer<typeof RegistryAuthSchema>;

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
  action: z.enum(["deploy", "stop", "start", "destroy"]),
  stack: z.object({ id: z.uuid(), project: z.string() }),
  /** Pour `destroy` : ce qu'il faut retirer de l'hôte (les conteneurs du projet le sont toujours, à l'arrêt). */
  removal: z
    .object({
      networks: z.boolean(),
      /** Noms de volumes (doivent appartenir au projet : revérifié par l'agent). */
      volumes: z.array(z.string().max(255)).max(200),
      /** Références ou identifiants d'images (doivent être celles des conteneurs du projet et inutilisées ailleurs). */
      images: z.array(z.string().max(300)).max(100),
      /** Dossier de travail de la stack sur l'hôte (Compose, .env, Dockerfiles). */
      workspace: z.boolean(),
    })
    .optional(),
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
  /** Identifiants des registres privés utilisés par la révision (téléchargement et construction d'images). */
  registryAuths: z.array(RegistryAuthSchema).max(20).optional(),
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
  /** Identifiants du registre de l'image, s'il est privé et configuré. */
  registryAuths: z.array(RegistryAuthSchema).max(20).optional(),
});
export type ImagePullMessage = z.infer<typeof ImagePullSchema>;

/**
 * Démarre, arrête ou redémarre un conteneur précis (API Docker), hors cycle Compose. L'agent répond par
 * `container_action_result` et refuse les conteneurs de la console et de l'agent.
 */
export const ContainerActionSchema = z.object({
  type: z.literal("container_action"),
  actionId: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
  containerId: z.string().regex(/^[0-9a-f]{12,64}$/),
  action: z.enum(["start", "stop", "restart"]),
});
export type ContainerActionMessage = z.infer<typeof ContainerActionSchema>;

/** Demande ce que la suppression d'une application retirerait de l'hôte ; l'agent répond par `removal_plan_result`. */
export const RemovalPlanSchema = z.object({
  type: z.literal("removal_plan"),
  planId: z.uuid(),
  stack: z.object({ id: z.uuid(), project: z.string() }),
});
export type RemovalPlanMessage = z.infer<typeof RemovalPlanSchema>;

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

const REGISTRY_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/;
const REPOSITORY = /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * Corrige une image locale de l'hôte (jamais modifiée) : copie dans le registre cible, scan, correctif des paquets du
 * système par Copa + BuildKit, nouveau scan par digest. L'agent répond par `patch_progress` puis `patch_result`.
 * L'image est désignée par son identifiant local ; aucune commande ni option du moteur n'est transmise.
 */
export const PatchSchema = z.object({
  type: z.literal("patch"),
  jobId: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
  imageId: z.string().min(8).max(100).regex(/^(sha256:)?[0-9a-f]{12,64}$/),
  /** Référence lisible, pour les journaux uniquement. */
  imageRef: z.string().max(300),
  platform: z.string().regex(/^linux\/(amd64|arm64)$/),
  target: z.object({
    registry: z.string().max(255).regex(REGISTRY_HOST),
    repository: z.string().max(200).regex(REPOSITORY),
    /** Tag de la copie de l'image source. */
    sourceTag: z.string().regex(TAG),
    /** Tag (immuable) de l'image corrigée. */
    patchedTag: z.string().regex(TAG),
  }),
  /** Identifiants du registre cible (lecture et publication). */
  registryAuths: z.array(RegistryAuthSchema).max(5).optional(),
  timeoutSec: z.number().int().min(60).max(7200),
});
export type PatchMessage = z.infer<typeof PatchSchema>;

/**
 * Arrête un correctif en cours (ou en attente sur l'agent) : le processus en cours est tué, les conteneurs éphémères
 * sont supprimés et l'agent répond par un `patch_result` « cancelled ». Capacité `image.patch.cancel`.
 */
/**
 * Lance le ramasse-miettes du registre géré par la console (`registry garbage-collect`, commande fixe) dans son seul
 * conteneur (projet Compose « registry »). Aucun argument libre : seul `dryRun` (simulation) est transmis. Capacité
 * `registry.gc`.
 */
export const RegistryGcSchema = z.object({
  type: z.literal("registry_gc"),
  requestId: z.uuid(),
  expiresAt: z.iso.datetime().optional(),
  dryRun: z.boolean(),
});
export type RegistryGcMessage = z.infer<typeof RegistryGcSchema>;

export const PatchCancelSchema = z.object({ type: z.literal("patch_cancel"), jobId: z.uuid() });
export type PatchCancelMessage = z.infer<typeof PatchCancelSchema>;

export const ConsoleMessageSchema = z.discriminatedUnion("type", [
  PatchSchema,
  PatchCancelSchema,
  RegistryGcSchema,
  WelcomeSchema,
  ErrorMessageSchema,
  RequestInventorySchema,
  RequestDiskUsageSchema,
  RequestStorageSchema,
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
  RemovalPlanSchema,
  ContainerActionSchema,
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
