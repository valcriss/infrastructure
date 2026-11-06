import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BackupService } from "./backup.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Dépôt de sauvegarde : HTTPS + identifiant + jeton (le jeton n'est jamais renvoyé). */
export const BackupConfigBody = z.object({
  url: z.string().min(1).max(512),
  username: z.string().min(1).max(128),
  /** Obligatoire à la première configuration ; absent = conserver le jeton actuel. */
  token: z.string().min(1).max(512).optional(),
  branch: z.string().min(1).max(100).default("main"),
});
export const BackupTestBody = BackupConfigBody;
export const RestorePreviewBody = z.object({
  /** Clé de restauration privée (AGE-SECRET-KEY-…), nécessaire si le dépôt contient des secrets. */
  restorationKey: z.string().max(512).optional(),
});
export const RestoreApplyBody = z.object({
  previewId: z.uuid(),
  /** Hôte de la sauvegarde → hôte enrôlé sur cette console. */
  hostMapping: z.record(z.uuid(), z.uuid()).default({}),
  /** Stacks existantes à remplacer explicitement (nouvelle révision, jamais de suppression). */
  replaceStackIds: z.array(z.uuid()).max(1000).default([]),
});

/**
 * Routes de la sauvegarde Git. Configuration, test et restauration manipulent
 * des identifiants : elles sont réservées à la session de l'administrateur.
 * Le statut et la synchronisation peuvent être appelés par un jeton API.
 */
export function registerBackupRoutes(
  app: FastifyInstance,
  deps: { backup: BackupService; session: Guard; apiAuth: Guard },
): void {
  const { backup, session, apiAuth } = deps;

  app.get("/api/v1/backup/status", { preHandler: apiAuth }, async () => backup.status());

  app.post("/api/v1/backup/sync", { preHandler: apiAuth }, async (request, reply) => {
    const { wait } = z.object({ wait: z.coerce.boolean().default(false) }).parse(request.query);
    const run = backup.syncNow(request.actor);
    // Asynchrone par défaut : le push peut prendre du temps et ne doit pas être présumé réussi.
    if (wait) await run;
    else void run.catch(() => {});
    return reply.code(202).send(await backup.status());
  });

  app.put("/api/v1/backup/config", { preHandler: session }, async (request) => {
    const body = BackupConfigBody.parse(request.body);
    return backup.saveConfig(body, request.actor);
  });

  app.delete("/api/v1/backup/config", { preHandler: session }, async (request, reply) => {
    await backup.removeConfig(request.actor);
    return reply.code(204).send();
  });

  app.post("/api/v1/backup/test", { preHandler: session }, async (request) => {
    const body = BackupTestBody.parse(request.body);
    return backup.testConnection(body);
  });

  app.post("/api/v1/backup/restore/preview", { preHandler: session }, async (request) => {
    const body = RestorePreviewBody.parse(request.body ?? {});
    return backup.restorePreview(body.restorationKey ?? null);
  });

  app.post("/api/v1/backup/restore", { preHandler: session }, async (request) => {
    const body = RestoreApplyBody.parse(request.body);
    return backup.restoreApply(body, request.actor);
  });
}
