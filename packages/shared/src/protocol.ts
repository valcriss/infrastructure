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
});
export type Container = z.infer<typeof ContainerSchema>;

export const InventorySchema = z.object({
  observedAt: z.iso.datetime(),
  dockerVersion: z.string(),
  containers: z.array(ContainerSchema).max(5000),
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

export const AgentMessageSchema = z.discriminatedUnion("type", [
  HelloSchema,
  HeartbeatSchema,
  InventoryMessageSchema,
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
});

export const ErrorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.enum(["bad_request", "unauthorized", "protocol_mismatch", "revoked"]),
  message: z.string(),
});

export const RequestInventorySchema = z.object({ type: z.literal("request_inventory") });

export const ConsoleMessageSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  ErrorMessageSchema,
  RequestInventorySchema,
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
