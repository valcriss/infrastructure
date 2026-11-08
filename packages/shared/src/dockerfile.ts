export type PackageManager = "apk" | "apt-get" | "dnf" | "microdnf" | "yum" | "zypper";

export const PACKAGE_MANAGERS: readonly PackageManager[] = ["apk", "apt-get", "dnf", "microdnf", "yum", "zypper"];

const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]{0,60}$/;

export interface DockerfileOptions {
  /** Image de départ (`ghost:bookworm`) : référence fixe, sans variable. */
  base: string;
  packageManager: PackageManager;
  /** Paquets à ajouter (curl, wget…). */
  packages: string[];
  /** Mettre à jour tous les paquets du système (applique les correctifs disponibles). */
  upgrade: boolean;
  /** Utilisateur du conteneur d'origine (`Config.User`) : rétabli après l'installation. Vide = root. */
  user: string;
}

export function validatePackages(packages: string[]): string | null {
  if (packages.length > 12) return "Trop de paquets (12 au plus).";
  for (const p of packages) if (!PACKAGE_NAME.test(p)) return `Nom de paquet invalide : « ${p} ».`;
  return null;
}

/** Une référence d'image utilisable telle quelle dans `FROM` : ni variable Compose ni espace. */
export function validateBaseImage(ref: string): string | null {
  if (!ref || ref.length > 300 || /[\s$]/.test(ref)) return "L'image du service est paramétrée ou invalide : indiquez une référence fixe dans le Compose.";
  return /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(ref) ? null : "Référence d'image invalide.";
}

/** Commande d'installation et de nettoyage pour un gestionnaire de paquets (caches supprimés pour garder l'image petite). */
function installCommand(pm: PackageManager, packages: string[], upgrade: boolean): string[] {
  const list = packages.join(" ");
  switch (pm) {
    case "apk":
      return [...(upgrade ? ["apk upgrade --no-cache"] : []), ...(packages.length ? [`apk add --no-cache ${list}`] : [])];
    case "apt-get": {
      const steps = ["apt-get update", ...(upgrade ? ["apt-get upgrade -y"] : []), ...(packages.length ? [`apt-get install -y --no-install-recommends ${list}`] : []), "rm -rf /var/lib/apt/lists/*"];
      return steps;
    }
    case "dnf":
    case "microdnf":
    case "yum": {
      return [...(upgrade ? [`${pm} upgrade -y`] : []), ...(packages.length ? [`${pm} install -y ${list}`] : []), `${pm} clean all`];
    }
    case "zypper":
      return [...(upgrade ? ["zypper --non-interactive update"] : []), ...(packages.length ? [`zypper --non-interactive install --no-recommends ${list}`] : []), "zypper clean --all"];
  }
}

/**
 * Dockerfile minimal : l'image du service, plus des outils et/ou les mises à jour du système.
 * Les commandes sont enchaînées dans une seule couche, caches supprimés.
 */
export function generateDockerfile(o: DockerfileOptions): string {
  const steps = installCommand(o.packageManager, o.packages, o.upgrade);
  const keepUser = o.user.trim() !== "" && o.user.trim() !== "root" && o.user.trim() !== "0";
  return [
    "# Image personnalisée générée par la console : modifiable ici, reconstruite à chaque déploiement.",
    "# Attention : cette image est construite sur l'hôte ; les nouvelles versions de l'image de base",
    "# ne sont reprises qu'avec « Télécharger les images » au déploiement.",
    `FROM ${o.base}`,
    "USER root",
    steps.length ? `RUN ${steps.join(" \\\n    && ")}` : "# (rien à installer)",
    ...(keepUser ? [`USER ${o.user.trim()}`] : []),
    "",
  ].join("\n");
}
