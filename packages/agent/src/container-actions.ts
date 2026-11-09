import type { AgentMessage, ContainerActionMessage } from "@infra/shared";
import { dockerGet, dockerRequest } from "./docker.js";

/** Délai laissé au conteneur pour s'arrêter proprement avant que Docker ne le tue. */
const STOP_GRACE_SEC = 10;
/** Marge au-dessus du délai d'arrêt pour la réponse de Docker. */
const REQUEST_TIMEOUT_MS = (STOP_GRACE_SEC + 50) * 1000;

/** Message lisible pour une réponse d'erreur de Docker (`{ message }`). */
function dockerMessage(body: unknown): string {
  if (body && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string") {
    return (body as { message: string }).message;
  }
  return typeof body === "string" && body ? body : "erreur inconnue";
}

/**
 * Démarrage, arrêt et redémarrage d'un conteneur isolé, à la demande de la console. Les conteneurs de la console
 * et de l'agent sont refusés : la console ne doit pas se couper elle-même.
 */
export class ContainerActions {
  constructor(
    private readonly socketPath: string,
    private readonly isProtected: (project: string) => Promise<boolean>,
  ) {}

  async run(msg: ContainerActionMessage, emit: (m: AgentMessage) => void): Promise<void> {
    const fail = (error: string): void => emit({ type: "container_action_result", actionId: msg.actionId, status: "failed", error: error.slice(0, 300) });
    let info: { Config?: { Labels?: Record<string, string> } };
    try {
      info = (await dockerGet(this.socketPath, `/containers/${msg.containerId}/json`)) as typeof info;
    } catch {
      return fail("Conteneur introuvable.");
    }
    const project = info.Config?.Labels?.["com.docker.compose.project"];
    if (project && (await this.isProtected(project))) return fail("Conteneur de la console ou de l'agent : action refusée.");

    const query = msg.action === "start" ? "" : `?t=${STOP_GRACE_SEC}`;
    try {
      const res = await dockerRequest(this.socketPath, "POST", `/containers/${msg.containerId}/${msg.action}${query}`, REQUEST_TIMEOUT_MS);
      // 304 : déjà dans l'état demandé (conteneur déjà démarré ou déjà arrêté).
      if (res.status === 204 || res.status === 304) return emit({ type: "container_action_result", actionId: msg.actionId, status: "succeeded" });
      if (res.status === 404) return fail("Conteneur introuvable.");
      fail(`Docker a refusé l'action : ${dockerMessage(res.body)}`);
    } catch (err) {
      fail(`Action impossible : ${(err as Error).message}`);
    }
  }
}
