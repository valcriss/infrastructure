import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { EVENT_TYPES, type EventType, type Notifier } from "./notifications.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const Events = z.object(Object.fromEntries(EVENT_TYPES.map((t) => [t, z.boolean()])) as Record<EventType, z.ZodBoolean>);

export const NotificationBody = z.object({
  enabled: z.boolean(),
  /** Adresse du webhook (HTTPS) : absente = inchangée, chaîne vide = supprimée. Jamais renvoyée par l'API. */
  url: z.string().max(500).optional(),
  /** Origine de la console, pour les liens des messages. */
  baseUrl: z.string().max(200).nullable().optional(),
  events: Events,
  allowPrivate: z.boolean(),
  maxPerHour: z.number().int().min(1).max(200),
});

/**
 * Notifications par webhook : lecture pour tous, écriture, test et secret pour les administrateurs (routes de
 * /settings). Le secret n'est affiché qu'à la demande d'un administrateur, avec audit.
 */
export function registerNotificationRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard; notifier: Notifier }): void {
  const { pool, auth, notifier } = deps;

  app.get("/api/v1/settings/notifications", { preHandler: auth }, async () => ({ settings: await notifier.view(), deliveries: await notifier.deliveries(), eventTypes: EVENT_TYPES }));

  app.put("/api/v1/settings/notifications", { preHandler: auth }, async (request) => {
    const body = NotificationBody.parse(request.body);
    const settings = await notifier.update(body, request.actor);
    return { settings, deliveries: await notifier.deliveries(), eventTypes: EVENT_TYPES };
  });

  app.post("/api/v1/settings/notifications/test", { preHandler: auth }, async (request) => {
    const result = await notifier.sendTest();
    await audit(pool, request.actor, "settings.notifications.test", result.ok ? "envoyé" : "échec", result.ok ? "success" : "failure");
    return { ...result, deliveries: await notifier.deliveries() };
  });

  app.post("/api/v1/settings/notifications/secret/reveal", { preHandler: auth }, async (request, reply) => {
    const secret = await notifier.secret();
    if (!secret) throw new HttpError(409, "no_secret", "Aucun secret : enregistrez d'abord une adresse de webhook.");
    await audit(pool, request.actor, "settings.notifications.reveal", "secret", "success");
    reply.header("Cache-Control", "no-store");
    return { secret };
  });

  app.post("/api/v1/settings/notifications/secret/rotate", { preHandler: auth }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { secret: await notifier.rotateSecret(request.actor) };
  });
}
