/**
 * Génération de l'application « registry » : un registre d'images privé (OCI Distribution) placé derrière Traefik.
 *
 * Le registre protège lui-même ses accès (fichier `htpasswd`, bcrypt) : il reste authentifié même si on le joint sans
 * passer par Traefik, et l'application Traefik n'est jamais modifiée.
 *
 * Deux comptes : « infrastructure » (publication : lecture et écriture) et « infrastructure-pull » (lecture seule). Le
 * registre ne sait pas limiter un compte à la lecture : c'est Traefik qui l'impose, par un second routeur qui capte
 * toute méthode autre que GET et HEAD et exige le seul compte de publication (basicAuth). Le compte de lecture reçoit
 * donc 401 pour toute écriture. Vérifié sur Traefik 3.7 et registry 3.0. La restriction ne vaut que pour les accès qui
 * passent par Traefik : un registre joint directement (réseau interne) n'a que l'authentification htpasswd. Le dossier `auth/` est monté en entier (et non
 * le fichier seul) : un fichier remplacé par un nouveau fichier n'est plus vu par un montage de fichier unique, ce qui
 * casserait la rotation du mot de passe.
 */

import type { HealthcheckSpec } from "./compose-edit.js";
import { traefikLabelEntries, validateTraefikExposure } from "./compose-traefik.js";

/** Version fixée (pas de « latest ») ; le suivi des versions d'image proposera les suivantes. */
export const REGISTRY_IMAGE = "registry:3.0.0";

/** Nom du projet Compose créé par la console. */
export const REGISTRY_STACK_NAME = "registry";
export const REGISTRY_AUTH_FILE = "auth/htpasswd";
export const REGISTRY_VOLUME = "registry-data";
/** Identifiant du compte de publication (lecture et écriture) du registre. */
export const REGISTRY_USERNAME = "infrastructure";
/** Identifiant du compte de lecture seule, transmis aux déploiements qui tirent les images. */
export const REGISTRY_PULL_USERNAME = "infrastructure-pull";
/** Routeur et middleware Traefik qui réservent l'écriture au compte de publication. */
export const REGISTRY_WRITE_ROUTER = "registry-write";
export const REGISTRY_WRITE_AUTH = "registry-write-auth";
export const REGISTRY_PORT = 5000;
/** Serveur de diagnostic du registre, lié à la boucle locale du conteneur (jamais joignable depuis le réseau). */
export const REGISTRY_DEBUG_ADDR = "127.0.0.1:5001";
/** Healthcheck du conteneur : /debug/health du serveur de diagnostic (répond sans identifiants, contrairement à /v2/). */
export const REGISTRY_HEALTHCHECK: HealthcheckSpec = { test: `wget -q --spider http://${REGISTRY_DEBUG_ADDR}/debug/health`, interval: "30s", timeout: "5s", retries: 3, startPeriod: "15s" };

/** Réglages Traefik auxquels la registry se raccorde (lus de l'application Traefik, jamais modifiés). */
export interface RegistryTraefik {
  entryPoint: string;
  certResolver: string;
  /** Nom (réel) du réseau Docker partagé avec Traefik. */
  network: string;
}

export interface RegistryOptions {
  /** Nom de domaine public du registre (ex. registry.exemple.fr). */
  host: string;
  traefik: RegistryTraefik;
}

/** Ligne `htpasswd` d'un compte : identifiant et empreinte bcrypt. */
const htpasswdLine = (user: string): RegExp => new RegExp(`^${user}:\\$2[aby]\\$\\d{2}\\$[./A-Za-z0-9]{53}$`);

export function validateHtpasswdLine(line: string, user: string = REGISTRY_USERNAME): boolean {
  return htpasswdLine(user).test(line);
}

/** Première erreur de saisie, ou null. */
export function validateRegistryOptions(o: RegistryOptions): string | null {
  const host = o.host.trim();
  if (host !== o.host || host.length === 0) return "Nom de domaine invalide.";
  const exposure = validateTraefikExposure({ hosts: [host], port: REGISTRY_PORT, middlewares: [] });
  if (exposure) return exposure;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(o.traefik.entryPoint)) return "Entrypoint Traefik invalide.";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(o.traefik.certResolver)) return "Résolveur de certificats Traefik invalide.";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(o.traefik.network)) return "Réseau Traefik invalide.";
  return null;
}

