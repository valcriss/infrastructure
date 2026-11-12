import { RESERVED_STACK_NAMES } from "@infra/shared";
import type { Pool } from "./db.js";
import type { ImageUser, UsedImage } from "./images.js";
import { getRegistrySettings } from "./registry-app-routes.js";
import { getTraefikSettings } from "./traefik-routes.js";

/**
 * Images d'infrastructure : celles des applications qui portent le registre lui-même (registre, Traefik) et des projets de
 * la console et de son agent. Les corriger puis les stocker dans le registre créerait une dépendance circulaire : le
 * registre n'est joignable que par Traefik, et Traefik (ou le registre) devrait se télécharger depuis lui-même. Après un
 * nettoyage de l'hôte, un nouvel hôte ou un volume perdu, rien ne pourrait plus redémarrer. Leur mise à jour passe par
 * une version officielle de l'image.
 */
export const INFRASTRUCTURE_MESSAGE =
  "Cette image fait partie de l'infrastructure de la console (registre, Traefik, console ou agent) : la corriger puis la stocker dans le registre créerait une dépendance circulaire (le registre n'est joignable que par ces composants). Mettez-la à jour vers une version officielle de l'image (onglet « Sécurité et versions »).";

export const INFRASTRUCTURE_TARGET_REASON =
  "Application d'infrastructure (registre ou Traefik) : son image ne doit pas dépendre du registre qu'elle fait fonctionner (dépendance circulaire). Mettez-la à jour vers une version officielle de l'image.";

/**
 * Applications d'infrastructure : celles que la console génère et entretient (`managed_by`), plus celles désignées par les
 * réglages du registre et de Traefik (même détachées de la gestion automatique ou, pour Traefik, non verrouillées).
 */
export async function infrastructureStacks(pool: Pick<Pool, "query">): Promise<Set<string>> {
  const ids = new Set<string>();
  const managed = await pool.query<{ id: string }>("SELECT id FROM stacks WHERE managed_by IS NOT NULL");
  for (const r of managed.rows) ids.add(r.id);
  const [registry, traefik] = await Promise.all([getRegistrySettings(pool), getTraefikSettings(pool)]);
  if (registry?.stackId) ids.add(registry.stackId);
  if (traefik?.stackId) ids.add(traefik.stackId);
  return ids;
}

/** Ce conteneur appartient à l'infrastructure : application d'infrastructure, ou projet de la console ou de son agent. */
export function isInfrastructureUser(u: Pick<ImageUser, "stackId" | "stackName" | "project">, stacks: Set<string>): boolean {
  if (u.stackId !== null && stacks.has(u.stackId)) return true;
  return [u.project, u.stackName].some((n) => n !== null && RESERVED_STACK_NAMES.includes(n));
}

/**
 * L'image n'est utilisée QUE par l'infrastructure. Une image partagée avec une application ordinaire reste corrigeable
 * (pour cette application) ; l'application d'infrastructure, elle, ne peut pas recevoir l'image corrigée.
 */
export function isInfrastructureImage(img: Pick<UsedImage, "usedBy">, stacks: Set<string>): boolean {
  return img.usedBy.length > 0 && img.usedBy.every((u) => isInfrastructureUser(u, stacks));
}
