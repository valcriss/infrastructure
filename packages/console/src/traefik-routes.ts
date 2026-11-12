import {
  addTraefikHealthcheck,
  composeHasHealthcheck,
  composeServiceImage,
  generateTraefik,
  keepTraefikImage,
  readTraefikStatic,
  TRAEFIK_DEFAULTS,
  TRAEFIK_DYNAMIC_FILE,
  TRAEFIK_IMAGE,
  TRAEFIK_LOG_LEVELS,
  TRAEFIK_STACK_NAME,
  TRAEFIK_STATIC_FILE,
  traefikConsoleSnippet,
  traefikEquivalent,
  traefikNetworkMode,
  validateTraefikOptions,
  type Container,
  type NetworkInfo,
  type TraefikLogLevel,
  type TraefikOptions,
} from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { selfProjects } from "./display.js";
import { HttpError } from "./http-error.js";
import { changeStack, createStack, getRevision } from "./stacks.js";

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
  /** Adresse Let's Encrypt et niveau de journalisation : mémorisés pour régénérer la configuration (absents des installations plus anciennes tant que l'application n'est pas prise en charge). */
  email?: string;
  logLevel?: TraefikLogLevel;
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
  logLevel: z.enum(TRAEFIK_LOG_LEVELS).default(TRAEFIK_DEFAULTS.logLevel),
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
      const { rows } = await pool.query<{ id: string; name: string; host_id: string; current_revision: number; deployed_revision: number | null; managed_by: string | null }>(
        "SELECT id, name, host_id, current_revision, deployed_revision, managed_by FROM stacks WHERE id = $1",
        [settings.stackId],
      );
      const s = rows[0];
      const host = hostRows.rows.find((h) => h.id === s?.host_id);
      // L'application a pu être supprimée depuis : le réglage reste affiché, avec l'avertissement.
      const rev = s ? await getRevision(pool, s.id, s.current_revision) : null;
      application = s
        ? { healthcheck: rev ? composeHasHealthcheck(rev.compose, TRAEFIK_STACK_NAME) : false, id: s.id, name: s.name, hostId: s.host_id, hostName: host?.name ?? null, currentRevision: s.current_revision, deployedRevision: s.deployed_revision, deployed: s.deployed_revision !== null, managed: s.managed_by === "traefik" }
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
      logLevel: body.logLevel,
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

  // --- Application gérée par la console ---------------------------------------------------------------------
  // Une application prise en charge (managed_by = « traefik ») est régénérée à chaque changement de réglage : traefik.yml et le
  // Compose viennent des réglages, la configuration dynamique (middlewares, routes) et l'image courante sont conservées.

  interface StackRow {
    id: string;
    current_revision: number;
    deployed_revision: number | null;
    managed_by: string | null;
  }
  async function configured(): Promise<{ settings: TraefikSettings; stack: StackRow }> {
    const settings = await getTraefikSettings(pool);
    if (!settings) throw new HttpError(409, "traefik_not_configured", "Aucune application Traefik n'est configurée.");
    const { rows } = await pool.query<StackRow>("SELECT id, current_revision, deployed_revision, managed_by FROM stacks WHERE id = $1", [settings.stackId]);
    if (!rows[0]) throw new HttpError(409, "traefik_missing", "L'application Traefik a été supprimée.");
    return { settings, stack: rows[0] };
  }
  const requireManaged = (stack: StackRow): void => {
    if (stack.managed_by !== "traefik") throw new HttpError(409, "traefik_detached", "L'application Traefik n'est pas gérée par la console (détachée ou pas encore prise en charge).");
  };

  interface OptionChange {
    email?: string;
    production?: boolean;
    logLevel?: TraefikLogLevel;
  }

  /** Options de génération : réglages mémorisés (noms structurels) et Compose actuel (mode du réseau), plus les changements demandés. */
  function optionsFor(settings: TraefikSettings, compose: string, change: OptionChange): TraefikOptions {
    return {
      email: change.email ?? settings.email ?? "",
      production: change.production ?? settings.production,
      httpEntryPoint: settings.httpEntryPoint,
      httpsEntryPoint: settings.httpsEntryPoint,
      certResolver: settings.certResolver,
      logLevel: change.logLevel ?? settings.logLevel ?? TRAEFIK_DEFAULTS.logLevel,
      network: { mode: traefikNetworkMode(compose) ?? "create", name: settings.network },
    };
  }

  async function saveSettings(settings: TraefikSettings): Promise<void> {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('traefik', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [JSON.stringify(settings)]);
  }

  /** Nouvelle révision générée à partir des réglages (la configuration dynamique et l'image courante sont conservées). */
  async function regenerate(settings: TraefikSettings, stack: StackRow, change: OptionChange, message: string, actor: string, allowManaged: boolean) {
    const result = await changeStack(
      pool,
      stack.id,
      stack.current_revision,
      actor,
      message,
      (c) => {
        const opts = optionsFor(settings, c.compose, change);
        const invalid = validateTraefikOptions(opts);
        if (invalid) throw new HttpError(400, "invalid_options", invalid);
        const g = generateTraefik(opts);
        return {
          ...c,
          compose: keepTraefikImage(g.compose, composeServiceImage(c.compose, TRAEFIK_STACK_NAME)),
          files: { ...c.files, [TRAEFIK_STATIC_FILE]: g.files[TRAEFIK_STATIC_FILE] as string, [TRAEFIK_DYNAMIC_FILE]: c.files[TRAEFIK_DYNAMIC_FILE] ?? (g.files[TRAEFIK_DYNAMIC_FILE] as string) },
        };
      },
      { allowManaged },
    );
    await saveSettings({
      ...settings,
      ...(change.email !== undefined ? { email: change.email } : {}),
      ...(change.production !== undefined ? { production: change.production } : {}),
      ...(change.logLevel !== undefined ? { logLevel: change.logLevel } : {}),
    });
    return result;
  }

  // Ajoute le healthcheck à une application créée avant. Application gérée : régénérée ; sinon modification ciblée du Compose
  // et de traefik.yml (« ping »), les réglages faits à la main sont conservés. Nouvelle révision, non déployée.
  app.post("/api/v1/settings/traefik/healthcheck", { preHandler: auth }, async (request) => {
    const { settings, stack } = await configured();
    let notes: string[] = [];
    let result;
    if (stack.managed_by === "traefik") {
      const rev = await getRevision(pool, stack.id, stack.current_revision);
      const email = settings.email ?? (rev?.files[TRAEFIK_STATIC_FILE] ? readTraefikStatic(rev.files[TRAEFIK_STATIC_FILE], settings.certResolver)?.email : null) ?? undefined;
      if (!email) throw new HttpError(409, "traefik_options_missing", "L'adresse e-mail de Let's Encrypt est introuvable : enregistrez les réglages de l'application d'abord.");
      result = await regenerate(settings, stack, { email }, "Healthcheck de Traefik ajouté", request.actor, true);
    } else {
      result = await changeStack(pool, settings.stackId, stack.current_revision, request.actor, "Healthcheck de Traefik ajouté", (c) => {
        const patch = addTraefikHealthcheck(c.compose, c.files[TRAEFIK_STATIC_FILE] ?? null);
        notes = patch.notes;
        return { ...c, compose: patch.compose, files: patch.staticConfig === null ? c.files : { ...c.files, [TRAEFIK_STATIC_FILE]: patch.staticConfig } };
      });
    }
    await audit(pool, request.actor, "settings.traefik.healthcheck", `application ${settings.stackId}`, "success");
    return { revision: result.revision, changed: result.changed, notes };
  });

  // Réglages modifiables d'une application gérée : certificats (production ou test), adresse e-mail, journalisation.
  // Les noms d'entrypoints, de résolveur et de réseau restent figés (ils sont repris dans les labels des applications exposées).
  const OptionsBody = z.object({ email: z.string().max(254), production: z.boolean(), logLevel: z.enum(TRAEFIK_LOG_LEVELS) });
  app.post("/api/v1/settings/traefik/options", { preHandler: auth }, async (request) => {
    const body = OptionsBody.parse(request.body);
    const { settings, stack } = await configured();
    requireManaged(stack);
    const change = { email: body.email.trim(), production: body.production, logLevel: body.logLevel };
    const result = await regenerate(settings, stack, change, "Réglages de Traefik modifiés", request.actor, true);
    await audit(pool, request.actor, "settings.traefik.options", `application ${settings.stackId}`, "success");
    return { revision: result.revision, changed: result.changed };
  });

  /** Ce que la console générerait pour reprendre l'application telle qu'elle est (réglages relus de traefik.yml). */
  async function adoption(settings: TraefikSettings, stack: StackRow) {
    const rev = await getRevision(pool, stack.id, stack.current_revision);
    if (!rev) throw new Error("révision courante introuvable");
    const staticText = rev.files[TRAEFIK_STATIC_FILE] ?? null;
    const read = staticText ? readTraefikStatic(staticText, settings.certResolver) : null;
    if (!read?.email) {
      throw new HttpError(409, "static_unreadable", `${TRAEFIK_STATIC_FILE} est illisible ou sans adresse e-mail pour le résolveur « ${settings.certResolver} » : corrigez-le avant de confier l'application à la console.`);
    }
    const notes: string[] = [];
    if (read.production === null) notes.push("Une autorité de certification personnalisée (caServer) est configurée : elle sera remplacée par celle de Let's Encrypt, selon le réglage « production » conservé.");
    const level = (TRAEFIK_LOG_LEVELS as readonly string[]).includes(read.logLevel ?? "") ? (read.logLevel as TraefikLogLevel) : TRAEFIK_DEFAULTS.logLevel;
    const change: Required<OptionChange> = { email: read.email, production: read.production ?? settings.production, logLevel: level };
    const opts = optionsFor(settings, rev.compose, change);
    const invalid = validateTraefikOptions(opts);
    if (invalid) throw new HttpError(409, "static_unreadable", `Réglages relus invalides : ${invalid}`);
    const generated = generateTraefik(opts);
    const image = composeServiceImage(rev.compose, TRAEFIK_STACK_NAME);
    return {
      change,
      notes,
      equivalent: traefikEquivalent({ compose: rev.compose, staticConfig: staticText }, generated, image),
      compose: { before: rev.compose, after: keepTraefikImage(generated.compose, image) },
      staticConfig: { before: staticText ?? "", after: generated.files[TRAEFIK_STATIC_FILE] as string },
    };
  }

  // Aperçu de la prise en charge : ce qui changerait dans le Compose et dans traefik.yml (rien n'est enregistré).
  app.post("/api/v1/settings/traefik/adopt/preview", { preHandler: auth }, async () => {
    const { settings, stack } = await configured();
    if (stack.managed_by !== null) throw new HttpError(409, "traefik_already_managed", "L'application Traefik est déjà gérée par la console.");
    const { change: _change, ...preview } = await adoption(settings, stack);
    return preview;
  });

  // Confie l'application à la console : elle est régénérée à partir de ses réglages (révision non déployée si elle change).
  // Refusé sans « confirm » quand le contenu actuel diffère de ce que la console générerait.
  app.post("/api/v1/settings/traefik/adopt", { preHandler: auth }, async (request) => {
    const body = z.object({ confirm: z.boolean().default(false) }).parse(request.body ?? {});
    const { settings, stack } = await configured();
    if (stack.managed_by !== null) throw new HttpError(409, "traefik_already_managed", "L'application Traefik est déjà gérée par la console.");
    const plan = await adoption(settings, stack);
    if (!plan.equivalent && !body.confirm) {
      throw new HttpError(409, "adoption_changes", "La prise en charge modifierait le Compose ou traefik.yml : relisez l'aperçu et confirmez.");
    }
    let revision = stack.current_revision;
    let changed = false;
    if (!plan.equivalent) {
      const result = await regenerate(settings, stack, plan.change, "Prise en charge de Traefik par la console", request.actor, false);
      revision = result.revision;
      changed = result.changed;
    } else {
      await saveSettings({ ...settings, email: plan.change.email, production: plan.change.production, logLevel: plan.change.logLevel });
    }
    await pool.query("UPDATE stacks SET managed_by = 'traefik' WHERE id = $1 AND managed_by IS NULL", [stack.id]);
    await audit(pool, request.actor, "settings.traefik.adopt", `application ${stack.id}`, "success");
    return { revision, changed, notes: plan.notes };
  });

  // Rend l'application modifiable à la main : la console n'en régénère plus le contenu.
  app.post("/api/v1/settings/traefik/detach", { preHandler: auth }, async (request) => {
    const { stack } = await configured();
    requireManaged(stack);
    await pool.query("UPDATE stacks SET managed_by = NULL WHERE id = $1", [stack.id]);
    await audit(pool, request.actor, "settings.traefik.detach", `application ${stack.id}`, "success");
    return { detached: true };
  });


  // Extrait à copier dans le Compose de la console pour la placer derrière Traefik (elle ne se gère pas elle-même).
  app.post("/api/v1/settings/traefik/console-snippet", { preHandler: auth }, async (request) => {
    const body = z.object({ host: z.string().max(253) }).parse(request.body);
    const settings = await getTraefikSettings(pool);
    if (!settings) throw new HttpError(409, "traefik_not_configured", "Traefik n'est pas configuré : créez d'abord l'application Traefik.");
    try {
      return { snippet: traefikConsoleSnippet({ entryPoint: settings.httpsEntryPoint, certResolver: settings.certResolver, network: settings.network }, body.host.trim().toLowerCase()) };
    } catch (err) {
      throw new HttpError(400, "invalid_host", err instanceof Error ? err.message : "Nom de domaine invalide.");
    }
  });

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
      // Généré et entretenu par la console : ses réglages se modifient dans Paramètres → Traefik (détachable).
      managedBy: "traefik",
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
      email: body.email.trim(),
      logLevel: body.logLevel,
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
