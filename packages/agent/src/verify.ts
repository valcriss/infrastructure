import type { VerifyCheck, VerifyRun } from "@infra/shared";

/** Durée maximale d'une vérification (la commande est tuée au-delà). */
export const VERIFY_TIMEOUT_MS = 30_000;

/**
 * Arguments (fixes) du conteneur jetable de vérification : aucun réseau, système de fichiers en lecture seule, aucune
 * capacité, aucune élévation de privilèges, aucun volume ni variable d'environnement de l'application, ressources
 * bornées. L'image est déjà présente : jamais de téléchargement. La commande est passée à l'image (après son
 * ENTRYPOINT), sans shell.
 */
export function verifyRunArgs(name: string, image: string, command: string[]): string[] {
  return [
    "run", "--name", name, "--pull", "never",
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "64", "--cpus", "1",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
    image, ...command,
  ];
}

/**
 * Résultat d'une exécution. La sortie n'est jamais transmise : seul compte ce qu'elle prouve (code de sortie, texte
 * attendu présent ou non), car elle pourrait contenir des données de l'image.
 */
export function evaluateRun(check: VerifyCheck, res: { code: number | null; timedOut: boolean; output: string }): VerifyRun {
  const outputMatched = check.outputContains === null ? null : res.output.includes(check.outputContains);
  return {
    ok: !res.timedOut && res.code === check.expectExit && outputMatched !== false,
    exitCode: res.timedOut ? null : res.code,
    timedOut: res.timedOut,
    outputMatched,
  };
}

/** Exécution d'une commande Docker (le patcher y branche sa propre fonction : annulable, secrets masqués). */
export type VerifyExec = (args: string[], timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean; stdout: string; tail: string }>;

/** Lance la vérification dans un conteneur jetable (supprimé dans tous les cas) et en rend le résultat. */
export async function runVerify(exec: VerifyExec, name: string, image: string, check: VerifyCheck, timeoutMs: number = VERIFY_TIMEOUT_MS): Promise<VerifyRun> {
  const res = await exec(verifyRunArgs(name, image, check.command), timeoutMs);
  await exec(["rm", "-f", name], 20_000).catch(() => undefined);
  return evaluateRun(check, { code: res.code, timedOut: res.timedOut, output: `${res.stdout}\n${res.tail}` });
}
