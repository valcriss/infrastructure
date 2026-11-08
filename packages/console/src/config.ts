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
  /** Dossier persistant de la console : clé maître, dépôt de travail de la sauvegarde Git. */
  dataDir: string;
  /** Autorité de certification supplémentaire pour un serveur Git interne (optionnel). */
  gitCaFile: string | null;
  /** Période de collecte des métriques (secondes) et rétention des échantillons (jours). */
  metricsIntervalSec: number;
  metricsRetentionDays: number;
  /** Autorité de certification supplémentaire pour des registres d'images internes (optionnel). */
  registryCaFile: string | null;
  /** Clés d'accès (WebAuthn) : domaine de référence et origine exacte de la console. Désactivées si absents. */
  webauthnRpId?: string | null;
  webauthnOrigin?: string | null;
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
    dataDir: env.DATA_DIR ?? "/data",
    gitCaFile: env.GIT_CA_FILE || null,
    metricsIntervalSec: boundedInt(env.METRICS_INTERVAL_SEC, 30, 5, 3600, "METRICS_INTERVAL_SEC"),
    registryCaFile: env.REGISTRY_CA_FILE || null,
    webauthnRpId: env.WEBAUTHN_RP_ID || null,
    webauthnOrigin: env.WEBAUTHN_ORIGIN || null,
    metricsRetentionDays: boundedInt(env.METRICS_RETENTION_DAYS, 7, 1, 365, "METRICS_RETENTION_DAYS"),
  };
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} doit être un entier entre ${min} et ${max}`);
  return n;
}