export interface GeneratedRegistry {
  compose: string;
  /** Chemin relatif dans la stack → contenu. */
  files: Record<string, string>;
}

/** Chaîne YAML entre guillemets (JSON est un sous-ensemble de YAML pour les chaînes). */
const quote = (s: string): string => JSON.stringify(s);

/** Lignes `htpasswd` des deux comptes (empreintes bcrypt). */
export interface RegistryAccounts {
  publish: string;
  pull: string;
}

/** Génère le Compose et le fichier `htpasswd` ; les options et les lignes doivent être valides. */
export function generateRegistry(o: RegistryOptions, accounts: RegistryAccounts): GeneratedRegistry {
  const err = validateRegistryOptions(o);
  if (err) throw new Error(err);
  if (!validateHtpasswdLine(accounts.publish, REGISTRY_USERNAME) || !validateHtpasswdLine(accounts.pull, REGISTRY_PULL_USERNAME)) {
    throw new Error("Empreinte de mot de passe invalide (bcrypt attendu).");
  }

  const ctx = { routerName: REGISTRY_STACK_NAME, entryPoint: o.traefik.entryPoint, certResolver: o.traefik.certResolver, network: o.traefik.network };
  const w = `traefik.http.routers.${REGISTRY_WRITE_ROUTER}`;
  const entries: [string, string][] = [
    ...traefikLabelEntries(ctx, { hosts: [o.host], port: REGISTRY_PORT, middlewares: [] }),
    [`traefik.http.routers.${REGISTRY_STACK_NAME}.service`, REGISTRY_STACK_NAME],
    // Écriture (toute méthode sauf GET et HEAD) : réservée au compte de publication, avant d'atteindre le registre.
    // `Method()` n'accepte qu'un paramètre ; la négation refuse aussi par défaut toute méthode inattendue.
    [`${w}.rule`, `Host(\`${o.host}\`) && !Method(\`GET\`) && !Method(\`HEAD\`)`],
    [`${w}.priority`, "100"],
    [`${w}.entrypoints`, o.traefik.entryPoint],
    [`${w}.tls`, "true"],
    [`${w}.tls.certresolver`, o.traefik.certResolver],
    [`${w}.service`, REGISTRY_STACK_NAME],
    [`${w}.middlewares`, REGISTRY_WRITE_AUTH],
    // Docker Compose interprète « $ » : les empreintes bcrypt sont écrites avec « $$ ».
    [`traefik.http.middlewares.${REGISTRY_WRITE_AUTH}.basicauth.users`, accounts.publish.replaceAll("$", "$$$$")],
  ];
  const labels = entries.map(([k, v]) => `      ${quote(k)}: ${quote(v)}`).join("\n");

  const compose = `# Application registry générée par la console. Les réglages se modifient dans Paramètres → Registry.
services:
  registry:
    image: ${REGISTRY_IMAGE}
    restart: unless-stopped
    healthcheck:
      test: [ "CMD-SHELL", ${quote(REGISTRY_HEALTHCHECK.test)} ]
      interval: ${REGISTRY_HEALTHCHECK.interval}
      timeout: ${REGISTRY_HEALTHCHECK.timeout}
      retries: ${REGISTRY_HEALTHCHECK.retries}
      start_period: ${REGISTRY_HEALTHCHECK.startPeriod}
    environment:
      # Point de contrôle /debug/health, sans authentification : lié à 127.0.0.1, il n'est joignable que depuis le conteneur.
      REGISTRY_HTTP_DEBUG_ADDR: ${quote(REGISTRY_DEBUG_ADDR)}
      REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY: /var/lib/registry
      REGISTRY_STORAGE_DELETE_ENABLED: "true"
      REGISTRY_AUTH: htpasswd
      REGISTRY_AUTH_HTPASSWD_REALM: Registry
      REGISTRY_AUTH_HTPASSWD_PATH: /auth/htpasswd
    volumes:
      - ${REGISTRY_VOLUME}:/var/lib/registry
      - ./auth:/auth:ro
    labels:
${labels}
    networks:
      - proxy

networks:
  proxy:
    # Réseau de Traefik, déjà créé par son application : il n'est ni créé ni supprimé ici.
    name: ${o.traefik.network}
    external: true

volumes:
  ${REGISTRY_VOLUME}:
`;

  return { compose, files: { [REGISTRY_AUTH_FILE]: `${accounts.publish}\n${accounts.pull}\n` } };
}
