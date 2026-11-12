import { VerifyCheckSchema, type VerifyCheck } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { exclusionKey, imageKey } from "./remediation-auto.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Vérification de démarrage d'une image : par image (dépôt sans étiquette), car la commande dépend du binaire de l'image. */
export interface VerifyConfig extends VerifyCheck {
  image: string;
}

export const VerifySettingsBody = z.object({
  checks: z
    .array(
      z.object({
        image: z.string().min(1).max(200),
        command: VerifyCheckSchema.shape.command,
        expectExit: z.number().int().min(0).max(255).default(0),
        outputContains: z.string().min(1).max(200).nullable().optional(),
      }),
    )
    .max(50),
});

export async function getVerifyConfigs(pool: Pick<Pool, "query">): Promise<VerifyConfig[]> {
  const { rows } = await pool.query<{ value: { checks?: VerifyConfig[] } }>("SELECT value FROM app_settings WHERE key = 'remediation_verify'");
  return rows[0]?.value.checks ?? [];
}

export async function setVerifyConfigs(pool: Pool, input: z.infer<typeof VerifySettingsBody>): Promise<VerifyConfig[]> {
  const seen = new Set<string>();
  const checks: VerifyConfig[] = input.checks.map((c) => {
    const image = exclusionKey(c.image);
    if (seen.has(image)) throw new HttpError(400, "duplicate_image", `L'image « ${image} » a plusieurs vérifications : une seule par image.`);
    seen.add(image);
    return { image, command: c.command, expectExit: c.expectExit, outputContains: c.outputContains ?? null };
  });
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('remediation_verify', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify({ checks })],
  );
  return checks;
}

/** Vérification configurée pour l'image d'une référence (`nginx:1.27` → celle de `docker.io/library/nginx`), ou null. */
export async function verifyCheckFor(pool: Pick<Pool, "query">, imageRef: string): Promise<VerifyCheck | null> {
  const key = imageKey(imageRef);
  if (!key) return null;
  const found = (await getVerifyConfigs(pool)).find((c) => c.image === key);
  return found ? { command: found.command, expectExit: found.expectExit, outputContains: found.outputContains } : null;
}

/** Lecture : tout utilisateur ; écriture : administrateur (routes de réglages). */
export function registerRemediationVerifyRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard }): void {
  const { pool, auth } = deps;
  app.get("/api/v1/settings/remediation/verification", { preHandler: auth }, async () => ({ checks: await getVerifyConfigs(pool) }));
  app.put("/api/v1/settings/remediation/verification", { preHandler: auth }, async (request) => {
    const checks = await setVerifyConfigs(pool, VerifySettingsBody.parse(request.body));
    await audit(pool, request.actor, "settings.remediation.verification", `${checks.length} vérification(s)`, "success");
    return { checks };
  });
}
