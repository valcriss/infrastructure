/**
 * Opération encore active (en attente ou en cours) parmi les opérations d'une stack, de la plus récente à la plus
 * ancienne ; null s'il n'y en a pas. Permet de reprendre le suivi après un rafraîchissement de la page.
 */
export function findActiveOperation<T extends { id: string; status: string }>(operations: T[]): T | null {
  return operations.find((o) => o.status === "pending" || o.status === "running") ?? null;
}
