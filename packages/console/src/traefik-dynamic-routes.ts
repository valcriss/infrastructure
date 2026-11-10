import {
  DynamicEditError,
  TRAEFIK_DYNAMIC_FILE,
  editDynamic,
  hasBasicAuth,
  readDynamic,
  type DynamicChange,
  type DynamicContext,
} from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { changeStack, getRevision } from "./stacks.js";
import { getTraefikSettings, type TraefikSettings } from "./traefik-routes.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

// --- Corps de requête ---------------------------------------------------------------------------------

const MiddlewareSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ipAllowList"), sourceRange: z.array(z.string().max(64)).max(50) }),
  z.object({ type: z.literal("rateLimit"), average: z.number().int(), burst: z.number().int() }),
  z.object({
    type: z.literal("headers"),
    hsts: z.boolean(),
    frameDeny: z.boolean(),
    contentTypeNosniff: z.boolean(),
    referrerPolicy: z.string().max(64),
  }),
  z.object({ type: z.literal("compress") }),
  z.object({ type: z.literal("basicAuth"), users: z.array(z.string().max(200)).max(20) }),
  z.object({ type: z.literal("stripPrefix"), prefixes: z.array(z.string().max(128)).max(5) }),
]);
const RouteSpec = z.object({
  hosts: z.array(z.string().max(253)).max(5),
  urls: z.array(z.string().max(300)).max(5),
  middlewares: z.array(z.string().max(100)).max(10).default([]),
});
const Name = z.string().min(1).max(63);
const Change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("middleware"), name: Name, spec: MiddlewareSpec }),
  z.object({ kind: z.literal("middleware-delete"), name: Name }),
  z.object({ kind: z.literal("route"), name: Name, spec: RouteSpec }),
  z.object({ kind: z.literal("route-delete"), name: Name }),
]);
export const DynamicBody = z.object({
  expectedRevision: z.number().int().positive(),
  change: Change,
  /** Supprimer un middleware même s'il est utilisé par des applications (leurs labels deviendraient invalides). */
  force: z.boolean().default(false),
  message: z.string().max(200).optional(),
});

// --- Accès au fichier ---------------------------------------------------------------------------------

interface Loaded {
  settings: TraefikSettings;
  stackId: string;
  stackName: string;
  revision: number;
  text: string;
  fileMissing: boolean;
  sensitive: boolean;
  ctx: DynamicContext;
}

/** Fichier `dynamic/dynamic.yml` de la révision courante de l'application Traefik ; une raison si indisponible. */
async function loadDynamic(pool: Pool): Promise<{ ok: true; value: Loaded } | { ok: false; reason: string }> {
  const settings = await getTraefikSettings(pool);
  if (!settings) return { ok: false, reason: "Traefik n'est pas configuré : créez d'abord l'application Traefik." };
  const stack = await pool.query<{ name: string; current_revision: number }>("SELECT name, current_revision FROM stacks WHERE id = $1", [settings.stackId]);
  const row = stack.rows[0];
  if (!row) return { ok: false, reason: "L'application Traefik a été supprimée." };
  const rev = await getRevision(pool, settings.stackId, row.current_revision);
  if (!rev) return { ok: false, reason: "Révision de l'application Traefik introuvable." };
  const text = rev.files[TRAEFIK_DYNAMIC_FILE];
  return {
    ok: true,
    value: {
      settings,
      stackId: settings.stackId,
      stackName: row.name,
      revision: row.current_revision,
      text: text ?? "",
      fileMissing: text === undefined,
      sensitive: rev.sensitiveFiles.includes(TRAEFIK_DYNAMIC_FILE),
      ctx: { entryPoint: settings.httpsEntryPoint, certResolver: settings.certResolver },
    },
  };
}

function asHttpError(err: unknown): never {
  if (err instanceof DynamicEditError) {
    const map = { invalid: [400, "invalid_change"], not_found: [404, "not_found"], not_editable: [422, "not_editable"], in_use: [409, "middleware_in_use"], conflict: [409, "name_conflict"], unsupported: [422, "unsupported_file"] } as const;
    const [status, code] = map[err.code];
    throw new HttpError(status, code, err.message, err.details.length > 0 ? { usedBy: err.details } : undefined);
  }
  throw err;
}

const describeChange = (c: DynamicChange): string => {
  switch (c.kind) {
    case "middleware":
      return `Traefik : middleware « ${c.name} » enregistré`;
    case "middleware-delete":
      return `Traefik : middleware « ${c.name} » supprimé`;
    case "route":
      return `Traefik : route « ${c.name} » enregistrée`;
    case "route-delete":
      return `Traefik : route « ${c.name} » supprimée`;
  }
};

