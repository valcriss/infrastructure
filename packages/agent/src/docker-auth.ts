import type { RegistryAuth } from "@infra/shared";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Contexte d'authentification d'une commande Docker : environnement à utiliser et nettoyage. */
export interface DockerAuth {
  /** Environnement de la CLI Docker ; contient `DOCKER_CONFIG` quand des identifiants sont fournis. */
  env: NodeJS.ProcessEnv;
  /** Vrai si des identifiants sont utilisés (un repli anonyme est alors possible). */
  active: boolean;
  /** Valeurs à masquer dans les journaux (mots de passe et leur encodage). */
  secrets: string[];
  cleanup(): Promise<void>;
}

/** Clé du fichier de configuration Docker pour un registre (Docker Hub a une clé historique). */
export function authKey(registry: string): string {
  return registry === "docker.io" ? "https://index.docker.io/v1/" : registry;
}

/**
 * Prépare une configuration Docker temporaire (`DOCKER_CONFIG`) contenant les identifiants fournis par la console.
 * Pas de `docker login` : rien n'est écrit dans `~/.docker`, le dossier (0700) est supprimé à la fin de la commande.
 */
export async function prepareDockerAuth(base: NodeJS.ProcessEnv, auths: RegistryAuth[] | undefined): Promise<DockerAuth> {
  if (!auths || auths.length === 0) return { env: base, active: false, secrets: [], cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "docker-auth-"));
  try {
    const entries: Record<string, { auth: string }> = {};
    const secrets: string[] = [];
    for (const a of auths) {
      const auth = Buffer.from(`${a.username}:${a.password}`).toString("base64");
      entries[authKey(a.registry)] = { auth };
      secrets.push(a.password, auth);
    }
    await writeFile(join(dir, "config.json"), JSON.stringify({ auths: entries }), { mode: 0o600 });
    return {
      env: { ...base, DOCKER_CONFIG: dir },
      active: true,
      secrets,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** Sortie d'un `docker pull` ou `build` refusé faute de droits (identifiants absents, périmés ou insuffisants). */
export function isAuthDenied(output: string): boolean {
  return /denied|unauthorized|authentication required|requires authentication|no basic auth credentials|insufficient_scope/i.test(output);
}

export const AUTH_HINT = "Registre privé ou identifiants refusés : ajoutez ou corrigez-les dans Paramètres → Registres.";
