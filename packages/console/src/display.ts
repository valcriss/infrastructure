import { RESERVED_STACK_NAMES } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, type Pool } from "./db.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface DisplaySettings {
  /** Afficher les éléments de la console elle-même (ses conteneurs et ses images) dans les tableaux de bord, images, etc. */
  showConsole: boolean;
}

export const DEFAULT_DISPLAY: DisplaySettings = { showConsole: true };

export const DisplayBody = z.object({ showConsole: z.boolean() });

/**
 * Projets Compose qui font tourner la console et son agent : ceux réservés par la console, plus ceux listés dans
 * `SELF_PROJECTS` (noms séparés par des virgules) si la console est déployée sous un autre nom de projet.
 */
export function selfProjects(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...RESERVED_STACK_NAMES, ...(env.SELF_PROJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)])];
}

export async function getDisplaySettings(pool: Pick<Pool, "query">): Promise<DisplaySettings> {
  const { rows } = await pool.query<{ value: Partial<DisplaySettings> }>("SELECT value FROM app_settings WHERE key = 'display'");
  return { ...DEFAULT_DISPLAY, ...(rows[0]?.value ?? {}) };
}

/** Projets à masquer des vues (tableaux de bord, applications, images) ; vide si les éléments de la console sont affichés. */
export async function hiddenProjects(pool: Pick<Pool, "query">): Promise<string[]> {
  return (await getDisplaySettings(pool)).showConsole ? [] : selfProjects();
}

export function registerDisplayRoutes(app: FastifyInstance, deps: { pool: Pool; auth: Guard }): void {
  const { pool, auth } = deps;

  app.get("/api/v1/settings/display", { preHandler: auth }, async () => ({ ...(await getDisplaySettings(pool)), selfProjects: selfProjects() }));

  app.put("/api/v1/settings/display", { preHandler: auth }, async (request) => {
    const body = DisplayBody.parse(request.body);
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('display', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify(body)],
    );
    await audit(pool, request.actor, "settings.display", body.showConsole ? "console affichée" : "console masquée", "success");
    return { ...body, selfProjects: selfProjects() };
  });
}
