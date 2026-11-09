export interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** Préfixes de chemin qui gardent l'entrée active (ex. /stacks/… pour Applications). */
  match?: string[];
}

/** Entrées principales du menu latéral. */
export const MAIN_NAV: NavItem[] = [
  { to: "/dashboard", label: "Tableau de bord", icon: "gauge-high" },
  { to: "/stacks", label: "Applications", icon: "boxes-stacked", match: ["/stacks"] },
  { to: "/containers", label: "Conteneurs", icon: "cube" },
  { to: "/images", label: "Images", icon: "layer-group" },
  { to: "/statut", label: "Statut", icon: "heart-pulse" },
];

/** Entrées d'administration, sous un séparateur. */
export const ADMIN_NAV: NavItem[] = [
  { to: "/hosts", label: "Hôtes", icon: "server" },
  { to: "/settings", label: "Paramètres", icon: "gear" },
];
