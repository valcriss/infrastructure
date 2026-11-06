export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  /** Dossier partagé avec l'agent local pour l'amorçage (jeton d'enrôlement). */
  sharedDir: string;
  /** Dossier du frontend compilé ; null pour ne pas le servir. */
  webDir: string | null;
  /** Cookie `Secure` : à activer dès que la console est servie en HTTPS. */
  secureCookies: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL est requis");
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT invalide");
  }
  return {
    host: env.HOST ?? "0.0.0.0",
    port,
    databaseUrl,
    sharedDir: env.SHARED_DIR ?? "/shared",
    webDir: env.WEB_DIR === "" ? null : (env.WEB_DIR ?? null),
    secureCookies: env.SECURE_COOKIES === "true",
  };
}
