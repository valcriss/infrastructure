/** Rôles fixes : lecteur < opérateur < administrateur. Le droit « Terminal » est à part (voir `users`). */
export type Role = "viewer" | "operator" | "admin";
export const ROLES: readonly Role[] = ["viewer", "operator", "admin"];
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export const hasRole = (have: Role, need: Role): boolean => RANK[have] >= RANK[need];

// Routes réservées aux administrateurs, quelle que soit la méthode.
const ADMIN_ANY = [
  /^\/api\/v1\/users(\/|$)/,
  /^\/api\/v1\/api-tokens(\/|$)/,
  /^\/api\/v1\/admin\/restoration-key$/,
  /^\/api\/v1\/registries(\/|$)/,
  /^\/api\/v1\/agents\/enrollment-tokens$/,
  /^\/api\/v1\/terminal-recordings(\/|$)/,
];
// Réservées aux administrateurs pour toute écriture (la lecture reste ouverte : état, seuils affichés).
const ADMIN_WRITE = [/^\/api\/v1\/vulnerability-acceptances(\/|$)/, /^\/api\/v1\/settings(\/|$)/, /^\/api\/v1\/backup(\/|$)/, /^\/api\/v1\/hosts\/:id$/, /^\/api\/v1\/hosts\/:id\/prune/];
// Actions sur son propre compte : tout utilisateur connecté.
const SELF = [/^\/api\/v1\/admin\/credentials$/, /^\/api\/v1\/me(\/|$)/];
// Export d'une stack (POST car il porte une confirmation) : tout utilisateur connecté pour l'export sans secrets ;
// l'inclusion des valeurs sensibles est réservée aux administrateurs par la route elle-même.
const VIEWER_POST = [/^\/api\/v1\/stacks\/:id\/export$/];

/**
 * Rôle minimal pour une route, d'après son motif (`/api/v1/stacks/:id/deploy`) et sa méthode.
 * Règle par défaut : lecture = lecteur, écriture = opérateur.
 */
export function requiredRole(method: string, routeUrl: string): Role {
  if (SELF.some((r) => r.test(routeUrl))) return "viewer";
  if (method === "POST" && VIEWER_POST.some((r) => r.test(routeUrl))) return "viewer";
  if (ADMIN_ANY.some((r) => r.test(routeUrl))) return "admin";
  // Suppression d'une application (irréversible) : plan, retrait de l'hôte et suppression de la configuration.
  if (/^\/api\/v1\/stacks\/:id\/(removal-plan|destroy)$/.test(routeUrl) || (method === "DELETE" && /^\/api\/v1\/stacks\/:id$/.test(routeUrl))) return "admin";
  const read = method === "GET" || method === "HEAD";
  if (!read && ADMIN_WRITE.some((r) => r.test(routeUrl))) return "admin";
  return read ? "viewer" : "operator";
}
