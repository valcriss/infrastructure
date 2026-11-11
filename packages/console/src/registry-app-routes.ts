import {
  generateRegistry,
  REGISTRY_AUTH_FILE,
  REGISTRY_IMAGE,
  REGISTRY_STACK_NAME,
  REGISTRY_USERNAME,
  validateRegistryOptions,
  type GeneratedRegistry,
  type RegistryOptions,
} from "@infra/shared";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { normalizeRegistry } from "./image-ref.js";
import type { RegistryStore } from "./registries.js";
import { changeStack, createStack } from "./stacks.js";
import { getTraefikSettings, type TraefikSettings } from "./traefik-routes.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

// --- Réglage mémorisé ---------------------------------------------------------------------------------

/** Application registry créée par la console (le mot de passe est dans les identifiants de registres, chiffré). */
export interface RegistrySettings {
  stackId: string;
  hostId: string;
  /** Nom de domaine public du registre (aussi la clé de ses identifiants). */
  host: string;
  entryPoint: string;
  certResolver: string;
  network: string;
}

export async function getRegistrySettings(pool: Pick<Pool, "query">): Promise<RegistrySettings | null> {
  const { rows } = await pool.query<{ value: RegistrySettings }>("SELECT value FROM app_settings WHERE key = 'registry'");
  return rows[0]?.value ?? null;
}

// --- Mot de passe -------------------------------------------------------------------------------------

/** Mot de passe aléatoire de 40 caractères (240 bits), jamais saisi par l'utilisateur. */
export const newRegistryPassword = (): string => randomBytes(30).toString("base64url");

/**
 * Ligne `htpasswd` du compte unique. L'empreinte est écrite `$2a$` (accepté par tous les lecteurs bcrypt, dont celui
 * du registre) : pour un mot de passe de moins de 72 octets, l'algorithme est identique à `$2b$`.
 */
export async function htpasswdLine(password: string): Promise<string> {
  const hash = await bcrypt.hash(password, 10);
  return `${REGISTRY_USERNAME}:${hash.replace(/^\$2b\$/, "$2a$")}`;
}

// --- Vérification de l'accès public -------------------------------------------------------------------

export interface ProbeStep {
  ok: boolean;
  detail: string;
}

export interface ProbeResult {
  /** Le nom de domaine pointe vers une adresse. */
  dns: ProbeStep;
  /** Certificat reconnu : celui que verraient les démons Docker des hôtes (sans autorité de certification ajoutée). */
  tls: ProbeStep;
  /** Sans identifiants, le registre répond 401 (jamais d'accès anonyme). */
  anonymous: ProbeStep;
  /** Avec les identifiants de la console, le registre répond 200. */
  authenticated: ProbeStep;
  ready: boolean;
}

interface ProbeResponse {
  status: number;
}

/** GET https://hôte/v2/ avec vérification TLS complète (aucune exception). */
function getV2(host: string, authorization?: string): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host, port: 443, path: "/v2/", method: "GET", rejectUnauthorized: true, servername: host, timeout: 10_000, headers: { host, ...(authorization ? { authorization } : {}) } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", reject);
    req.end();
  });
}

const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS|DEPTH_ZERO|HOSTNAME_MISMATCH|EPROTO/i;

