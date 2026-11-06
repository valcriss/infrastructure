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
}

export const AGENT_VERSION = "0.0.0";
/** Version stable de Trivy vérifiée à l'implémentation ; surchargeable avec TRIVY_IMAGE. */
export const DEFAULT_TRIVY_IMAGE = "ghcr.io/aquasecurity/trivy:0.76.1";
/** Volume nommé qui conserve la base de vulnérabilités entre les scans. */
export const TRIVY_CACHE_VOLUME = "console-docker-trivy-cache";

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
    trivyMaxImageBytes: Number(env.TRIVY_MAX_IMAGE_BYTES) > 0 ? Number(env.TRIVY_MAX_IMAGE_BYTES) : 5 * 1024 ** 3,
  };
}
