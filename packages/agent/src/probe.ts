import { redact, type AgentMessage, type ImagePullMessage } from "@infra/shared";
import { AUTH_HINT, isAuthDenied, prepareDockerAuth, type DockerAuth } from "./docker-auth.js";
import { dockerGet, dockerRequest, parseImage } from "./docker.js";
import { dockerEnv, runCommand } from "./exec.js";
import { execCapture } from "./terminal.js";

const TOOLS = ["curl", "wget", "node", "python3", "python", "bash", "nc", "busybox"];
const PACKAGE_MANAGERS = ["apk", "apt-get", "dnf", "microdnf", "yum", "zypper"];

// Tests de présence uniquement (`command -v`) : aucune écriture, aucune action sur l'application.
const PROBE_SCRIPT = [
  `for t in ${TOOLS.join(" ")}; do command -v $t >/dev/null 2>&1 && echo "tool:$t"; done`,
  `for p in ${PACKAGE_MANAGERS.join(" ")}; do command -v $p >/dev/null 2>&1 && echo "pm:$p" && break; done`,
  "echo probe-done",
].join("; ");

/** Analyse la sortie de la sonde ; sans la ligne finale, le conteneur n'a pas de shell utilisable. */
export function parseProbe(output: string): { tools: string[]; packageManager?: string; shell: boolean } {
  const lines = output.split("\n").map((l) => l.trim());
  const tools = lines.filter((l) => l.startsWith("tool:")).map((l) => l.slice(5));
  const pm = lines.find((l) => l.startsWith("pm:"))?.slice(3);
  return { tools, ...(pm ? { packageManager: pm } : {}), shell: lines.includes("probe-done") };
}

/** Sondes sur les conteneurs et téléchargements d'images pour comparaison. */
export class Prober {
  constructor(
    private readonly socketPath: string,
    private readonly isProtected: (project: string) => Promise<boolean>,
    private readonly pullEnv: NodeJS.ProcessEnv = dockerEnv(socketPath),
  ) {}

  async tools(probeId: string, containerId: string, emit: (m: AgentMessage) => void): Promise<void> {
    const fail = (error: string): void => emit({ type: "tools_result", probeId, error, tools: [], user: "", shell: false });
    let info: { State?: { Running?: boolean }; Config?: { Labels?: Record<string, string>; User?: string } };
    try {
      info = (await dockerGet(this.socketPath, `/containers/${containerId}/json`)) as typeof info;
    } catch {
      return fail("Conteneur introuvable.");
    }
    if (!info.State?.Running) return fail("Le conteneur n'est pas en cours d'exécution.");
    const project = info.Config?.Labels?.["com.docker.compose.project"];
    if (project && (await this.isProtected(project))) return fail("Conteneur de la console ou de l'agent : sonde refusée.");
    try {
      const { output } = await execCapture(this.socketPath, containerId, ["sh", "-c", PROBE_SCRIPT]);
      const r = parseProbe(output);
      emit({ type: "tools_result", probeId, tools: r.tools, ...(r.packageManager ? { packageManager: r.packageManager } : {}), user: info.Config?.User ?? "", shell: r.shell });
    } catch (err) {
      fail(`Sonde impossible : ${(err as Error).message}`.slice(0, 300));
    }
  }

  /** `docker pull` puis identification de l'image obtenue (identifiant et plateforme). */
  async pull(msg: ImagePullMessage, emit: (m: AgentMessage) => void): Promise<void> {
    const fail = (error: string): void => emit({ type: "image_pull_result", pullId: msg.pullId, status: "failed", error: error.slice(0, 500) });
    let auth: DockerAuth | undefined;
    try {
      auth = await prepareDockerAuth(this.pullEnv, msg.registryAuths);
      const pull = (env: NodeJS.ProcessEnv) => runCommand("docker", ["pull", "--quiet", msg.ref], { env, timeoutMs: 15 * 60_000 });
      let res = await pull(auth.env);
      // Un jeton périmé ne doit pas bloquer une image publique : un seul nouvel essai, sans identifiants.
      if (res.code !== 0 && !res.timedOut && auth.active && isAuthDenied(res.stderr)) res = await pull(this.pullEnv);
      if (res.code !== 0) {
        if (res.timedOut) return fail("Téléchargement trop long (15 min).");
        const detail = (res.stderr || res.stdout).trim().split("\n").pop() || "erreur inconnue";
        return fail(`Téléchargement refusé : ${redact(detail, auth.secrets)}${isAuthDenied(res.stderr) ? ` ${AUTH_HINT}` : ""}`);
      }
      const img = parseImage(await dockerGet(this.socketPath, `/images/${encodeURIComponent(msg.ref)}/json`));
      if (!img) return fail("Image téléchargée introuvable.");
      const platform = img.os && img.arch ? `${img.os}/${img.arch}${img.variant ? `/${img.variant}` : ""}` : "";
      emit({ type: "image_pull_result", pullId: msg.pullId, status: "succeeded", imageId: img.id, platform });
    } catch (err) {
      fail((err as Error).message);
    } finally {
      await auth?.cleanup().catch(() => {});
    }
  }

  /** Retire une image téléchargée pour comparaison. Sans option `force` : Docker refuse si un conteneur l'utilise. */
  async remove(imageId: string): Promise<void> {
    await dockerRequest(this.socketPath, "DELETE", `/images/${encodeURIComponent(imageId)}`).catch(() => undefined);
  }
}