/** Contrôle ce que verront les hôtes : DNS, certificat, authentification obligatoire, identifiants valides. */
export async function probeRegistry(host: string, credentials: { username: string; password: string } | null): Promise<ProbeResult> {
  const skipped: ProbeStep = { ok: false, detail: "Non vérifié." };
  const result: ProbeResult = { dns: skipped, tls: skipped, anonymous: skipped, authenticated: skipped, ready: false };

  try {
    const addrs = await lookup(host, { all: true });
    result.dns = addrs.length > 0 ? { ok: true, detail: addrs.map((a) => a.address).join(", ") } : { ok: false, detail: "Aucune adresse." };
  } catch {
    result.dns = { ok: false, detail: `Le nom « ${host} » ne se résout pas : créez l'enregistrement DNS vers l'hôte de Traefik.` };
    return result;
  }

  let anon: ProbeResponse;
  try {
    anon = await getV2(host);
    result.tls = { ok: true, detail: "Certificat reconnu." };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    const message = err instanceof Error ? err.message : "erreur";
    result.tls = TLS_CODES.test(code) || TLS_CODES.test(message)
      ? { ok: false, detail: `Certificat refusé (${code || message}). Les démons Docker le refuseraient aussi : avec l'autorité de test de Let's Encrypt, passez Traefik en production (Paramètres → Traefik).` }
      : { ok: false, detail: `Connexion impossible (${code || message}) : le port 443 de l'hôte est-il joignable et Traefik déployé ?` };
    return result;
  }

  result.anonymous =
    anon.status === 401
      ? { ok: true, detail: "Accès anonyme refusé (401)." }
      : anon.status === 404
        ? { ok: false, detail: "Réponse 404 : la route n'atteint pas le registre (application non déployée, ou nom de domaine servi par une autre application)." }
        : { ok: false, detail: `Réponse ${anon.status} sans identifiants (401 attendu).` };
  if (!result.anonymous.ok) return result;

  if (!credentials) {
    result.authenticated = { ok: false, detail: "Aucun identifiant enregistré." };
    return result;
  }
  try {
    const auth = await getV2(host, `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`);
    result.authenticated = auth.status === 200 ? { ok: true, detail: "Identifiants acceptés (200)." } : { ok: false, detail: `Identifiants refusés (${auth.status}) : si le mot de passe vient d'être renouvelé, redéployez l'application registry.` };
  } catch (err) {
    result.authenticated = { ok: false, detail: `Connexion impossible (${err instanceof Error ? err.message : "erreur"}).` };
  }
  result.ready = result.dns.ok && result.tls.ok && result.anonymous.ok && result.authenticated.ok;
  return result;
}

// --- Routes -------------------------------------------------------------------------------------------

export const RegistryAppBody = z.object({ host: z.string().max(253) });

/** Empreinte factice de l'aperçu : le vrai mot de passe n'existe qu'à la création. */
const PREVIEW_LINE = `${REGISTRY_USERNAME}:$2a$10$${".".repeat(53)}`;

