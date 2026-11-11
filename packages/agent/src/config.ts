export interface AgentConfig {
  consoleUrl: string;
  stateDir: string;
  bootstrapTokenFile: string;
  enrollmentToken: string | null;
  dockerSocket: string;
  hostname: string;
  /** Doit être monté au même chemin absolu dans le conteneur et sur l'hôte. */
  workspaceDir: string;
  /** Scans de vulnérabilités : image Trivy (épinglée), mémoire du conteneur, taille maximale d'image. */
  trivyImage: string;
  trivyMemory: string;
  trivyMaxImageBytes: number;
  /** Correctifs d'images : image du runner Copa (CI de ce dépôt), BuildKit rootless officiel, mémoire de BuildKit. */
  patcherImage: string;
  buildkitImage: string;
  /** Repli explicite et privilégié pour les hôtes qui interdisent les espaces de noms utilisateur (BUILDKIT_PRIVILEGED=1). */
  buildkitPrivileged: boolean;
  buildkitPrivilegedImage: string;
  buildkitMemory: string;
  /** Projets Compose que la console ne peut ni arrêter ni redéployer (en plus du projet de l'agent lui-même). */
  protectedProjects: string[];
  /** Conteneur de l'agent (HOSTNAME dans Docker), pour retrouver son projet Compose. */
  selfContainer: string | undefined;
}

export const AGENT_VERSION = "0.0.0";
/** Version stable de Trivy vérifiée à l'implémentation ; surchargeable avec TRIVY_IMAGE. */
export const DEFAULT_TRIVY_IMAGE = "ghcr.io/aquasecurity/trivy:0.76.1";
/** Runner Copa publié par la CI du dépôt ; fixez une version (PATCHER_IMAGE) pour un déploiement reproductible. */
export const DEFAULT_PATCHER_IMAGE = "ghcr.io/valcriss/infrastructure-patcher:latest";
/** BuildKit rootless officiel, version éprouvée au spike (ADR 0002). */
export const DEFAULT_BUILDKIT_IMAGE = "moby/buildkit:v0.35.0-rootless";
/** Même version, variante classique : réservée au repli privilégié explicite. */
export const DEFAULT_BUILDKIT_PRIVILEGED_IMAGE = "moby/buildkit:v0.35.0";
/** Volume nommé qui conserve la base de vulnérabilités entre les scans. */
export const TRIVY_CACHE_VOLUME = "console-docker-trivy-cache";

/** Taille maximale d'une image scannée : TRIVY_MAX_IMAGE_GB (Gio), sinon TRIVY_MAX_IMAGE_BYTES, sinon 10 Gio. */
export const DEFAULT_TRIVY_MAX_IMAGE_BYTES = 10 * 1024 ** 3;
export function maxImageBytes(env: NodeJS.ProcessEnv): number {
  const gb = Number(env.TRIVY_MAX_IMAGE_GB);
  if (gb > 0) return Math.round(gb * 1024 ** 3);
  const bytes = Number(env.TRIVY_MAX_IMAGE_BYTES);
  return bytes > 0 ? bytes : DEFAULT_TRIVY_MAX_IMAGE_BYTES;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const consoleUrl = env.CONSOLE_URL;
  if (!consoleUrl) throw new Error("CONSOLE_URL est requis (ex. ws://console:8080/agent/ws)");
  const url = new URL(consoleUrl);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("CONSOLE_URL doit commencer par ws:// ou wss://");
  }
  return {
    consoleUrl,
    stateDir: env.STATE_DIR ?? "/data",
    bootstrapTokenFile: env.BOOTSTRAP_TOKEN_FILE ?? "/shared/bootstrap-token",
    enrollmentToken: env.ENROLLMENT_TOKEN?.trim() || null,
    dockerSocket: env.DOCKER_SOCKET ?? "/var/run/docker.sock",
    hostname: env.AGENT_HOSTNAME ?? process.env.HOSTNAME ?? "agent",
    workspaceDir: env.WORKSPACE_DIR ?? "/var/lib/console-docker/workspace",
    trivyImage: env.TRIVY_IMAGE ?? DEFAULT_TRIVY_IMAGE,
    trivyMemory: /^[0-9]+[kmg]$/i.test(env.TRIVY_MEMORY ?? "") ? (env.TRIVY_MEMORY as string) : "2g",
    trivyMaxImageBytes: maxImageBytes(env),
    patcherImage: env.PATCHER_IMAGE ?? DEFAULT_PATCHER_IMAGE,
    buildkitImage: env.BUILDKIT_IMAGE ?? DEFAULT_BUILDKIT_IMAGE,
    buildkitPrivileged: ["1", "true"].includes((env.BUILDKIT_PRIVILEGED ?? "").toLowerCase()),
    buildkitPrivilegedImage: env.BUILDKIT_PRIVILEGED_IMAGE ?? DEFAULT_BUILDKIT_PRIVILEGED_IMAGE,
    buildkitMemory: /^[0-9]+[kmg]$/i.test(env.BUILDKIT_MEMORY ?? "") ? (env.BUILDKIT_MEMORY as string) : "3g",
    protectedProjects: (env.PROTECTED_PROJECTS ?? "").split(",").map((p) => p.trim()).filter(Boolean),
    selfContainer: env.HOSTNAME,
  };
}
