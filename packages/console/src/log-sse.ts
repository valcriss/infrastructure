import type { FastifyReply, FastifyRequest } from "fastify";
import { HttpError } from "./http-error.js";
import { LogLimitError, LogOfflineError, type LogStreams } from "./log-streams.js";

/**
 * Ouvre un flux de logs en Server-Sent Events. Événements : `lines` (tableau de lignes), `end` (raison),
 * commentaires `: ping`. Les erreurs de démarrage (trop de flux, agent hors ligne) sont renvoyées en HTTP
 * avant l'ouverture du flux ; ensuite le flux se termine proprement avec l'agent, le client ou la durée maximale.
 */
export function serveLogStream(
  request: FastifyRequest,
  reply: FastifyReply,
  logStreams: LogStreams,
  hostId: string,
  target: { stack: { id: string; project: string } } | { containerId: string },
  options: { service?: string; tail: number },
): void {
  const raw = reply.raw;
  let stop: () => void = () => {};
  let closed = false;
  let started = false;
  const timers: { ping?: NodeJS.Timeout } = {};
  let dropped = 0;
  const write = (chunk: string): boolean => (closed ? true : raw.write(chunk));
  const event = (name: string, data: unknown): void => {
    // Client lent : on ignore les lignes plutôt que d'accumuler de la mémoire.
    if (name === "lines" && raw.writableNeedDrain) {
      dropped += (data as string[]).length;
      return;
    }
    if (dropped > 0 && name === "lines") {
      write(`event: lines\ndata: ${JSON.stringify([`[${dropped} lignes ignorées : client trop lent]`])}\n\n`);
      dropped = 0;
    }
    write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let handle: { streamId: string; stop: () => void };
  try {
    handle = logStreams.start(hostId, target, options, {
      lines: (lines) => event("lines", lines),
      end: (reason) => {
        // Avant l'ouverture du flux, l'erreur est renvoyée par la route elle-même.
        if (!started) return;
        event("end", reason);
        closed = true;
        clearInterval(timers.ping);
        raw.end();
      },
    });
  } catch (err) {
    if (err instanceof LogLimitError) throw new HttpError(429, "too_many_streams", "Trop de flux de logs simultanés");
    if (err instanceof LogOfflineError) throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne");
    throw err;
  }
  stop = handle.stop;
  started = true;
  timers.ping = setInterval(() => write(": ping\n\n"), 15_000);
  reply.hijack();
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  write(": ouvert\n\n");
  request.raw.on("close", () => {
    closed = true;
    clearInterval(timers.ping);
    stop();
  });
}
