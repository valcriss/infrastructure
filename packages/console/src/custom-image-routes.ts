import {
  ComposeEditError,
  PACKAGE_MANAGERS,
  editServiceBuild,
  editServiceImageTag,
  generateDockerfile,
  guessPackageManager,
  replaceBaseImage,
  serviceBaseImage,
  validateBaseImage,
  validateFilePath,
  validatePackages,
} from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withTag } from "./candidates.js";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { changeStack, getRevision, type RevisionContent } from "./stacks.js";

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

export const ImageTagBody = z.object({
  expectedRevision: z.number().int().positive(),
  tag: z.string().trim().min(1).max(128),
  message: z.string().max(200).optional(),
});

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

  /** Compose avec l'étiquette changée ; les refus du modèle de Compose deviennent des erreurs HTTP explicites. */
  const retag = (compose: string, service: string, tag: string) => {
    try {
      return editServiceImageTag(compose, service, tag);
    } catch (err) {
      if (err instanceof ComposeEditError) {
        throw new HttpError(err.code === "service_not_found" ? 404 : 422, err.code === "service_not_found" ? "service_not_found" : "unsupported_compose_structure", err.message);
      }
      throw err;
    }
  };

  /**
   * Nouvelle étiquette d'un service : dans le Compose (`image:`) ou, pour un service construit sur l'hôte, sur la ligne
   * FROM de son Dockerfile (image de base). `file` désigne alors le Dockerfile modifié.
   */
  const retagService = (content: RevisionContent, service: string, tag: string) => {
    const base = serviceBaseImage(content.compose, content.files, service);
    if (base === null) {
      const out = retag(content.compose, service, tag);
      return { before: content.compose, after: out.compose, from: out.from, to: out.to, file: null as string | null, next: { ...content, compose: out.compose } };
    }
    if ("error" in base) throw new HttpError(422, "unsupported_compose_structure", base.error);
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) throw new HttpError(400, "invalid_tag", "Étiquette invalide.");
    if (base.ref.includes("@")) throw new HttpError(422, "unsupported_compose_structure", "L'image de base est épinglée par digest : modifiez le Dockerfile à la main.");
    const to = withTag(base.ref, tag);
    if (to === base.ref) throw new HttpError(422, "unsupported_compose_structure", "C'est déjà l'étiquette actuelle de l'image de base.");
    const before = content.files[base.path] ?? "";
    const after = replaceBaseImage(before, base.line, to);
    return { before, after, from: base.ref, to, file: base.path as string | null, next: { ...content, files: { ...content.files, [base.path]: after } } };
  };

  // Utiliser une autre version de l'image (typiquement après une comparaison) : aperçu puis révision, sans déploiement.
  app.post("/api/v1/stacks/:id/services/:service/image-tag/preview", { preHandler: auth }, async (request) => {
    const { id, service } = Params.parse(request.params);
    const body = ImageTagBody.parse(request.body);
    await stackName(id);
    const stack = await pool.query<{ current_revision: number }>("SELECT current_revision FROM stacks WHERE id = $1", [id]);
    if (stack.rows[0]?.current_revision !== body.expectedRevision) throw new HttpError(409, "revision_conflict", "La stack a une révision plus récente : rechargez la page.");
    const rev = await getRevision(pool, id, body.expectedRevision);
    if (!rev) throw new Error("révision courante introuvable");
    const out = retagService(rev, service, body.tag);
    return { before: out.before, after: out.after, from: out.from, to: out.to, file: out.file };
  });

  app.patch("/api/v1/stacks/:id/services/:service/image-tag", { preHandler: auth }, async (request) => {
    const { id, service } = Params.parse(request.params);
    const body = ImageTagBody.parse(request.body);
    return changeStack(pool, id, body.expectedRevision, request.actor, body.message ?? `Image du service ${service} : étiquette ${body.tag}`, (c) => retagService(c, service, body.tag).next, { allowManaged: true });
  });

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
    return { dockerfilePath: out.path, dockerfile: out.dockerfile, before: rev.compose, after: out.compose, image: out.image, baseImage: out.baseImage, guessedPackageManager: guessPackageManager(out.baseImage) };
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
