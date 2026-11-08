import { serviceBaseImage, type ServiceBase } from "@infra/shared";
import type { Pool } from "./db.js";
import { deployedRevision } from "./stacks.js";

/**
 * Image de base (FROM) d'un service construit sur l'hôte, d'après la révision DÉPLOYÉE : c'est celle qui tourne.
 * `null` si le service n'est pas construit (ou la stack jamais déployée) ; `{ error }` s'il l'est mais ne peut pas être suivi.
 */
export async function deployedBase(pool: Pick<Pool, "query">, stackId: string, service: string): Promise<ServiceBase | { error: string } | null> {
  const rev = await deployedRevision(pool, stackId);
  return rev ? serviceBaseImage(rev.compose, rev.files, service) : null;
}
