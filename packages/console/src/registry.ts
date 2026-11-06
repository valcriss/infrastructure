import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import type { ImageRef } from "./image-ref.js";

export type RegistryErrorCode = "auth" | "not_found" | "rate_limited" | "network" | "unsupported" | "bad_response";

/** Erreur d'un registre : l'appelant conserve alors la dernière observation datée. */
export class RegistryError extends Error {
  constructor(
    readonly code: RegistryErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export interface RegistryCredentials {
  username: string | null;
  password: string | null;
  /** Autorise HTTP (registre interne sans TLS) ; refusé par défaut. */
  insecure: boolean;
}

export interface Platform {
  os: string;
  arch: string;
  variant?: string;
}

export interface ManifestHead {
  digest: string;
  mediaType: string;
}

export interface ResolvedManifest {
  /** Digest du manifeste propre à la plateforme (ou du manifeste unique). */
  manifestDigest: string;
  /** Digest de la configuration : identifiant de l'image pour Docker. */
  configDigest: string | null;
  /** Digest de l'index multi-architecture, si le tag en désigne un. */
  indexDigest: string | null;
}

export interface RegistryClientDeps {
  credentials: (registry: string) => Promise<RegistryCredentials | null>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Écart minimal entre deux requêtes vers un même registre (limite le débit). */
  minGapMs?: number;
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const INDEX_TYPES = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const MAX_TAG_PAGES = 10;

/** Services d'authentification connus pour recevoir les identifiants d'un registre. */
const KNOWN_REALMS: Record<string, string[]> = {
  "registry-1.docker.io": ["auth.docker.io"],
  "ghcr.io": ["ghcr.io"],
  "registry.gitlab.com": ["gitlab.com"],
  "quay.io": ["quay.io"],
};

/**
 * Les identifiants d'un registre ne sont envoyés qu'à son service
 * d'authentification légitime : le même hôte, un sous-domaine du même
 * domaine, ou un service connu. Un « realm » arbitraire ne les reçoit pas.
 */
export function realmAllowed(registryHost: string, realmHost: string): boolean {
  const reg = registryHost.replace(/:\d+$/, "").toLowerCase();
  const realm = realmHost.replace(/:\d+$/, "").toLowerCase();
  if (reg === realm) return true;
  if (KNOWN_REALMS[reg]?.includes(realm)) return true;
  const parent = reg.split(".").slice(1).join(".");
  return parent.includes(".") && (realm === parent || realm.endsWith(`.${parent}`));
}

export function parseChallenge(header: string | null): { scheme: string; params: Record<string, string> } | null {
  if (!header) return null;
  const m = /^\s*([A-Za-z]+)\s*(.*)$/.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of (m[2] ?? "").matchAll(/([A-Za-z_]+)="([^"]*)"/g)) params[(p[1] as string).toLowerCase()] = p[2] as string;
  return { scheme: (m[1] as string).toLowerCase(), params };
}

/** `fetch` avec une autorité de certification supplémentaire (registre interne). */
export async function createFetch(caFile: string | null): Promise<typeof fetch> {
  if (!caFile) return fetch;
  const { Agent, fetch: undiciFetch } = await import("undici");
  const dispatcher = new Agent({ connect: { ca: [...rootCertificates, readFileSync(caFile, "utf8")] } });
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
}

export class RegistryClient {
  private readonly tokens = new Map<string, { token: string; expires: number }>();
  private readonly gaps = new Map<string, Promise<void>>();
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: RegistryClientDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private async pace(host: string): Promise<void> {
    const gap = this.deps.minGapMs ?? 100;
    const previous = this.gaps.get(host) ?? Promise.resolve();
    const next = previous.then(() => new Promise<void>((r) => setTimeout(r, gap)));
    this.gaps.set(host, next);
    await previous;
  }

  private async send(url: string, method: string, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchFn(url, { method, headers, signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const detail = `${cause?.code ?? ""} ${cause?.message ?? ""}`;
      // Un serveur HTTP en clair contacté en HTTPS échoue à la poignée de main : ce n'est pas un problème de certificat.
      if (/WRONG_VERSION_NUMBER|packet length too long|EPROTO/i.test(detail)) {
        throw new RegistryError("network", "Le registre ne répond pas en HTTPS. S'il s'agit d'un registre interne sans TLS, activez « HTTP non sécurisé » pour ce registre.");
      }
      const tls = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS/i.test(detail);
      throw new RegistryError("network", tls ? "Certificat TLS du registre non valide ou non reconnu." : "Registre injoignable.");
    }
  }

  private async token(
    challenge: { params: Record<string, string> },
    ref: Pick<ImageRef, "registry" | "apiHost">,
    creds: RegistryCredentials | null,
    scope: string,
    fresh = false,
  ): Promise<string> {
    const realm = challenge.params.realm;
    if (!realm) throw new RegistryError("bad_response", "Défi d'authentification du registre incomplet.");
    let url: URL;
    try {
      url = new URL(realm);
    } catch {
      throw new RegistryError("bad_response", "Service d'authentification du registre invalide.");
    }
    if (url.protocol !== "https:" && !(creds?.insecure && url.protocol === "http:")) {
      throw new RegistryError("unsupported", "Service d'authentification en HTTP refusé (HTTPS requis).");
    }
    const key = `${ref.registry}|${challenge.params.service ?? ""}|${scope}`;
    const cached = this.tokens.get(key);
    if (!fresh && cached && cached.expires > Date.now()) return cached.token;

    if (challenge.params.service) url.searchParams.set("service", challenge.params.service);
    url.searchParams.set("scope", challenge.params.scope ?? scope);
    const headers: Record<string, string> = {};
    // Identifiants envoyés uniquement à un service d'authentification légitime pour ce registre.
    if (creds?.username && creds.password && realmAllowed(ref.apiHost, url.host)) {
      headers.Authorization = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
    }
    await this.pace(url.host);
    const res = await this.send(url.toString(), "GET", headers);
    if (res.status === 401 || res.status === 403) {
      throw new RegistryError("auth", creds?.username ? "Identifiants du registre refusés." : "Registre privé : des identifiants sont nécessaires.");
    }
    if (res.status === 429) throw new RegistryError("rate_limited", "Limite de requêtes du registre atteinte.", Number(res.headers.get("retry-after")) || undefined);
    if (!res.ok) throw new RegistryError("bad_response", `Service d'authentification : HTTP ${res.status}.`);
    const body = (await res.json().catch(() => null)) as { token?: string; access_token?: string; expires_in?: number } | null;
    const token = body?.token ?? body?.access_token;
    if (!token) throw new RegistryError("bad_response", "Réponse d'authentification sans jeton.");
    this.tokens.set(key, { token, expires: Date.now() + Math.max(30, Math.min(body?.expires_in ?? 60, 300) - 10) * 1000 });
    return token;
  }

  /** Requête vers l'API d'un registre avec gestion du défi d'authentification. */
  private async call(ref: Pick<ImageRef, "registry" | "apiHost" | "repository">, path: string, method: string, accept?: string): Promise<Response> {
    const creds = await this.deps.credentials(ref.registry);
    const scheme = creds?.insecure ? "http" : "https";
    const url = `${scheme}://${ref.apiHost}${path}`;
    const scope = `repository:${ref.repository}:pull`;
    const base: Record<string, string> = { "User-Agent": "console-docker/0.0", ...(accept ? { Accept: accept } : {}) };

    await this.pace(ref.apiHost);
    let res = await this.send(url, method, base);
    if (res.status === 401) {
      const challenge = parseChallenge(res.headers.get("www-authenticate"));
      let auth: string;
      if (challenge?.scheme === "bearer") {
        auth = `Bearer ${await this.token(challenge, ref, creds, scope)}`;
        await this.pace(ref.apiHost);
        res = await this.send(url, method, { ...base, Authorization: auth });
        // Jeton mis en cache révoqué ou expiré côté registre : un seul nouvel essai avec un jeton frais.
        if (res.status === 401) {
          auth = `Bearer ${await this.token(challenge, ref, creds, scope, true)}`;
          await this.pace(ref.apiHost);
          res = await this.send(url, method, { ...base, Authorization: auth });
        }
        return this.check(res, creds);
      } else if (challenge?.scheme === "basic" && creds?.username && creds.password) {
        auth = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
      } else {
        throw new RegistryError("auth", creds?.username ? "Authentification du registre non supportée." : "Registre privé : des identifiants sont nécessaires.");
      }
      await this.pace(ref.apiHost);
      res = await this.send(url, method, { ...base, Authorization: auth });
    }
    return this.check(res, creds);
  }

  /** Traduit le statut HTTP d'une réponse du registre en erreur typée. */
  private check(res: Response, creds: RegistryCredentials | null): Response {
    if (res.status === 401 || res.status === 403) {
      throw new RegistryError("auth", creds?.username ? "Identifiants du registre refusés ou droits insuffisants." : "Registre privé : des identifiants sont nécessaires.");
    }
    if (res.status === 404) throw new RegistryError("not_found", "Image ou tag introuvable dans le registre.");
    if (res.status === 429) throw new RegistryError("rate_limited", "Limite de requêtes du registre atteinte.", Number(res.headers.get("retry-after")) || undefined);
    if (res.status >= 500) throw new RegistryError("network", `Le registre a répondu HTTP ${res.status}.`);
    if (!res.ok) throw new RegistryError("bad_response", `Réponse inattendue du registre : HTTP ${res.status}.`);
    return res;
  }

  /** Digest courant d'un tag, par HEAD (n'entre pas dans les quotas de téléchargement du Docker Hub). */
  async headManifest(ref: ImageRef, reference: string): Promise<ManifestHead> {
    const res = await this.call(ref, `/v2/${ref.repository}/manifests/${reference}`, "HEAD", MANIFEST_ACCEPT);
    const digest = res.headers.get("docker-content-digest");
    if (!digest) throw new RegistryError("bad_response", "Le registre n'a pas fourni de digest.");
    return { digest, mediaType: (res.headers.get("content-type") ?? "").split(";")[0] ?? "" };
  }

  /** Résout, pour une plateforme, le manifeste et la configuration derrière un tag (ou un digest). */
  async resolvePlatform(ref: ImageRef, reference: string, platform: Platform): Promise<ResolvedManifest> {
    const get = async (r: string) => {
      const res = await this.call(ref, `/v2/${ref.repository}/manifests/${r}`, "GET", MANIFEST_ACCEPT);
      const digest = res.headers.get("docker-content-digest");
      const type = (res.headers.get("content-type") ?? "").split(";")[0] ?? "";
      return { digest, type, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    };
    const top = await get(reference);
    if (!top.body) throw new RegistryError("bad_response", "Manifeste illisible.");

    if (INDEX_TYPES.includes(top.type) || Array.isArray(top.body.manifests)) {
      const entries = (top.body.manifests ?? []) as { digest?: string; platform?: { os?: string; architecture?: string; variant?: string } }[];
      const match =
        entries.find((e) => e.platform?.os === platform.os && e.platform?.architecture === platform.arch && (!platform.variant || !e.platform?.variant || e.platform.variant === platform.variant)) ?? null;
      if (!match?.digest) throw new RegistryError("unsupported", `Aucune variante ${platform.os}/${platform.arch} dans ce tag.`);
      const leaf = await get(match.digest);
      const config = (leaf.body?.config as { digest?: string } | undefined)?.digest ?? null;
      return { manifestDigest: match.digest, configDigest: config, indexDigest: top.digest };
    }
    const config = (top.body.config as { digest?: string } | undefined)?.digest ?? null;
    return { manifestDigest: top.digest ?? "", configDigest: config, indexDigest: null };
  }

  /**
   * Couches (diff_ids) de l'image décrite par une configuration : permet de
   * comparer le CONTENU d'une image locale et distante, même quand le registre
   * l'emballe autrement (index ou manifeste seul, compression…).
   */
  async configLayers(ref: ImageRef, configDigest: string): Promise<string[]> {
    const res = await this.call(ref, `/v2/${ref.repository}/blobs/${configDigest}`, "GET", "application/json");
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > 1024 * 1024) throw new RegistryError("bad_response", "Configuration d'image trop volumineuse.");
    const body = (await res.json().catch(() => null)) as { rootfs?: { diff_ids?: unknown } } | null;
    const ids = body?.rootfs?.diff_ids;
    if (!Array.isArray(ids)) throw new RegistryError("bad_response", "Configuration d'image illisible.");
    return ids.filter((x): x is string => typeof x === "string");
  }

  /** Liste les tags d'un dépôt (pagination par en-tête Link, plafonnée). */
  async listTags(ref: ImageRef): Promise<{ tags: string[]; truncated: boolean }> {
    const tags: string[] = [];
    let path: string | null = `/v2/${ref.repository}/tags/list?n=1000`;
    for (let page = 0; path && page < MAX_TAG_PAGES; page++) {
      const res = await this.call(ref, path, "GET", "application/json");
      const body = (await res.json().catch(() => null)) as { tags?: string[] | null } | null;
      if (!body) throw new RegistryError("bad_response", "Liste de tags illisible.");
      tags.push(...(body.tags ?? []));
      const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
      // La suite doit rester sur le même hôte (jamais de redirection vers un autre serveur).
      path = null;
      if (next) {
        const u = new URL(next, `https://${ref.apiHost}`);
        if (u.host === ref.apiHost) path = u.pathname + u.search;
      }
      if (path && page === MAX_TAG_PAGES - 1) return { tags, truncated: true };
    }
    return { tags, truncated: false };
  }

  /** Vérifie l'accès au registre avec les identifiants enregistrés (`GET /v2/`). */
  async testAccess(registry: string): Promise<void> {
    const apiHost = registry === "docker.io" ? "registry-1.docker.io" : registry;
    await this.call({ registry, apiHost, repository: "library/hello-world" }, "/v2/", "GET");
  }
}
