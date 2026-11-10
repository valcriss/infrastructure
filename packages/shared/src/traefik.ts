/**
 * Génération d'une application Traefik préconfigurée (Compose + fichiers de configuration).
 *
 * Choix de l'assistant : fournisseur Docker et fournisseur de fichiers, défi ACME HTTP-01 (port 80), tableau de bord
 * désactivé, version de l'image fixée. Le dossier `dynamic/` est monté en entier (et non un fichier seul) : un
 * fichier remplacé par un nouveau fichier n'est plus vu par un montage de fichier unique, ce qui casserait le
 * rechargement automatique de la configuration dynamique.
 */

/** Version fixée (pas de « latest ») ; le suivi des versions d'image proposera les suivantes. */
export const TRAEFIK_IMAGE = "traefik:v3.7.17";

/** Nom du projet Compose créé par l'assistant. */
export const TRAEFIK_STACK_NAME = "traefik";

export const TRAEFIK_STATIC_FILE = "traefik.yml";
export const TRAEFIK_DYNAMIC_FILE = "dynamic/dynamic.yml";

export interface TraefikOptions {
  /** Adresse utilisée par Let's Encrypt pour les avis d'expiration. */
  email: string;
  /** Certificats de production ; sinon l'autorité de test (certificats non reconnus, sans limite de débit). */
  production: boolean;
  httpEntryPoint: string;
  httpsEntryPoint: string;
  certResolver: string;
  network: {
    /** « create » : le réseau est créé avec l'application ; « existing » : il existe déjà sur l'hôte. */
    mode: "create" | "existing";
    name: string;
  };
}

export const TRAEFIK_DEFAULTS: TraefikOptions = {
  email: "",
  production: false,
  httpEntryPoint: "web",
  httpsEntryPoint: "websecure",
  certResolver: "letsencrypt",
  network: { mode: "create", name: "traefik-public" },
};

/** Nom d'entrypoint, de résolveur ou de réseau Docker : lettres, chiffres, « . », « _ » et « - ». */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const EMAIL = /^[^\s@"'<>\\]+@[^\s@"'<>\\]+\.[^\s@"'<>\\]+$/;
const PREDEFINED_NETWORKS = new Set(["bridge", "host", "none"]);

/** Première erreur de saisie, ou null. */
export function validateTraefikOptions(o: TraefikOptions): string | null {
  if (o.email.length === 0 || o.email.length > 254 || !EMAIL.test(o.email)) return "Adresse e-mail invalide.";
  const names: [string, string][] = [
    ["Entrypoint HTTP", o.httpEntryPoint],
    ["Entrypoint HTTPS", o.httpsEntryPoint],
    ["Résolveur de certificats", o.certResolver],
    ["Réseau", o.network.name],
  ];
  for (const [label, value] of names) {
    if (!IDENTIFIER.test(value)) return `${label} : lettres, chiffres, « . », « _ » et « - » seulement (63 caractères au plus, commence par une lettre ou un chiffre).`;
  }
  if (o.httpEntryPoint === o.httpsEntryPoint) return "Les entrypoints HTTP et HTTPS doivent avoir des noms différents.";
  if (PREDEFINED_NETWORKS.has(o.network.name)) return "Ce réseau est un réseau prédéfini de Docker : choisissez un réseau dédié.";
  if (o.network.mode !== "create" && o.network.mode !== "existing") return "Mode de réseau invalide.";
  return null;
}

export interface GeneratedTraefik {
  compose: string;
  /** Chemin relatif dans la stack → contenu. */
  files: Record<string, string>;
}

/** Chaîne YAML entre guillemets (JSON est un sous-ensemble de YAML pour les chaînes). */
const quote = (s: string): string => JSON.stringify(s);

/** Génère le Compose et les fichiers ; les options doivent avoir été validées. */
export function generateTraefik(o: TraefikOptions): GeneratedTraefik {
  const err = validateTraefikOptions(o);
  if (err) throw new Error(err);

  const networkBlock =
    o.network.mode === "existing"
      ? `  proxy:\n    # Réseau existant sur l'hôte : il n'est ni créé ni supprimé par cette application.\n    name: ${o.network.name}\n    external: true\n`
      : `  proxy:\n    # Nom fixe : les applications exposées par Traefik le déclarent en réseau externe.\n    name: ${o.network.name}\n`;

  const compose = `# Application Traefik générée par la console. Les réglages se modifient dans Paramètres → Traefik.
services:
  traefik:
    image: ${TRAEFIK_IMAGE}
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      # Lecture des conteneurs pour la découverte des routes : équivaut à un accès large au démon Docker.
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./${TRAEFIK_STATIC_FILE}:/etc/traefik/traefik.yml:ro
      - ./dynamic:/etc/traefik/dynamic:ro
      # Certificats (acme.json) : écrits par Traefik lui-même, hors des fichiers de l'application.
      - traefik-acme:/acme
    networks:
      - proxy

networks:
${networkBlock}
volumes:
  traefik-acme:
`;

  const staticConfig = `# Configuration statique de Traefik. Un changement demande de redéployer l'application.
global:
  checkNewVersion: false
  sendAnonymousUsage: false

log:
  level: INFO

# Tableau de bord désactivé : l'exposer demande un domaine et une authentification.
api:
  dashboard: false

entryPoints:
  ${o.httpEntryPoint}:
    address: ":80"
    http:
      # Supprime les en-têtes dont le nom en imite un autre (X_Auth_User pour X-Auth-User) : un client ne peut pas
      # falsifier les en-têtes que Traefik gère auprès des backends qui les confondent (PHP, CGI, NGINX…).
      aliasHeadersStrategy: delete
      redirections:
        entryPoint:
          to: ${o.httpsEntryPoint}
          scheme: https
  ${o.httpsEntryPoint}:
    address: ":443"
    http:
      aliasHeadersStrategy: delete
      tls:
        # Les routes de cet entrypoint demandent leur certificat à ce résolveur.
        certResolver: ${o.certResolver}

certificatesResolvers:
  ${o.certResolver}:
    acme:
      email: ${quote(o.email)}
      storage: /acme/acme.json${o.production ? "" : "\n      # Autorité de test : certificats non reconnus par les navigateurs. Passez en production dans Paramètres → Traefik.\n      caServer: https://acme-staging-v02.api.letsencrypt.org/directory"}
      httpChallenge:
        entryPoint: ${o.httpEntryPoint}

providers:
  docker:
    # Seuls les conteneurs portant « traefik.enable=true » sont exposés.
    exposedByDefault: false
    network: ${o.network.name}
  file:
    directory: /etc/traefik/dynamic
    watch: true
`;

  const dynamicConfig = `# Configuration dynamique (rechargée automatiquement) : middlewares, routes vers d'autres hôtes, options TLS.
tls:
  options:
    default:
      minVersion: VersionTLS12
`;

  return { compose, files: { [TRAEFIK_STATIC_FILE]: staticConfig, [TRAEFIK_DYNAMIC_FILE]: dynamicConfig } };
}
