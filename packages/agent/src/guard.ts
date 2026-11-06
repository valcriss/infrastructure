import { dockerGet } from "./docker.js";

const MAX_REMEMBERED = 5000;

/**
 * Refuse les demandes rejouées (même identifiant déjà reçu) et expirées.
 * La mémoire est bornée ; l'agent exécutant une opération à la fois par stack,
 * un identifiant ancien sorti de la mémoire a de toute façon expiré.
 */
export class ReplayGuard {
  private readonly seen = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** `ok`, `replayed` (à ignorer sans réponse) ou `expired` (à refuser avec un échec explicite). */
  check(id: string, expiresAt?: string): "ok" | "replayed" | "expired" {
    if (this.seen.has(id)) return "replayed";
    if (expiresAt !== undefined && this.now() > Date.parse(expiresAt)) return "expired";
    this.seen.add(id);
    if (this.seen.size > MAX_REMEMBERED) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return "ok";
  }
}

/**
 * Projets Compose que la console ne doit jamais arrêter ni redéployer depuis
 * son propre interface : celui qui exécute l'agent lui-même (lu sur son conteneur)
 * et ceux listés dans PROTECTED_PROJECTS (par exemple le projet de la console).
 */
export class SelfProtection {
  private self: Promise<string | null> | null = null;

  constructor(
    private readonly dockerSocket: string,
    private readonly selfContainer: string | undefined,
    private readonly extra: string[],
  ) {}

  private selfProject(): Promise<string | null> {
    this.self ??= (async () => {
      if (!this.selfContainer) return null;
      try {
        const info = (await dockerGet(this.dockerSocket, `/containers/${encodeURIComponent(this.selfContainer)}/json`)) as {
          Config?: { Labels?: Record<string, string> };
        };
        return info.Config?.Labels?.["com.docker.compose.project"] ?? null;
      } catch {
        return null; // agent hors conteneur (développement) : seule la liste explicite s'applique
      }
    })();
    return this.self;
  }

  async isProtected(project: string): Promise<boolean> {
    return this.extra.includes(project) || (await this.selfProject()) === project;
  }
}
