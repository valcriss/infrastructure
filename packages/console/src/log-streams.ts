import { randomUUID } from "node:crypto";
import type { ConsoleMessage } from "@infra/shared";

const MAX_STREAMS_PER_HOST = 5;
const MAX_STREAMS_TOTAL = 20;
export const MAX_STREAM_DURATION_MS = 60 * 60 * 1000;

export interface LogSink {
  lines(lines: string[]): void;
  end(reason: string): void;
}

export interface LogTransport {
  isOnline(hostId: string): boolean;
  send(hostId: string, message: ConsoleMessage): boolean;
}

interface Active {
  hostId: string;
  sink: LogSink;
  timer: NodeJS.Timeout;
}

export class LogLimitError extends Error {}
export class LogOfflineError extends Error {}

/**
 * Relais des flux de logs entre l'agent d'un hôte et les clients de la
 * console. Chaque flux est borné (nombre par hôte, nombre total, durée) et
 * s'arrête dès que le client part, que l'agent se déconnecte ou qu'il se termine.
 */
export class LogStreams {
  private readonly active = new Map<string, Active>();

  constructor(private readonly transport: LogTransport) {}

  count(): number {
    return this.active.size;
  }

  start(
    hostId: string,
    target: { stack: { id: string; project: string } } | { containerId: string },
    options: { service?: string; tail: number },
    sink: LogSink,
  ): { streamId: string; stop: () => void } {
    if (!this.transport.isOnline(hostId)) throw new LogOfflineError("Agent hors ligne");
    const perHost = [...this.active.values()].filter((a) => a.hostId === hostId).length;
    if (perHost >= MAX_STREAMS_PER_HOST || this.active.size >= MAX_STREAMS_TOTAL) {
      throw new LogLimitError("Trop de flux de logs simultanés");
    }
    const streamId = randomUUID();
    const timer = setTimeout(() => this.finish(streamId, "Durée maximale du flux atteinte.", true), MAX_STREAM_DURATION_MS);
    timer.unref();
    this.active.set(streamId, { hostId, sink, timer });
    const sent = this.transport.send(hostId, {
      type: "logs_start",
      streamId,
      ...target,
      ...(options.service ? { service: options.service } : {}),
      tail: options.tail,
    });
    if (!sent) {
      this.finish(streamId, "Agent hors ligne.", false);
      throw new LogOfflineError("Agent hors ligne");
    }
    return { streamId, stop: () => this.finish(streamId, "", true, true) };
  }

  /** Termine un flux. `notifyAgent` demande à l'agent de s'arrêter ; `silent` n'avertit pas le client. */
  private finish(streamId: string, reason: string, notifyAgent: boolean, silent = false): void {
    const a = this.active.get(streamId);
    if (!a) return;
    clearTimeout(a.timer);
    this.active.delete(streamId);
    if (notifyAgent) this.transport.send(a.hostId, { type: "logs_stop", streamId });
    if (!silent) a.sink.end(reason);
  }

  onChunk(hostId: string, streamId: string, lines: string[]): void {
    const a = this.active.get(streamId);
    // Un agent ne peut alimenter que les flux de son propre hôte.
    if (a && a.hostId === hostId) a.sink.lines(lines);
  }

  onEnd(hostId: string, streamId: string, reason: string): void {
    const a = this.active.get(streamId);
    if (a && a.hostId === hostId) this.finish(streamId, reason, false);
  }

  onHostDisconnect(hostId: string): void {
    for (const [id, a] of [...this.active]) {
      if (a.hostId === hostId) this.finish(id, "Connexion à l'agent perdue.", false);
    }
  }
}
