import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "./http-error.js";
import { PruneOptionsSchema, type PruneService } from "./host-prune.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const Params = z.object({ id: z.uuid() });
export const PreviewBody = z.object({ options: PruneOptionsSchema });
export const PruneBody = z.object({
  options: PruneOptionsSchema,
  /** Nom de l'hôte, à saisir pour confirmer la suppression de volumes. */
  confirmHostName: z.string().max(200).optional(),
});

/**
 * Espace disque Docker d'un hôte et nettoyage. La lecture est ouverte aux jetons API ; le nettoyage (destructif) et
 * l'actualisation du relevé exigent la session de l'administrateur : un jeton, même en écriture, ne peut rien supprimer.
 */
export function registerHostDiskRoutes(app: FastifyInstance, deps: { auth: Guard; session: Guard; pruning: PruneService }): void {
  const { auth, session, pruning } = deps;

  app.get("/api/v1/hosts/:id/disk-usage", { preHandler: auth }, async (request) => {
    const { id } = Params.parse(request.params);
    return pruning.latest(id);
  });

  app.post("/api/v1/hosts/:id/disk-usage/refresh", { preHandler: session }, async (request) => {
    const { id } = Params.parse(request.params);
    await pruning.refresh(id);
    return pruning.latest(id);
  });

  // Aperçu exact de ce qui serait supprimé, sans rien supprimer.
  app.post("/api/v1/hosts/:id/prune/preview", { preHandler: session }, async (request) => {
    const { id } = Params.parse(request.params);
    const body = PreviewBody.parse(request.body);
    return pruning.plan(id, body.options);
  });

  app.post("/api/v1/hosts/:id/prune", { preHandler: session }, async (request, reply) => {
    const { id } = Params.parse(request.params);
    const body = PruneBody.parse(request.body);
    const run = await pruning.run(id, body.options, request.actor, body.confirmHostName);
    return reply.code(202).header("Location", `/api/v1/prune-runs/${run.id}`).send({ run });
  });

  app.get("/api/v1/hosts/:id/prune-runs", { preHandler: auth }, async (request) => {
    const { id } = Params.parse(request.params);
    return { runs: await pruning.history(id) };
  });

  app.get("/api/v1/prune-runs/:runId", { preHandler: auth }, async (request) => {
    const { runId } = z.object({ runId: z.uuid() }).parse(request.params);
    const run = await pruning.get(runId);
    if (!run) throw new HttpError(404, "prune_run_not_found", "Nettoyage introuvable");
    return { run };
  });
}
