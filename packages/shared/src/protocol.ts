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
  /** Dernier démarrage du conteneur (ISO 8601), vide s'il n'a jamais démarré. */
  startedAt: z.string().max(40).optional(),
  exitCode: z.number().int().optional(),
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

export const MetricsMessageSchema = z.object({
  type: z.literal("metrics"),
  observedAt: z.iso.datetime(),
  samples: z.array(MetricSampleSchema).max(1000),
});

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
  OperationLogSchema,
  OperationResultSchema,
  LogChunkSchema,
  LogEndSchema,
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
});

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.enum(["bad_request", "unauthorized", "protocol_mismatch", "revoked"]),
  message: z.string(),
});

export const RequestInventorySchema = z.object({ type: z.literal("request_inventory") });

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
  stack: z.object({ id: z.uuid(), project: z.string() }),
  /** Service Compose ciblé ; tous les services si absent. */
  service: z.string().min(1).max(128).optional(),
  tail: z.number().int().min(0).max(1000),
});
export type LogsStartMessage = z.infer<typeof LogsStartSchema>;

export const LogsStopSchema = z.object({
  type: z.literal("logs_stop"),
  streamId: z.uuid(),
});

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
  RunSchema,
  ScanSchema,
  LogsStartSchema,
  LogsStopSchema,
]);
export type ConsoleMessage = z.infer<typeof ConsoleMessageSchema>;

// --- API ----------------------------------------------------------------

export const PasswordSchema = z.string().min(12).max(256);
export const UsernameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);

export const SetupRequestSchema = z.object({
  setupToken: z.string().min(1).max(256),
  username: UsernameSchema,
  password: PasswordSchema,
});

export const ChangeCredentialsSchema = z
  .object({
    currentPassword: z.string().min(1).max(256),
    newUsername: UsernameSchema.optional(),
    newPassword: PasswordSchema.optional(),
  })
  .refine((v) => v.newUsername !== undefined || v.newPassword !== undefined, {
    message: "Rien à modifier",
  });

export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
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
}
