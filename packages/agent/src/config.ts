export interface AgentConfig {
  consoleUrl: string;
  stateDir: string;
  bootstrapTokenFile: string;
  enrollmentToken: string | null;
  dockerSocket: string;
  hostname: string;
}

export const AGENT_VERSION = "0.0.0";

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
  };
}
