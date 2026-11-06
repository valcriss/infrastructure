import type { Inventory } from "@infra/shared";

const size = (inventory: Inventory): number => Buffer.byteLength(JSON.stringify({ type: "inventory", inventory }));

export interface FitResult {
  inventory: Inventory;
  /** Informations facultatives abandonnées pour tenir dans la limite (vide si tout passe). */
  dropped: string[];
}

/**
 * Garantit qu'un inventaire tient dans la limite de taille d'un message. Au-delà, la console fermerait la
 * connexion et l'agent la rouvrirait en boucle sans jamais livrer d'état. On abandonne alors, dans cet ordre,
 * les informations les moins utiles : montages, couches des images, ports et réseaux, liste des images, puis
 * en dernier recours une partie des conteneurs. Le strict nécessaire (conteneurs, états) est conservé le plus longtemps.
 */
export function fitInventory(inventory: Inventory, maxBytes: number): FitResult {
  if (size(inventory) <= maxBytes) return { inventory, dropped: [] };
  const dropped: string[] = [];
  let cur: Inventory = inventory;

  const steps: [string, (i: Inventory) => Inventory][] = [
    ["montages", (i) => ({ ...i, containers: i.containers.map(({ mounts: _m, ...c }) => c) })],
    ["couches des images", (i) => (i.images ? { ...i, images: i.images.map(({ layers: _l, ...img }) => img) } : i)],
    ["ports et réseaux", (i) => ({ ...i, containers: i.containers.map(({ ports: _p, networks: _n, ...c }) => c) })],
    ["images", ({ images: _i, ...rest }) => rest],
  ];
  for (const [label, apply] of steps) {
    cur = apply(cur);
    dropped.push(label);
    if (size(cur) <= maxBytes) return { inventory: cur, dropped };
  }

  // Dernier recours : on retire des conteneurs depuis la fin jusqu'à tenir dans la limite.
  let kept = cur.containers.length;
  while (kept > 0 && size({ ...cur, containers: cur.containers.slice(0, kept) }) > maxBytes) kept = Math.floor(kept * 0.8);
  dropped.push(`${cur.containers.length - kept} conteneur(s)`);
  return { inventory: { ...cur, containers: cur.containers.slice(0, kept) }, dropped };
}