/** Applications (hors Traefik) dont le Compose référence ce middleware (`nom@file`). */
async function applicationsUsing(pool: Pool, traefikStackId: string, names: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(names.map((n) => [n, []]));
  if (names.length === 0) return out;
  const { rows } = await pool.query<{ name: string; compose: string }>(
    `SELECT s.name, r.compose FROM stacks s JOIN stack_revisions r ON r.stack_id = s.id AND r.revision = s.current_revision WHERE s.id <> $1`,
    [traefikStackId],
  );
  for (const stack of rows) {
    for (const n of names) if (new RegExp(`(^|[^A-Za-z0-9_.-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@file([^A-Za-z0-9_.-]|$)`).test(stack.compose)) out.get(n)?.push(stack.name);
  }
  return out;
}

// --- Routes -------------------------------------------------------------------------------------------

export function registerTraefikDynamicRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard }): void {
  const { pool, auth } = deps;

  app.get("/api/v1/settings/traefik/dynamic", { preHandler: auth }, async (request) => {
    // Les empreintes de mots de passe ne sont montrées qu'aux administrateurs (qui peuvent modifier le middleware).
    const isAdmin = request.user?.role === "admin";
    const loaded = await loadDynamic(pool);
    if (!loaded.ok) return { available: false, reason: loaded.reason };
    const v = loaded.value;
    const base = { available: true, stack: { id: v.stackId, name: v.stackName }, revision: v.revision, path: TRAEFIK_DYNAMIC_FILE, entryPoint: v.ctx.entryPoint, certResolver: v.ctx.certResolver, fileMissing: v.fileMissing, sensitive: v.sensitive };
    const read = readDynamic(v.text, v.ctx);
    if (!read.ok) return { ...base, parseError: read.error, middlewares: [], routes: [] };
    const apps = await applicationsUsing(pool, v.stackId, read.middlewares.map((m) => m.name));
    return {
      ...base,
      parseError: null,
      middlewares: read.middlewares.map((m) => ({
        ...m,
        spec: m.spec?.type === "basicAuth" && !isAdmin ? { type: "basicAuth" as const, users: m.spec.users.map((u) => `${u.split(":")[0]}:••••••••`) } : m.spec,
        usedBy: {
          routes: read.routes.filter((r) => r.middlewares.some((x) => x === m.name || x === `${m.name}@file`)).map((r) => r.name),
          applications: apps.get(m.name) ?? [],
        },
      })),
      routes: read.routes,
    };
  });

  /** Valide le changement, applique l'édition et rend les contenus avant et après. */
  async function prepare(raw: unknown): Promise<{ body: z.infer<typeof DynamicBody>; loaded: Loaded; next: string }> {
    const body = DynamicBody.parse(raw);
    const loaded = await loadDynamic(pool);
    if (!loaded.ok) throw new HttpError(409, "traefik_unavailable", loaded.reason);
    const v = loaded.value;
    if (v.revision !== body.expectedRevision) throw new HttpError(409, "revision_conflict", "L'application Traefik a une révision plus récente : rechargez la page.");
    if (body.change.kind === "middleware-delete" && !body.force) {
      const used = (await applicationsUsing(pool, v.stackId, [body.change.name])).get(body.change.name) ?? [];
      if (used.length > 0) {
        throw new HttpError(409, "middleware_in_use", `Le middleware « ${body.change.name} » est utilisé par des applications : leurs routes échoueraient.`, { usedBy: used });
      }
    }
    try {
      return { body, loaded: v, next: editDynamic(v.text, body.change as DynamicChange, v.ctx) };
    } catch (err) {
      return asHttpError(err);
    }
  }

  app.post("/api/v1/settings/traefik/dynamic/preview", { preHandler: auth }, async (request) => {
    const { loaded, next } = await prepare(request.body);
    return { before: loaded.text, after: next };
  });

  app.patch("/api/v1/settings/traefik/dynamic", { preHandler: auth }, async (request) => {
    const { body, loaded, next } = await prepare(request.body);
    const message = body.message ?? describeChange(body.change as DynamicChange);
    const result = await changeStack(pool, loaded.stackId, body.expectedRevision, request.actor, message, (c) => ({
      ...c,
      files: { ...c.files, [TRAEFIK_DYNAMIC_FILE]: next },
      // Les empreintes de mots de passe ne doivent pas figurer en clair dans la sauvegarde Git.
      sensitiveFiles: hasBasicAuth(next) && !c.sensitiveFiles.includes(TRAEFIK_DYNAMIC_FILE) ? [...c.sensitiveFiles, TRAEFIK_DYNAMIC_FILE] : c.sensitiveFiles,
    }));
    await audit(pool, request.actor, "settings.traefik.dynamic", `${body.change.kind} ${body.change.name}`, "success");
    return { ...result, sensitive: hasBasicAuth(next) || loaded.sensitive };
  });
}
