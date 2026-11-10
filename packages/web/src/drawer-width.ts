// Largeur du tiroir latéral : un tiers de la page au départ, jamais moins, au plus 90 % ; sous 768 px de large,
// le tiroir prend toute la page (pas de poignée de redimensionnement).

export const DRAWER_MIN_RATIO = 1 / 3;
export const DRAWER_MAX_RATIO = 0.9;
export const DRAWER_NARROW_PX = 768;
export const DRAWER_KEY = "console.drawer.width";
/** Pas d'un déplacement de la poignée au clavier. */
export const DRAWER_KEY_STEP = 24;

export const isNarrow = (viewport: number): boolean => viewport < DRAWER_NARROW_PX;

export const minWidth = (viewport: number): number => Math.round(viewport * DRAWER_MIN_RATIO);
export const maxWidth = (viewport: number): number => Math.round(viewport * DRAWER_MAX_RATIO);

/** Largeur affichée : la préférence mémorisée si elle est valide, sinon un tiers ; ramenée dans les bornes de la fenêtre. */
export function drawerWidth(saved: unknown, viewport: number): number {
  const wanted = typeof saved === "number" && Number.isFinite(saved) ? saved : minWidth(viewport);
  return Math.min(maxWidth(viewport), Math.max(minWidth(viewport), Math.round(wanted)));
}

/** Largeur pour une poignée tirée jusqu'à l'abscisse `pointerX` (le tiroir est collé au bord droit). */
export const widthFromPointer = (pointerX: number, viewport: number): number => drawerWidth(viewport - pointerX, viewport);
