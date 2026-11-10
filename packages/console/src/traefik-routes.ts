import {
  generateTraefik,
  TRAEFIK_DEFAULTS,
  TRAEFIK_IMAGE,
  TRAEFIK_STACK_NAME,
  validateTraefikOptions,
  type Container,
  type NetworkInfo,
  type TraefikOptions,
} from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { selfProjects } from "./display.js";
import { HttpError } from "./http-error.js";
import { createStack } from "./stacks.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

// --- Réglage mémorisé ---------------------------------------------------------------------------------

/** Noms choisis à la création de l'application Traefik : les écrans suivants (labels, routes) les proposent. */
export interface TraefikSettings {
  stackId: string;
  hostId: string;
  httpEntryPoint: string;
  httpsEntryPoint: string;
  certResolver: string;
  network: string;
  production: boolean;
}

export async function getTraefikSettings(pool: Pick<Pool, "query">): Promise<TraefikSettings | null> {
  const { rows } = await pool.query<{ value: TraefikSettings }>("SELECT value FROM app_settings WHERE key = 'traefik'");
  return rows[0]?.value ?? null;
}

// --- Réseaux candidats et ports ------------------------------------------------------------------------

export interface NetworkCandidate {
  name: string;
  driver: string;
  /** Applications (projet Compose, ou nom du conteneur hors Compose) rattachées à ce réseau sur l'hôte. */
  usedBy: string[];
  /** Réseau partagé par plusieurs applications ou dont le nom évoque un reverse proxy. */
  suggested: boolean;
}

const PROXY_NAME = /proxy|traefik|public|edge|ingress/i;

/**
 * Réseaux de l'hôte sur lesquels attacher Traefik : réseaux « bridge » définis par l'utilisateur, hors réseaux sans
 * accès extérieur, hors réseau par défaut d'un projet Compose (`<projet>_default`) et hors projets de la console.
 */
export function networkCandidates(networks: NetworkInfo[], containers: Container[], protectedProjects: string[] = []): NetworkCandidate[] {
  const users = new Map<string, Set<string>>();
  for (const c of containers) {
    for (const n of c.networks ?? []) users.set(n, (users.get(n) ?? new Set()).add(c.composeProject ?? c.names[0] ?? c.id.slice(0, 12)));
  }
  return networks
    .filter((n) => n.driver === "bridge" && !n.internal && n.scope === "local")
    .filter((n) => !(n.project && n.name === `${n.project}_default`))
    .filter((n) => !(n.project && protectedProjects.includes(n.project)))
    .map((n) => {
      const usedBy = [...(users.get(n.name) ?? [])].sort();
      return { name: n.name, driver: n.driver, usedBy, suggested: usedBy.length >= 2 || PROXY_NAME.test(n.name) };
    })
    .sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.name.localeCompare(b.name));
}

export interface PortConflict {
  port: number;
  container: string;
}

/** Conteneurs de l'hôte qui publient déjà les ports 80 ou 443 (Traefik ne pourrait pas démarrer). */
export function portConflicts(containers: Container[]): PortConflict[] {
  const out: PortConflict[] = [];
  for (const c of containers) {
    if (c.state !== "running") continue;
    for (const p of c.ports ?? []) {
      if ((p.publicPort === 80 || p.publicPort === 443) && p.type === "tcp" && !out.some((o) => o.port === p.publicPort && o.container === (c.names[0] ?? c.id))) {
        out.push({ port: p.publicPort, container: c.names[0] ?? c.id.slice(0, 12) });
      }
    }
  }
  return out.sort((a, b) => a.port - b.port || a.container.localeCompare(b.container));
}

// --- Routes -------------------------------------------------------------------------------------------

const Body = z.object({
  hostId: z.uuid(),
  email: z.string().max(254),
  production: z.boolean().default(false),
  httpEntryPoint: z.string().max(63).default(TRAEFIK_DEFAULTS.httpEntryPoint),
  httpsEntryPoint: z.string().max(63).default(TRAEFIK_DEFAULTS.httpsEntryPoint),
  certResolver: z.string().max(63).default(TRAEFIK_DEFAULTS.certResolver),
  network: z.object({ mode: z.enum(["create", "existing"]), name: z.string().max(63) }),
});

interface HostRow {
  id: string;
  name: string;
  inventory: Container[] | null;
  networks: NetworkInfo[] | null;
}

