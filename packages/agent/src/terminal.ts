import { TERMINAL_MAX_CHUNK_BYTES, type AgentMessage, type TerminalOpenMessage } from "@infra/shared";
import { request } from "node:http";
import type { Duplex } from "node:stream";
import { dockerGet } from "./docker.js";

const MAX_SESSIONS = 5;
/** Garde-fou côté agent ; la console applique ses propres durées (inactivité, durée maximale). */
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
// bash s'il existe, sinon sh : les images minimales n'ont souvent que sh.
const SHELL = ["/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"];

interface DockerReply {
  status: number;
  body: unknown;
}

function dockerJson(socketPath: string, method: "GET" | "POST", path: string, payload?: unknown): Promise<DockerReply> {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = request(
      { socketPath, path, method, timeout: 15_000, headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            /* corps non JSON : conservé tel quel */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("délai Docker dépassé")));
    req.on("error", reject);
    req.end(body);
  });
}

interface Session {
  socket: Duplex;
  execId: string;
  timer: NodeJS.Timeout;
  closed: boolean;
}

/**
 * Terminaux interactifs : un `docker exec` avec TTY par session, via l'API Docker (connexion détournée en flux
 * brut). L'agent ne dépend d'aucun binaire : tout passe par le socket Docker.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  /** `isProtected` : le projet Compose de ce conteneur fait-il tourner la console ou l'agent ? */
  constructor(
    private readonly socketPath: string,
    private readonly isProtected: (project: string) => Promise<boolean>,
  ) {}

  get count(): number {
    return this.sessions.size;
  }

  async open(msg: TerminalOpenMessage, emit: (m: AgentMessage) => void): Promise<void> {
    const end = (reason: string, exitCode?: number): void => emit({ type: "terminal_end", sessionId: msg.sessionId, reason, ...(exitCode === undefined ? {} : { exitCode }) });
    if (this.sessions.has(msg.sessionId)) return end("Session déjà ouverte.");
    if (this.sessions.size >= MAX_SESSIONS) return end("Trop de terminaux ouverts sur cet hôte.");

    let info: { State?: { Running?: boolean }; Config?: { Labels?: Record<string, string> } };
    try {
      info = (await dockerGet(this.socketPath, `/containers/${msg.containerId}/json`)) as typeof info;
    } catch {
      return end("Conteneur introuvable.");
    }
    if (!info.State?.Running) return end("Le conteneur n'est pas en cours d'exécution.");
    const project = info.Config?.Labels?.["com.docker.compose.project"];
    if (project && (await this.isProtected(project))) {
      return end("Ce conteneur fait tourner la console ou son agent : le terminal est refusé.");
    }

    const created = await dockerJson(this.socketPath, "POST", `/containers/${msg.containerId}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: SHELL,
      Env: ["TERM=xterm-256color"],
    });
    const execId = (created.body as { Id?: string } | null)?.Id;
    if (created.status !== 201 || !execId) return end(`Docker a refusé de créer le terminal (${created.status}).`);

    let socket: Duplex;
    let head: Buffer;
    try {
      ({ socket, head } = await new Promise<{ socket: Duplex; head: Buffer }>((resolve, reject) => {
        const body = JSON.stringify({ Detach: false, Tty: true, ConsoleSize: [msg.rows, msg.cols] });
        const req = request({
          socketPath: this.socketPath,
          path: `/exec/${execId}/start`,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Connection: "Upgrade", Upgrade: "tcp" },
        });
        req.on("upgrade", (_res, sock, buf) => resolve({ socket: sock, head: buf }));
        req.on("response", (res) => {
          res.resume();
          reject(new Error(`Docker a répondu ${res.statusCode}`));
        });
        req.on("error", reject);
        req.end(body);
      }));
    } catch (err) {
      return end(`Impossible de démarrer le terminal : ${(err as Error).message}`);
    }

    const session: Session = { socket, execId, closed: false, timer: setTimeout(() => this.close(msg.sessionId), MAX_DURATION_MS) };
    this.sessions.set(msg.sessionId, session);

    const send = (buf: Buffer): void => {
      for (let i = 0; i < buf.length; i += TERMINAL_MAX_CHUNK_BYTES) {
        emit({ type: "terminal_data", sessionId: msg.sessionId, data: buf.subarray(i, i + TERMINAL_MAX_CHUNK_BYTES).toString("base64") });
      }
    };
    if (head.length > 0) send(head);
    socket.on("data", (chunk: Buffer) => send(chunk));
    const finish = (): void => {
      if (session.closed) return;
      session.closed = true;
      clearTimeout(session.timer);
      this.sessions.delete(msg.sessionId);
      void dockerJson(this.socketPath, "GET", `/exec/${execId}/json`)
        .then((r) => (r.body as { ExitCode?: number } | null)?.ExitCode)
        .catch(() => undefined)
        .then((code) => end("Shell terminé.", typeof code === "number" ? code : undefined));
    };
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", finish);
  }

  /** Entrée clavier (base64). */
  input(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId);
    if (s && !s.closed) s.socket.write(Buffer.from(data, "base64"));
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.closed) return;
    void dockerJson(this.socketPath, "POST", `/exec/${s.execId}/resize?h=${rows}&w=${cols}`).catch(() => undefined);
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.closed) return;
    s.socket.end();
    // Un shell qui ignore la fermeture de l'entrée est coupé.
    setTimeout(() => s.socket.destroy(), 1000).unref();
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
