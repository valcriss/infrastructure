/**
 * Génération de l'application « registry » : un registre d'images privé (OCI Distribution) placé derrière Traefik.
 *
 * Le registre protège lui-même ses accès (fichier `htpasswd`, bcrypt) : il reste authentifié même si on le joint sans
 * passer par Traefik, et l'application Traefik n'est jamais modifiée. Le dossier `auth/` est monté en entier (et non
 * le fichier seul) : un fichier remplacé par un nouveau fichier n'est plus vu par un montage de fichier unique, ce qui
 * casserait la rotation du mot de passe.
 */

import { traefikLabelEntries, validateTraefikExposure } from "./compose-traefik.js";

/** Version fixée (pas de « latest ») ; le suivi des versions d'image proposera les suivantes. */
export const REGISTRY_IMAGE = "registry:3.0.0";

/** Nom du projet Compose créé par la console. */
export const REGISTRY_STACK_NAME = "registry";
export const REGISTRY_AUTH_FILE = "auth/htpasswd";
export const REGISTRY_VOLUME = "registry-data";
/** Identifiant du compte unique du registre. */
export const REGISTRY_USERNAME = "infrastructure";
export const REGISTRY_PORT = 5000;

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

/** Ligne `htpasswd` du compte unique : identifiant et empreinte bcrypt. */
const HTPASSWD_LINE = new RegExp(`^${REGISTRY_USERNAME}:\\$2[aby]\\$\\d{2}\\$[./A-Za-z0-9]{53}$`);

export function validateHtpasswdLine(line: string): boolean {
  return HTPASSWD_LINE.test(line);
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

/** Génère le Compose et le fichier `htpasswd` ; les options et la ligne doivent être valides. */
export function generateRegistry(o: RegistryOptions, htpasswdLine: string): GeneratedRegistry {
  const err = validateRegistryOptions(o);
  if (err) throw new Error(err);
  if (!validateHtpasswdLine(htpasswdLine)) throw new Error("Empreinte de mot de passe invalide (bcrypt attendu).");

  const labels = traefikLabelEntries(
    { routerName: REGISTRY_STACK_NAME, entryPoint: o.traefik.entryPoint, certResolver: o.traefik.certResolver, network: o.traefik.network },
    { hosts: [o.host], port: REGISTRY_PORT, middlewares: [] },
  )
    .map(([k, v]) => `      ${quote(k)}: ${quote(v)}`)
    .join("\n");

  const compose = `# Application registry générée par la console. Les réglages se modifient dans Paramètres → Registry.
services:
  registry:
    image: ${REGISTRY_IMAGE}
    restart: unless-stopped
    environment:
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

  return { compose, files: { [REGISTRY_AUTH_FILE]: `${htpasswdLine}\n` } };
}