export function registerRegistryAppRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard; registries: RegistryStore }): void {
  const { pool, auth, registries } = deps;

  const options = (host: string, t: TraefikSettings): RegistryOptions => ({
    host: host.trim().toLowerCase(),
    traefik: { entryPoint: t.httpsEntryPoint, certResolver: t.certResolver, network: t.network },
  });

  interface StackInfo {
    id: string;
    name: string;
    host_id: string;
    current_revision: number;
    deployed_revision: number | null;
    managed_by: string | null;
  }
  const stackOf = async (id: string): Promise<StackInfo | null> =>
    (await pool.query<StackInfo>("SELECT id, name, host_id, current_revision, deployed_revision, managed_by FROM stacks WHERE id = $1", [id])).rows[0] ?? null;
  const hostName = async (id: string): Promise<string | null> => (await pool.query<{ name: string }>("SELECT name FROM hosts WHERE id = $1", [id])).rows[0]?.name ?? null;

  /** Traefik configuré (application présente) : sinon une raison, avec lien vers l'onglet Traefik côté interface. */
  async function traefikContext(): Promise<{ ok: true; settings: TraefikSettings; stack: StackInfo; hostName: string | null } | { ok: false; reason: string }> {
    const settings = await getTraefikSettings(pool);
    if (!settings) return { ok: false, reason: "Traefik n'est pas configuré : créez d'abord l'application Traefik." };
    const stack = await stackOf(settings.stackId);
    if (!stack) return { ok: false, reason: "L'application Traefik a été supprimée : recréez-la d'abord." };
    return { ok: true, settings, stack, hostName: await hostName(stack.host_id) };
  }

  app.get("/api/v1/settings/registry", { preHandler: auth }, async () => {
    const [traefik, settings] = await Promise.all([traefikContext(), getRegistrySettings(pool)]);
    let application: unknown = null;
    let hasPassword = false;
    if (settings) {
      const s = await stackOf(settings.stackId);
      application = s
        ? {
            id: s.id,
            name: s.name,
            hostId: s.host_id,
            hostName: await hostName(s.host_id),
            currentRevision: s.current_revision,
            deployedRevision: s.deployed_revision,
            deployed: s.deployed_revision !== null,
            managed: s.managed_by === "registry",
          }
        : { missing: true };
      hasPassword = (await registries.credentials(settings.host))?.password != null;
    }
    return {
      settings,
      application,
      hasPassword,
      stackName: REGISTRY_STACK_NAME,
      image: REGISTRY_IMAGE,
      username: REGISTRY_USERNAME,
      traefik: traefik.ok
        ? {
            available: true,
            hostId: traefik.stack.host_id,
            hostName: traefik.hostName,
            deployed: traefik.stack.deployed_revision !== null,
            // Mémorisé à la création de l'application Traefik ; le test d'accès vérifie le certificat réel.
            production: traefik.settings.production,
            entryPoint: traefik.settings.httpsEntryPoint,
            certResolver: traefik.settings.certResolver,
            network: traefik.settings.network,
          }
        : { available: false, reason: traefik.reason },
    };
  });

  /** Valide la saisie et le contexte ; lève une HttpError sinon. */
  async function prepare(raw: unknown): Promise<{ opts: RegistryOptions; traefik: { settings: TraefikSettings; stack: StackInfo } }> {
    const body = RegistryAppBody.parse(raw);
    const traefik = await traefikContext();
    if (!traefik.ok) throw new HttpError(409, "traefik_not_configured", traefik.reason);
    const opts = options(body.host, traefik.settings);
    const invalid = validateRegistryOptions(opts);
    if (invalid) throw new HttpError(400, "invalid_options", invalid);
    return { opts, traefik };
  }

  // Aperçu des fichiers qui seraient créés : même validation que la création, aucun mot de passe n'est généré.
  app.post("/api/v1/settings/registry/preview", { preHandler: auth }, async (request): Promise<GeneratedRegistry> => {
    const { opts } = await prepare(request.body);
    const g = generateRegistry(opts, PREVIEW_LINE);
    return { compose: g.compose, files: { [REGISTRY_AUTH_FILE]: `${REGISTRY_USERNAME}:<empreinte bcrypt d'un mot de passe aléatoire, générée à la création>\n` } };
  });

  // Crée l'application registry (révision 1, non déployée), son mot de passe et l'enregistrement du registre.
  app.post("/api/v1/settings/registry/application", { preHandler: auth }, async (request, reply) => {
    const current = await getRegistrySettings(pool);
    if (current && (await stackOf(current.stackId))) throw new HttpError(409, "registry_already_configured", "Une application registry est déjà configurée.");
    const { opts, traefik } = await prepare(request.body);

    const registry = normalizeRegistry(opts.host);
    if (!registry) throw new HttpError(400, "invalid_options", "Nom de domaine invalide.");
    if ((await registries.credentials(registry)) !== null) {
      throw new HttpError(409, "registry_credentials_exist", `Des identifiants existent déjà pour « ${registry} » : supprimez-les d'abord dans les registres d'images.`);
    }

    const password = newRegistryPassword();
    const generated = generateRegistry(opts, await htpasswdLine(password));
    const { id } = await createStack(pool, {
      name: REGISTRY_STACK_NAME,
      hostId: traefik.stack.host_id,
      description: "Registre d'images privé (généré par la console)",
      compose: generated.compose,
      variables: {},
      files: generated.files,
      sensitiveFiles: [REGISTRY_AUTH_FILE],
      managedBy: "registry",
      author: request.actor,
    });

    const settings: RegistrySettings = {
      stackId: id,
      hostId: traefik.stack.host_id,
      host: registry,
      entryPoint: opts.traefik.entryPoint,
      certResolver: opts.traefik.certResolver,
      network: opts.traefik.network,
    };
    try {
      await registries.upsert(registry, { username: REGISTRY_USERNAME, password, insecure: false }, request.actor);
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('registry', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
        [JSON.stringify(settings)],
      );
    } catch (err) {
      // Pas d'application à moitié créée : sans réglage ni identifiants, elle ne serait ni gérée ni utilisable.
      await pool.query("DELETE FROM stacks WHERE id = $1", [id]);
      await pool.query("DELETE FROM registry_credentials WHERE registry = $1", [registry]);
      throw err;
    }
    await audit(pool, request.actor, "settings.registry", `application ${id}`, "success");
    return reply.code(201).send({ id, revision: 1, settings });
  });

  /** Réglage et application existants, ou une erreur claire. */
  async function configured(): Promise<{ settings: RegistrySettings; stack: StackInfo }> {
    const settings = await getRegistrySettings(pool);
    if (!settings) throw new HttpError(409, "registry_not_configured", "Aucune application registry n'est configurée.");
    const stack = await stackOf(settings.stackId);
    if (!stack) throw new HttpError(409, "registry_missing", "L'application registry a été supprimée.");
    return { settings, stack };
  }

  // Identifiants (affichés à l'administrateur, pour un « docker login » à la main) : jamais dans les journaux.
  app.post("/api/v1/settings/registry/credentials", { preHandler: auth }, async (request, reply) => {
    const { settings } = await configured();
    const creds = await registries.credentials(settings.host);
    if (!creds?.password) throw new HttpError(409, "registry_password_missing", "Le mot de passe n'est plus disponible : renouvelez-le.");
    await audit(pool, request.actor, "settings.registry.reveal", settings.host, "success");
    reply.header("Cache-Control", "no-store");
    return { registry: settings.host, username: REGISTRY_USERNAME, password: creds.password };
  });

  // Nouveau mot de passe : nouvelle révision (non déployée) et nouveaux identifiants enregistrés.
  app.post("/api/v1/settings/registry/rotate", { preHandler: auth }, async (request) => {
    const { settings, stack } = await configured();
    if (stack.managed_by !== "registry") throw new HttpError(409, "registry_detached", "L'application est détachée de la gestion automatique : modifiez-la à la main.");
    const traefik = await traefikContext();
    if (!traefik.ok) throw new HttpError(409, "traefik_not_configured", traefik.reason);
    const password = newRegistryPassword();
    const line = await htpasswdLine(password);
    const result = await changeStack(
      pool,
      stack.id,
      stack.current_revision,
      request.actor,
      "Mot de passe du registre renouvelé",
      (c) => ({ ...c, files: { ...c.files, [REGISTRY_AUTH_FILE]: `${line}\n` }, sensitiveFiles: [...new Set([...c.sensitiveFiles, REGISTRY_AUTH_FILE])] }),
      { allowManaged: true },
    );
    await registries.upsert(settings.host, { username: REGISTRY_USERNAME, password, insecure: false }, request.actor);
    await audit(pool, request.actor, "settings.registry.rotate", settings.host, "success");
    return { revision: result.revision, changed: result.changed };
  });

  // Contrôle ce que verront les hôtes : DNS, certificat, authentification.
  app.post("/api/v1/settings/registry/test", { preHandler: auth }, async () => {
    const { settings } = await configured();
    const creds = await registries.credentials(settings.host);
    return probeRegistry(settings.host, creds?.username && creds.password ? { username: creds.username, password: creds.password } : null);
  });

  // Rend l'application modifiable à la main : la console n'en régénère plus le contenu.
  app.post("/api/v1/settings/registry/detach", { preHandler: auth }, async (request) => {
    const { settings, stack } = await configured();
    if (stack.managed_by !== "registry") throw new HttpError(409, "registry_detached", "L'application est déjà détachée.");
    await pool.query("UPDATE stacks SET managed_by = NULL WHERE id = $1", [stack.id]);
    await audit(pool, request.actor, "settings.registry.detach", settings.host, "success");
    return { detached: true };
  });
}
