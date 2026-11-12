import type { RegistryGcMessage, RegistryGcResult } from "@infra/shared";
import { dockerGet } from "./docker.js";
import { dockerEnv, runCommand } from "./exec.js";

/** Projet et service Compose du registre créé par la console (jamais un autre conteneur). */
export const REGISTRY_PROJECT = "registry";
export const REGISTRY_SERVICE = "registry";
const STORAGE_ROOT = "/var/lib/registry";
const CONFIG_FILE = "/etc/distribution/config.yml";
const GC_TIMEOUT_MS = 15 * 60_000;

/** Image officielle du registre (`registry:3.0.0`), avec ou sans nom de domaine : rien d'autre n'est jamais ciblé. */
export function isRegistryImage(image: string): boolean {
  return /^(docker\.io\/)?(library\/)?registry:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image);
}

/** Arguments (fixes) de `docker exec` pour le ramasse-miettes ; seule la simulation est paramétrable. */
export function registryGcArgs(container: string, dryRun: boolean): string[] {
  return ["exec", container, "registry", "garbage-collect", CONFIG_FILE, ...(dryRun ? ["--dry-run"] : [])];
}

/** Kio occupés d'après `du -sk` (« 3824\t/var/lib/registry »). */
export function parseDuKb(output: string): number | null {
  const m = /^(\d+)\s/.exec(output.trim());
  return m ? Number(m[1]) : null;
}

const tail = (s: string, n: number): string => (s.length <= n ? s : `…${s.slice(-n)}`);

/**
 * Ramasse-miettes du registre géré : commande fixe, dans l'unique conteneur du projet « registry » dont l'image est
 * l'image officielle du registre. Mesure l'espace occupé avant et après.
 */
export async function runRegistryGc(msg: Pick<RegistryGcMessage, "requestId" | "dryRun">, socket: string): Promise<RegistryGcResult> {
  const base = { type: "registry_gc_result" as const, requestId: msg.requestId, dryRun: msg.dryRun };
  const fail = (error: string, output?: string): RegistryGcResult => ({ ...base, status: "failed", error, ...(output ? { output: tail(output, 5000) } : {}) });
  const env = dockerEnv(socket);

  let containers: { Id: string; State?: string }[];
  try {
    const filters = JSON.stringify({ label: [`com.docker.compose.project=${REGISTRY_PROJECT}`, `com.docker.compose.service=${REGISTRY_SERVICE}`] });
    containers = (await dockerGet(socket, `/containers/json?filters=${encodeURIComponent(filters)}`)) as { Id: string; State?: string }[];
  } catch (err) {
    return fail(`Liste des conteneurs impossible : ${(err as Error).message}`);
  }
  const running = containers.filter((c) => c.State === "running");
  if (running.length !== 1 || !running[0]) return fail(running.length === 0 ? "Le conteneur du registre n'est pas en cours d'exécution sur cet hôte." : "Plusieurs conteneurs du registre : opération refusée.");
  const id = running[0].Id;

  let image: string;
  try {
    image = ((await dockerGet(socket, `/containers/${id}/json`)) as { Config?: { Image?: string } }).Config?.Image ?? "";
  } catch (err) {
    return fail(`Inspection du conteneur impossible : ${(err as Error).message}`);
  }
  if (!isRegistryImage(image)) return fail("Le conteneur « registry » n'utilise pas l'image officielle du registre : opération refusée.");

  const used = async (): Promise<number | undefined> => {
    const r = await runCommand("docker", ["exec", id, "du", "-sk", STORAGE_ROOT], { env, timeoutMs: 60_000 }).catch(() => null);
    return (r && r.code === 0 ? parseDuKb(r.stdout) : null) ?? undefined;
  };
  const before = await used();
  const gc = await runCommand("docker", registryGcArgs(id, msg.dryRun), { env, timeoutMs: GC_TIMEOUT_MS }).catch((err: unknown) => ({ code: -1, timedOut: false, stdout: "", stderr: (err as Error).message }));
  const output = tail(`${gc.stdout}\n${gc.stderr}`.trim(), 5000);
  if (gc.timedOut) return fail("Délai dépassé pendant le ramasse-miettes.", output);
  if (gc.code !== 0) return fail(`Le ramasse-miettes a échoué (code ${gc.code}).`, output);
  const after = await used();
  return { ...base, status: "succeeded", output, ...(before !== undefined ? { usedBeforeKb: before } : {}), ...(after !== undefined ? { usedAfterKb: after } : {}) };
}
