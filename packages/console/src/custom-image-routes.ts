import {
  ComposeEditError,
  PACKAGE_MANAGERS,
  editServiceBuild,
  generateDockerfile,
  validateBaseImage,
  validateFilePath,
  validatePackages,
} from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { changeStack, getRevision } from "./stacks.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export const CustomImageBody = z.object({
  expectedRevision: z.number().int().positive(),
  packageManager: z.enum(PACKAGE_MANAGERS as unknown as [string, ...string[]]),
  /** Outils à ajouter (curl, wget…). */
  packages: z.array(z.string().max(80)).max(12).default([]),
  /** Mettre à jour les paquets du système. */
  upgrade: z.boolean().default(false),
  /** Utilisateur du conteneur d'origine, rétabli après l'installation. */
  user: z.string().max(100).default(""),
  /** Dockerfile modifié à la main : remplace le texte généré. */
  dockerfile: z.string().max(20_000).optional(),
  message: z.string().max(200).optional(),
});
type Body = z.infer<typeof CustomImageBody>;

const Params = z.object({ id: z.uuid(), service: z.string().min(1).max(128) });

/** Nom d'image local : minuscules, sans caractère interdit. */
const localImageName = (stack: string, service: string): string => `${stack}-${service}-custom:local`.toLowerCase().replace(/[^a-z0-9._:/-]/g, "-");

export function registerCustomImageRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard }): void {
  const { pool, auth } = deps;

  /** Dockerfile (généré ou modifié) et Compose modifié pour une révision donnée du Compose. */
  const build = (compose: string, stackName: string, service: string, body: Body) => {
    const pkgError = validatePackages(body.packages);
    if (pkgError) throw new HttpError(400, "invalid_packages", pkgError);
    const path = `build/${service}/Dockerfile`;
    const pathError = validateFilePath(path);
    if (pathError) throw new HttpError(400, "invalid_service", `Nom de service inutilisable pour un dossier de construction : ${pathError}`);
    let edited: { compose: string; baseImage: string };
    try {
      edited = editServiceBuild(compose, service, { context: `./build/${service}`, image: localImageName(stackName, service) });
    } catch (err) {
      if (err instanceof ComposeEditError) {
        throw new HttpError(err.code === "service_not_found" ? 404 : 422, err.code === "service_not_found" ? "service_not_found" : "unsupported_compose_structure", err.message);
      }
      throw err;
    }
    const baseError = validateBaseImage(edited.baseImage);
    if (baseError) throw new HttpError(422, "unsupported_base_image", baseError);
    const dockerfile =
      body.dockerfile !== undefined
        ? body.dockerfile
        : generateDockerfile({ base: edited.baseImage, packageManager: body.packageManager as (typeof PACKAGE_MANAGERS)[number], packages: body.packages, upgrade: body.upgrade, user: body.user });
    if (!/^\s*FROM\s+\S+/im.test(dockerfile)) throw new HttpError(400, "invalid_dockerfile", "Le Dockerfile doit contenir une instruction FROM.");
    if (dockerfile.includes("\0")) throw new HttpError(400, "invalid_dockerfile", "Caractère interdit dans le Dockerfile.");
    return { path, dockerfile, compose: edited.compose, image: localImageName(stackName, service), baseImage: edited.baseImage };
  };

  const stackName = async (id: string): Promise<string> => {
    const { rows } = await pool.query<{ name: string }>("SELECT name FROM stacks WHERE id = $1", [id]);
    if (!rows[0]) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    return rows[0].name;
  };

  // Aperçu : Dockerfile généré et Compose modifié, rien n'est enregistré.
  app.post("/api/v1/stacks/:id/services/:service/custom-image/preview", { preHandler: auth }, async (request) => {
    const { id, service } = Params.parse(request.params);
    const body = CustomImageBody.parse(request.body);
    const name = await stackName(id);
    const stack = await pool.query<{ current_revision: number }>("SELECT current_revision FROM stacks WHERE id = $1", [id]);
    if (stack.rows[0]?.current_revision !== body.expectedRevision) throw new HttpError(409, "revision_conflict", "La stack a une révision plus récente : rechargez la page.");
    const rev = await getRevision(pool, id, body.expectedRevision);
    if (!rev) throw new Error("révision courante introuvable");
    const out = build(rev.compose, name, service, body);
    return { dockerfilePath: out.path, dockerfile: out.dockerfile, before: rev.compose, after: out.compose, image: out.image, baseImage: out.baseImage };
  });

  // Enregistrement : une révision contenant le Dockerfile et le Compose modifié. Rien n'est déployé.
  app.patch("/api/v1/stacks/:id/services/:service/custom-image", { preHandler: auth }, async (request) => {
    const { id, service } = Params.parse(request.params);
    const body = CustomImageBody.parse(request.body);
    const name = await stackName(id);
    const result = await changeStack(pool, id, body.expectedRevision, request.actor, body.message ?? `Image personnalisée pour le service ${service}`, (c) => {
      const out = build(c.compose, name, service, body);
      return { ...c, compose: out.compose, files: { ...c.files, [out.path]: out.dockerfile } };
    });
    return result;
  });
}
