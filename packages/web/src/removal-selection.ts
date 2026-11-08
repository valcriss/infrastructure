import type { RemovalHostPlan } from "./api";

export interface RemovalSelection {
  networks: boolean;
  workspace: boolean;
  /** Noms des volumes à supprimer : aucun par défaut (les données sont perdues pour de bon). */
  volumes: string[];
  /** Références des images à supprimer : celles qu'aucun autre projet n'utilise. */
  images: string[];
}

/** Sélection initiale prudente : réseaux, images inutilisées ailleurs et dossier de travail ; jamais les volumes. */
export function defaultSelection(host: RemovalHostPlan): RemovalSelection {
  return {
    networks: host.networks.length > 0,
    workspace: host.workspace,
    volumes: [],
    images: host.images.filter((i) => i.usedByOthers === 0).map((i) => i.ref),
  };
}

/** Le nom saisi doit être exactement celui de l'application (casse et espaces compris). */
export const nameMatches = (typed: string, name: string): boolean => typed === name;

/** L'hôte a-t-il quelque chose à nettoyer ? Les conteneurs du projet sont toujours retirés quand l'hôte est disponible. */
export function hostHasWork(host: RemovalHostPlan, sel: RemovalSelection): boolean {
  return host.containers.length > 0 || sel.networks || sel.workspace || sel.volumes.length > 0 || sel.images.length > 0;
}
