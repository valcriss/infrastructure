import type { ImageInfo } from "@infra/shared";

export interface ImageRef {
  /** Hôte du registre tel qu'utilisé par l'API (Docker Hub : registry-1.docker.io). */
  apiHost: string;
  /** Nom canonique du registre, clé des identifiants (Docker Hub : docker.io). */
  registry: string;
  /** Dépôt dans le registre (Docker Hub : library/nginx). */
  repository: string;
  tag: string | null;
  /** Digest dans la référence (`nom@sha256:…`) : l'image est épinglée. */
  digest: string | null;
  /** Vrai si le registre est le Docker Hub implicite. */
  dockerHub: boolean;
}

const DOCKER_HUB = ["docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com"];

/**
 * Analyse une référence d'image à la manière de Docker :
 * `nginx` → docker.io/library/nginx:latest, `ghcr.io/o/app:1`, `reg.local:5000/t/app@sha256:…`.
 * Retourne null pour une référence invalide ou un identifiant d'image brut.
 */
export function parseImageRef(raw: string): ImageRef | null {
  const input = raw.trim();
  if (!input || input.length > 300 || /\s/.test(input) || input.startsWith("sha256:")) return null;

  let rest = input;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!/^[a-z0-9]+:[0-9a-f]{32,}$/i.test(digest)) return null;
  }

  // Le premier composant est un registre s'il contient « . » ou « : », ou vaut « localhost ».
  const parts = rest.split("/");
  let host: string | null = null;
  if (parts.length > 1 && (parts[0]?.includes(".") || parts[0]?.includes(":") || parts[0] === "localhost")) {
    host = (parts.shift() as string).toLowerCase();
  }
  let path = parts.join("/");

  // Étiquette : après le dernier « : » du dernier composant.
  let tag: string | null = null;
  const lastSlash = path.lastIndexOf("/");
  const colon = path.indexOf(":", lastSlash + 1);
  if (colon !== -1) {
    tag = path.slice(colon + 1);
    path = path.slice(0, colon);
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) return null;
  }
  if (!path || !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/.test(path)) return null;

  const dockerHub = host === null || DOCKER_HUB.includes(host);
  if (dockerHub && !path.includes("/")) path = `library/${path}`;
  if (!tag && !digest) tag = "latest";

  return {
    apiHost: dockerHub ? "registry-1.docker.io" : (host as string),
    registry: dockerHub ? "docker.io" : (host as string),
    repository: path,
    tag,
    digest,
    dockerHub,
  };
}

/** Normalise un nom de registre saisi par l'utilisateur (clé des identifiants). */
export function normalizeRegistry(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (DOCKER_HUB.includes(v)) return "docker.io";
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/.test(v) && v.length <= 255 ? v : null;
}

/**
 * Digest de registre de l'image locale pour le dépôt de la référence
 * (`nginx@sha256:…`). Une image construite ou chargée localement n'en a pas.
 */
export function localRepoDigest(image: Pick<ImageInfo, "repoDigests">, ref: ImageRef): string | null {
  for (const d of image.repoDigests) {
    const parsed = parseImageRef(d);
    if (parsed && parsed.registry === ref.registry && parsed.repository === ref.repository && parsed.digest) return parsed.digest;
  }
  return null;
}

/** Plateforme `os/arch[/variant]` d'une image locale ; vide si inconnue. */
export function platformOf(image: Pick<ImageInfo, "os" | "arch" | "variant">): string {
  if (!image.os || !image.arch) return "";
  return `${image.os}/${image.arch}${image.variant ? `/${image.variant}` : ""}`;
}