export function registerTraefikRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard; isOnline: (hostId: string) => boolean }): void {
  const { pool, auth } = deps;

  app.get("/api/v1/settings/traefik", { preHandler: auth }, async () => {
    const [settings, hostRows] = await Promise.all([
      getTraefikSettings(pool),
      pool.query<HostRow>("SELECT id, name, inventory, networks FROM hosts WHERE revoked_at IS NULL ORDER BY created_at"),
    ]);
    const protectedProjects = selfProjects();

    let application: unknown = null;
    if (settings) {
      const { rows } = await pool.query<{ id: string; name: string; host_id: string; current_revision: number; deployed_revision: number | null }>(
        "SELECT id, name, host_id, current_revision, deployed_revision FROM stacks WHERE id = $1",
        [settings.stackId],
      );
      const s = rows[0];
      const host = hostRows.rows.find((h) => h.id === s?.host_id);
      // L'application a pu être supprimée depuis : le réglage reste affiché, avec l'avertissement.
      application = s
        ? { id: s.id, name: s.name, hostId: s.host_id, hostName: host?.name ?? null, currentRevision: s.current_revision, deployedRevision: s.deployed_revision, deployed: s.deployed_revision !== null }
        : { missing: true };
    }

    return {
      settings,
      application,
      stackName: TRAEFIK_STACK_NAME,
      image: TRAEFIK_IMAGE,
      defaults: { httpEntryPoint: TRAEFIK_DEFAULTS.httpEntryPoint, httpsEntryPoint: TRAEFIK_DEFAULTS.httpsEntryPoint, certResolver: TRAEFIK_DEFAULTS.certResolver, networkName: TRAEFIK_DEFAULTS.network.name },
      hosts: hostRows.rows.map((h) => ({
        id: h.id,
        name: h.name,
        online: deps.isOnline(h.id),
        // null : l'agent de cet hôte ne remonte pas (encore) la liste des réseaux.
        networks: h.networks ? networkCandidates(h.networks, h.inventory ?? [], protectedProjects) : null,
        portConflicts: portConflicts(h.inventory ?? []),
      })),
    };
  });

  /** Valide la saisie (options, hôte, cohérence du réseau) et génère les fichiers ; lève une HttpError sinon. */
  async function prepare(raw: unknown): Promise<{ body: z.infer<typeof Body>; generated: ReturnType<typeof generateTraefik> }> {
    const body = Body.parse(raw);
    const options: TraefikOptions = {
      email: body.email.trim(),
      production: body.production,
      httpEntryPoint: body.httpEntryPoint,
      httpsEntryPoint: body.httpsEntryPoint,
      certResolver: body.certResolver,
      network: body.network,
    };
    const invalid = validateTraefikOptions(options);
    if (invalid) throw new HttpError(400, "invalid_options", invalid);

    const host = await pool.query<HostRow>("SELECT id, name, inventory, networks FROM hosts WHERE id = $1 AND revoked_at IS NULL", [body.hostId]);
    if (!host.rows[0]) throw new HttpError(404, "host_not_found", "Hôte introuvable");
    // Quand l'agent remonte les réseaux, on vérifie le choix : un réseau « existant » doit exister, un réseau à créer ne doit pas.
    const known = host.rows[0].networks;
    if (known) {
      const present = known.some((n) => n.name === body.network.name);
      if (body.network.mode === "existing" && !present) throw new HttpError(400, "network_not_found", `Le réseau « ${body.network.name} » n'existe pas sur cet hôte.`);
      if (body.network.mode === "create" && present) {
        throw new HttpError(409, "network_exists", `Un réseau « ${body.network.name} » existe déjà sur cet hôte : choisissez « Utiliser un réseau existant ».`);
      }
    }
    return { body, generated: generateTraefik(options) };
  }

  // Aperçu des fichiers qui seraient créés : même validation que la création, rien n'est enregistré.
  app.post("/api/v1/settings/traefik/preview", { preHandler: auth }, async (request) => {
    const { generated } = await prepare(request.body);
    return generated;
  });

  // Crée l'application Traefik (révision 1, non déployée) et mémorise les noms choisis.
  app.post("/api/v1/settings/traefik/application", { preHandler: auth }, async (request, reply) => {
    const current = await getTraefikSettings(pool);
    if (current) {
      const exists = await pool.query("SELECT 1 FROM stacks WHERE id = $1", [current.stackId]);
      if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, "traefik_already_configured", "Une application Traefik est déjà configurée.");
    }
    const { body, generated } = await prepare(request.body);

    const { id } = await createStack(pool, {
      name: TRAEFIK_STACK_NAME,
      hostId: body.hostId,
      description: "Reverse proxy Traefik (généré par la console)",
      compose: generated.compose,
      variables: {},
      files: generated.files,
      author: request.actor,
    });

    const settings: TraefikSettings = {
      stackId: id,
      hostId: body.hostId,
      httpEntryPoint: body.httpEntryPoint,
      httpsEntryPoint: body.httpsEntryPoint,
      certResolver: body.certResolver,
      network: body.network.name,
      production: body.production,
    };
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('traefik', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify(settings)],
    );
    await audit(pool, request.actor, "settings.traefik", `application ${id}`, "success");
    return reply.code(201).send({ id, revision: 1, settings });
  });
}
