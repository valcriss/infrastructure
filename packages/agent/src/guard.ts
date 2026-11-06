import { readFile } from "node:fs/promises";
import { dockerGet } from "./docker.js";

const MAX_REMEMBERED = 5000;

/**
 * Refuse les demandes rejouées (même identifiant déjà reçu) et expirées.
 * La mémoire est bornée ; l'agent exécutant une opération à la fois par stack,
 * un identifiant ancien sorti de la mémoire a de toute façon expiré.
 * `now` est l'heure de la console (horloge locale corrigée du décalage mesuré à la connexion) :
 * l'échéance ne dépend donc pas de la justesse de l'horloge de l'hôte.
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

/** Identifiants de conteneur (64 caractères hexadécimaux) cités par /proc/self/mountinfo : survit à un `hostname:` imposé. */
export function containerIdsFromMountinfo(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\/containers\/([0-9a-f]{64})\//g)) ids.add(m[1] as string);
  return [...ids];
}

export interface SelfProtectionOptions {
  /** Remplaçable dans les tests. */
  inspect?: (socket: string, path: string) => Promise<unknown>;
  mountinfo?: () => Promise<string>;
  warn?: (message: string) => void;
}

/**
 * Projets Compose que la console ne doit jamais arrêter ni redéployer depuis
 * son propre interface : celui qui exécute l'agent lui-même (retrouvé depuis son conteneur)
 * et ceux listés dans PROTECTED_PROJECTS (par exemple le projet de la console).
 */
export class SelfProtection {
  private project: string | null = null;
  private warned = false;
  private readonly inspect: NonNullable<SelfProtectionOptions["inspect"]>;
  private readonly mountinfo: NonNullable<SelfProtectionOptions["mountinfo"]>;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly dockerSocket: string,
    private readonly selfContainer: string | undefined,
    private readonly extra: string[],
    options: SelfProtectionOptions = {},
  ) {
    this.inspect = options.inspect ?? dockerGet;
    this.mountinfo = options.mountinfo ?? (() => readFile("/proc/self/mountinfo", "utf8").catch(() => ""));
    this.warn = options.warn ?? (() => {});
  }

  /** Projet de l'agent : seul un succès est mémorisé, un échec (Docker momentanément indisponible) est retenté. */
  private async selfProject(): Promise<string | null> {
    if (this.project) return this.project;
    const candidates = [...new Set([...(this.selfContainer ? [this.selfContainer] : []), ...containerIdsFromMountinfo(await this.mountinfo())])];
    for (const id of candidates) {
      try {
        const info = (await this.inspect(this.dockerSocket, `/containers/${encodeURIComponent(id)}/json`)) as { Config?: { Labels?: Record<string, string> } };
        const label = info.Config?.Labels?.["com.docker.compose.project"];
        if (label) return (this.project = label);
      } catch {
        /* candidat suivant */
      }
    }
    return null;
  }

  async isProtected(project: string): Promise<boolean> {
    if (this.extra.includes(project)) return true;
    const self = await this.selfProject();
    if (self === null && !this.warned) {
      this.warned = true;
      this.warn("projet Compose de l'agent introuvable : seule la liste PROTECTED_PROJECTS protège la console contre un arrêt ou un redéploiement depuis son interface.");
    }
    return self === project;
  }
}
