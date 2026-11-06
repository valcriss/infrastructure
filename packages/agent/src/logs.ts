import type { AgentMessage, LogsStartMessage } from "@infra/shared";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { dockerEnv } from "./exec.js";
import { exists } from "./workspace.js";

const MAX_STREAMS = 10;
const MAX_DURATION_MS = 60 * 60 * 1000;
const MAX_LINE_CHARS = 8000;
const BATCH_MS = 200;
const MAX_BATCH_LINES = 200;
/** Au-delà, les lignes excédentaires sont ignorées et signalées. */
const MAX_LINES_PER_SEC = 2000;

interface Stream {
  child: ChildProcess;
  timer: NodeJS.Timeout;
}

export interface LogStreamerConfig {
  workspaceDir: string;
  dockerSocket: string;
}

/**
 * Suivi en direct des logs d'une stack, à la demande de la console. Le flux
 * est borné (nombre de flux, durée, débit, taille des lignes) : l'agent ne
 * rapatrie jamais tous les logs en permanence.
 */
export class LogStreamer {
  private readonly streams = new Map<string, Stream>();

  constructor(private readonly cfg: LogStreamerConfig) {}

  async start(msg: LogsStartMessage, emit: (m: AgentMessage) => void): Promise<void> {
    const end = (reason: string): void => emit({ type: "log_end", streamId: msg.streamId, reason });

    if (this.streams.size >= MAX_STREAMS) return end("Trop de flux de logs simultanés sur cet hôte.");
    let args: string[];
    if (msg.containerId) {
      // Projet observé : pas de Compose connu, on suit un conteneur précis (arguments structurés).
      args = ["logs", "--follow", "--timestamps", "--tail", String(msg.tail), msg.containerId];
    } else if (msg.stack) {
      const dir = join(this.cfg.workspaceDir, msg.stack.id);
      if (!(await exists(join(dir, "compose.yaml")))) {
        return end("Cette stack n'a jamais été déployée sur cet hôte.");
      }
      args = [
        "compose",
        "--project-name",
        msg.stack.project,
        "--project-directory",
        dir,
        "--file",
        join(dir, "compose.yaml"),
        "--env-file",
        join(dir, ".env"),
        "logs",
        "--follow",
        "--timestamps",
        "--no-color",
        "--tail",
        String(msg.tail),
        ...(msg.service ? [msg.service] : []),
      ];
    } else {
      return end("Demande de logs invalide : ni stack ni conteneur.");
    }
    const child = spawn("docker", args, {
      env: dockerEnv(this.cfg.dockerSocket),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      end("Durée maximale du flux atteinte.");
      this.stop(msg.streamId);
    }, MAX_DURATION_MS);
    this.streams.set(msg.streamId, { child, timer });

    let partial = "";
    let batch: string[] = [];
    let flushTimer: NodeJS.Timeout | undefined;
    let windowStart = Date.now();
    let inWindow = 0;
    let dropped = 0;

    const flush = (): void => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (dropped > 0) {
        batch.push(`[${dropped} lignes ignorées : débit trop élevé]`);
        dropped = 0;
      }
      if (batch.length === 0) return;
      emit({ type: "log_chunk", streamId: msg.streamId, lines: batch });
      batch = [];
    };
    const push = (line: string): void => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        inWindow = 0;
      }
      if (++inWindow > MAX_LINES_PER_SEC) {
        dropped++;
        return;
      }
      batch.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line);
      if (batch.length >= MAX_BATCH_LINES) flush();
      else if (!flushTimer) flushTimer = setTimeout(flush, BATCH_MS);
    };
    const onData = (chunk: string): void => {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? "";
      for (const line of parts) push(line);
    };
    child.stdout?.setEncoding("utf8").on("data", onData);
    child.stderr?.setEncoding("utf8").on("data", onData);

    child.on("error", (err) => {
      flush();
      end(`Impossible de lire les logs : ${err.message}`);
      this.cleanup(msg.streamId);
    });
    child.on("close", () => {
      if (partial) push(partial);
      flush();
      if (this.streams.has(msg.streamId)) {
        end("Flux terminé.");
        this.cleanup(msg.streamId);
      }
    });
  }

  private cleanup(streamId: string): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    clearTimeout(s.timer);
    this.streams.delete(streamId);
  }

  /** Arrête un flux et son processus `docker compose logs`. */
  stop(streamId: string): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.cleanup(streamId);
    s.child.kill("SIGTERM");
  }

  stopAll(): void {
    for (const id of [...this.streams.keys()]) this.stop(id);
  }
}
