import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "./http-error.js";
import type { RemediationApply } from "./remediation-apply.js";
import type { RemediationService } from "./remediation.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const ImageId = z.string().regex(/^(sha256:)?[0-9a-f]{12,64}$/);
const Platform = z.string().regex(/^linux\/(amd64|arm64)$/);
const normalize = (imageId: string): string => (imageId.startsWith("sha256:") ? imageId : `sha256:${imageId}`);

export const CreateRemediationBody = z.object({
  /** Plateforme de l'image (ex. linux/amd64) ; obligatoire si l'image existe pour plusieurs plateformes. */
  platform: Platform,
  /** Hôte qui exécute le correctif (par défaut : un hôte en ligne portant l'image). */
  hostId: z.uuid().optional(),
});
export const StackRevisionBody = z.object({
  stackId: z.uuid(),
  service: z.string().min(1).max(128),
  /** Révision courante de la stack : un 409 est renvoyé si elle a changé entre-temps. */
  expectedRevision: z.number().int().positive(),
  /** Confirmation explicite pour un correctif « partiel » (des vulnérabilités corrigeables subsistent). */
  acceptPartial: z.boolean().optional(),
  message: z.string().max(200).optional(),
});
export const EligibilityQuery = z.object({ platform: Platform.optional() });
export const ListRemediationsQuery = z.object({
  imageId: ImageId.optional(),
  hostId: z.uuid().optional(),
  status: z.enum(["queued", "preparing", "scanning_before", "patching", "scanning_after", "verifying", "validated", "partial", "rejected", "failed", "unknown", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Remédiation des images : éligibilité, création d'un correctif (jamais de déploiement), suivi et annulation.
 * Lecture : tout utilisateur ; création et annulation : opérateur (règle par défaut des écritures).
 */
export function registerRemediationRoutes(app: FastifyInstance, deps: { auth: Guard; remediation: RemediationService; apply: RemediationApply }): void {
  const { auth, remediation, apply } = deps;

  app.get("/api/v1/images/:imageId/remediation/eligibility", { preHandler: auth }, async (request) => {
    const { imageId } = z.object({ imageId: ImageId }).parse(request.params);
    const q = EligibilityQuery.parse(request.query);
    return remediation.eligibility(normalize(imageId), q.platform ?? null);
  });

  app.post("/api/v1/images/:imageId/remediations", { preHandler: auth }, async (request, reply) => {
    const { imageId } = z.object({ imageId: ImageId }).parse(request.params);
    const body = CreateRemediationBody.parse(request.body);
    const { job, created } = await remediation.create({ imageId: normalize(imageId), platform: body.platform, hostId: body.hostId, requestedBy: request.actor });
    return reply.code(created ? 202 : 200).send({ remediationId: job.id, status: job.status, created, url: `/api/v1/remediations/${job.id}` });
  });

  app.get("/api/v1/remediations", { preHandler: auth }, async (request) => {
    const q = ListRemediationsQuery.parse(request.query);
    return { remediations: await remediation.list({ imageId: q.imageId ? normalize(q.imageId) : undefined, hostId: q.hostId, status: q.status, limit: q.limit }) };
  });

  app.get("/api/v1/remediations/:id", { preHandler: auth }, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const job = await remediation.get(id);
    if (!job) throw new HttpError(404, "remediation_not_found", "Correctif introuvable.");
    return job;
  });

  app.post("/api/v1/remediations/:id/cancel", { preHandler: auth }, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return remediation.cancel(id, request.actor);
  });

  // Utiliser l'image corrigée : services concernés, aperçu du Compose, puis nouvelle révision (jamais déployée ici).
  app.get("/api/v1/remediations/:id/stack-targets", { preHandler: auth }, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return apply.targets(id);
  });

  app.post("/api/v1/remediations/:id/stack-revision/preview", { preHandler: auth }, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return apply.preview(id, StackRevisionBody.parse(request.body));
  });

  app.post("/api/v1/remediations/:id/stack-revision", { preHandler: auth }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const result = await apply.apply(id, StackRevisionBody.parse(request.body), request.actor);
    return reply.code(201).send({ ...result, deployed: false });
  });
}
