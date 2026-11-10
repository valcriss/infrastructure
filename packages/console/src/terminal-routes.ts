import { RESERVED_STACK_NAMES, type Container } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { AuthUser } from "./auth.js";
import { audit, type Pool } from "./db.js";
import type { AgentGateway } from "./gateway.js";
import { HttpError } from "./http-error.js";
import { STEP_UP_MAX_AGE_MS } from "./user-routes.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

// --- Réglages -----------------------------------------------------------------------------------------

export interface TerminalSettings {
  /** Désactivé par défaut : un terminal donne un accès shell aux conteneurs. */
  enabled: boolean;
  /** Fermeture après cette durée sans frappe. */
  idleMinutes: number;
  /** Durée maximale d'une session. */
  maxMinutes: number;
  /** Enregistrer la sortie écran des sessions (format asciinema). */
  record: boolean;
  /** Exiger un deuxième facteur récent pour ouvrir un terminal. Le droit Terminal reste obligatoire. */
  requireSecondFactor: boolean;
}
export const DEFAULT_TERMINAL: TerminalSettings = { enabled: false, idleMinutes: 10, maxMinutes: 60, record: true, requireSecondFactor: true };

export async function getTerminalSettings(pool: Pick<Pool, "query">): Promise<TerminalSettings> {
  const { rows } = await pool.query<{ value: Partial<TerminalSettings> }>("SELECT value FROM app_settings WHERE key = 'terminal'");
  return { ...DEFAULT_TERMINAL, ...(rows[0]?.value ?? {}) };
}

export const TerminalSettingsBody = z.object({
  enabled: z.boolean(),
  idleMinutes: z.number().int().min(1).max(240),
  maxMinutes: z.number().int().min(1).max(480),
  record: z.boolean(),
  requireSecondFactor: z.boolean().default(true),
});

// --- Limites ------------------------------------------------------------------------------------------

const MAX_PER_USER = 3;
const MAX_TOTAL = 10;
const MAX_RECORDING_BYTES = 5 * 1024 * 1024;
const FLUSH_MS = 3000;

// --- Enregistrement asciinema v2 ---------------------------------------------------------------------

class Recorder {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private bytes = 0;
  private truncated = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly pool: Pool,
    private readonly id: string,
    cols: number,
    rows: number,
    title: string,
  ) {
    this.push(JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(this.startedAt / 1000), title, env: { TERM: "xterm-256color" } }) + "\n");
  }

  private push(line: string): void {
    if (this.truncated) return;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > MAX_RECORDING_BYTES) {
      this.truncated = true;
      this.pending += JSON.stringify([this.elapsed(), "o", "\r\n[enregistrement interrompu : taille maximale atteinte]\r\n"]) + "\n";
      return;
    }
    this.bytes += size;
    this.pending += line;
  }

  private elapsed(): number {
    return Math.round(((Date.now() - this.startedAt) / 1000) * 1000) / 1000;
  }

  output(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    if (text) this.push(JSON.stringify([this.elapsed(), "o", text]) + "\n");
  }

  resize(cols: number, rows: number): void {
    this.push(JSON.stringify([this.elapsed(), "r", `${cols}x${rows}`]) + "\n");
  }

  async flush(): Promise<void> {
    if (!this.pending) return;
    const chunk = this.pending;
    this.pending = "";
    await this.pool
      .query("UPDATE terminal_sessions SET recording = recording || $2, recording_bytes = $3, recording_truncated = $4 WHERE id = $1", [this.id, chunk, this.bytes, this.truncated])
      .catch(() => undefined);
  }
}

// --- Sessions actives ---------------------------------------------------------------------------------

interface Active {
  id: string;
  userId: string;
  hostId: string;
  /** Envoie un message de contrôle au navigateur. */
  notify: (payload: Record<string, unknown>) => void;
  /** Ferme la connexion du navigateur. */
  closeSocket: () => void;
  recorder: Recorder | null;
  timers: { flush?: NodeJS.Timeout; idle?: NodeJS.Timeout; max?: NodeJS.Timeout };
  ended: boolean;
}

/** Relais entre les navigateurs et les agents : un terminal = une session, bornée et enregistrée. */
export class TerminalService {
  private readonly sessions = new Map<string, Active>();

  constructor(
    private readonly pool: Pool,
    private readonly gateway: AgentGateway,
  ) {}

  get count(): number {
    return this.sessions.size;
  }

  private countFor(userId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.userId === userId) n++;
    return n;
  }

  /** Vérifie les limites et démarre une session ; lève une erreur HTTP-like explicite sinon. */
  async start(args: {
    user: AuthUser;
    host: { id: string; name: string };
    container: { id: string; name: string; project: string | null };
    cols: number;
    rows: number;
    settings: TerminalSettings;
    notify: Active["notify"];
    closeSocket: () => void;
  }): Promise<{ id: string; input: (data: string) => void; resize: (cols: number, rows: number) => void; close: (reason: string) => void }> {
    const { user, host, container, settings } = args;
    if (this.sessions.size >= MAX_TOTAL) throw new HttpError(429, "too_many_terminals", "Trop de terminaux ouverts sur la console.");
    if (this.countFor(user.id) >= MAX_PER_USER) throw new HttpError(429, "too_many_terminals", `Vous avez déjà ${MAX_PER_USER} terminaux ouverts.`);

    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO terminal_sessions (id, user_id, user_email, host_id, host_name, container_id, container_name, project, cols, rows, recorded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, user.id, user.email, host.id, host.name, container.id, container.name, container.project, args.cols, args.rows, settings.record],
    );
    const session: Active = {
      id,
      userId: user.id,
      hostId: host.id,
      notify: args.notify,
      closeSocket: args.closeSocket,
      recorder: settings.record ? new Recorder(this.pool, id, args.cols, args.rows, `${container.name} sur ${host.name} (${user.email})`) : null,
      timers: {},
      ended: false,
    };
    this.sessions.set(id, session);
    const actor = user.username ?? user.email;
    await audit(this.pool, actor, "terminal.open", `${host.name}/${container.name}`, "success");

    const idleMs = settings.idleMinutes * 60_000;
    const armIdle = (): void => {
      clearTimeout(session.timers.idle);
      session.timers.idle = setTimeout(() => this.end(id, "Fermé après inactivité."), idleMs);
    };
    armIdle();
    session.timers.max = setTimeout(() => this.end(id, "Durée maximale de la session atteinte."), settings.maxMinutes * 60_000);
    session.timers.flush = setInterval(() => void session.recorder?.flush(), FLUSH_MS);

    if (!this.gateway.send(host.id, { type: "terminal_open", sessionId: id, containerId: container.id, cols: args.cols, rows: args.rows })) {
      this.end(id, "L'agent de l'hôte est hors ligne.");
      throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne");
    }
    return {
      id,
      input: (data) => {
        armIdle();
        this.gateway.send(host.id, { type: "terminal_input", sessionId: id, data });
      },
      resize: (cols, rows) => {
        session.recorder?.resize(cols, rows);
        this.gateway.send(host.id, { type: "terminal_resize", sessionId: id, cols, rows });
      },
      close: (reason) => this.end(id, reason),
    };
  }

  /** Sortie du terminal remontée par l'agent. */
  onData(hostId: string, sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.hostId !== hostId) return;
    s.recorder?.output(Buffer.from(data, "base64"));
    s.notify({ t: "data", d: data });
  }

  /** Fin signalée par l'agent (shell terminé, refus…). */
  onEnd(hostId: string, sessionId: string, reason: string, exitCode?: number): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.hostId !== hostId) return;
    this.end(sessionId, reason, exitCode, false);
  }

  onHostDisconnect(hostId: string): void {
    for (const s of [...this.sessions.values()]) if (s.hostId === hostId) this.end(s.id, "Connexion avec l'agent perdue.", undefined, false);
  }

  /** Termine une session : demande la fermeture à l'agent (sauf s'il vient de la signaler), solde l'enregistrement. */
  private end(id: string, reason: string, exitCode?: number, tellAgent = true): void {
    const s = this.sessions.get(id);
    if (!s || s.ended) return;
    s.ended = true;
    this.sessions.delete(id);
    clearTimeout(s.timers.idle);
    clearTimeout(s.timers.max);
    clearInterval(s.timers.flush);
    if (tellAgent) this.gateway.send(s.hostId, { type: "terminal_close", sessionId: id });
    s.notify({ t: "end", reason, ...(exitCode === undefined ? {} : { exitCode }) });
    s.closeSocket();
    void (async () => {
      await s.recorder?.flush();
      await this.pool
        .query("UPDATE terminal_sessions SET ended_at = now(), end_reason = $2, exit_code = $3 WHERE id = $1", [id, reason, exitCode ?? null])
        .catch(() => undefined);
    })();
  }

  /** Arrêt de la console : toutes les sessions sont fermées et leur enregistrement soldé. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.end(id, "Console arrêtée.");
  }
}

// --- Routes -------------------------------------------------------------------------------------------

const Params = z.object({ hostId: z.uuid(), containerId: z.string().regex(/^[0-9a-f]{12,64}$/) });
const IdParams = z.object({ id: z.uuid() });

interface HostRow {
  id: string;
  name: string;
  inventory: Container[] | null;
}

export function registerTerminalRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; auth: Guard; service: TerminalService; hasFactor: (userId: string) => Promise<boolean> },
): void {
  const { pool, auth, service } = deps;

  app.get("/api/v1/settings/terminal", { preHandler: auth }, async () => getTerminalSettings(pool));
  app.put("/api/v1/settings/terminal", { preHandler: auth }, async (request) => {
    const body = TerminalSettingsBody.parse(request.body);
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('terminal', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify(body)],
    );
    await audit(pool, request.actor, "settings.terminal", `${body.enabled ? "activé" : "désactivé"}, deuxième facteur ${body.requireSecondFactor ? "exigé" : "NON exigé"}`, "success");
    return body;
  });

  // Enregistrements : administrateurs seulement (ils peuvent contenir des secrets affichés à l'écran).
  app.get("/api/v1/terminal-recordings", { preHandler: auth }, async () => {
    const { rows } = await pool.query(
      `SELECT id, user_email, host_name, container_name, project, started_at, ended_at, end_reason, exit_code, recording_bytes, recording_truncated, recorded
         FROM terminal_sessions ORDER BY started_at DESC LIMIT 200`,
    );
    return {
      sessions: rows.map((r) => ({
        id: r.id as string,
        userEmail: r.user_email as string,
        hostName: r.host_name as string,
        containerName: r.container_name as string,
        project: (r.project as string | null) ?? null,
        startedAt: (r.started_at as Date).toISOString(),
        endedAt: r.ended_at ? (r.ended_at as Date).toISOString() : null,
        endReason: (r.end_reason as string | null) ?? null,
        exitCode: (r.exit_code as number | null) ?? null,
        recordingBytes: r.recording_bytes as number,
        truncated: r.recording_truncated as boolean,
        recorded: r.recorded as boolean,
        active: r.ended_at === null,
      })),
    };
  });

  app.get("/api/v1/terminal-recordings/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { rows } = await pool.query<{ recording: string }>("SELECT recording FROM terminal_sessions WHERE id = $1", [id]);
    if (!rows[0]) throw new HttpError(404, "recording_not_found", "Enregistrement introuvable");
    await audit(pool, request.actor, "terminal.replay", id, "success");
    reply.header("Cache-Control", "no-store").type("application/x-asciicast");
    return rows[0].recording;
  });

  app.delete("/api/v1/terminal-recordings/:id", { preHandler: auth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const res = await pool.query("DELETE FROM terminal_sessions WHERE id = $1 AND ended_at IS NOT NULL", [id]);
    if ((res.rowCount ?? 0) === 0) throw new HttpError(404, "recording_not_found", "Enregistrement introuvable ou session encore ouverte");
    await audit(pool, request.actor, "terminal.delete", id, "success");
    return reply.code(204).send();
  });

  // WebSocket navigateur <-> console. Les refus sont envoyés comme message `error` puis la connexion est fermée :
  // l'API WebSocket du navigateur ne donne pas accès au statut HTTP.
  app.get("/api/v1/hosts/:hostId/containers/:containerId/terminal", { websocket: true, preHandler: auth }, async (socket, request) => {
    const send = (payload: Record<string, unknown>): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };
    const refuse = (code: string, message: string): void => {
      send({ t: "error", code, message });
      socket.close(1008, code);
    };
    try {
      const user = request.user;
      if (!user) return refuse("unauthorized", "Authentification requise");
      // Défense contre le détournement de WebSocket depuis un autre site.
      const origin = request.headers.origin;
      if (origin) {
        let host: string | null = null;
        try {
          host = new URL(origin).host;
        } catch {
          /* origine invalide */
        }
        if (host !== request.headers.host) return refuse("forbidden_origin", "Origine refusée");
      }
      const settings = await getTerminalSettings(pool);
      if (!settings.enabled) return refuse("terminal_disabled", "Le terminal est désactivé : un administrateur doit l'activer dans les paramètres.");
      if (!user.terminalAllowed) return refuse("terminal_forbidden", "Vous n'avez pas le droit d'utiliser le terminal.");
      if (settings.requireSecondFactor) {
        if (!user.totpEnabled && !(await deps.hasFactor(user.id))) return refuse("mfa_not_enrolled", "Configurez d'abord un code à usage unique ou une clé d'accès dans « Mon compte ».");
        if (!user.mfaAt || Date.now() - user.mfaAt.getTime() > STEP_UP_MAX_AGE_MS) return refuse("step_up_required", "Confirmez votre identité avec un deuxième facteur.");
      }

      const { hostId, containerId } = Params.parse(request.params);
      const { rows } = await pool.query<HostRow>("SELECT id, name, inventory FROM hosts WHERE id = $1 AND revoked_at IS NULL", [hostId]);
      const host = rows[0];
      if (!host) return refuse("host_not_found", "Hôte introuvable");
      const container = (host.inventory ?? []).find((c) => c.id.startsWith(containerId) || containerId.startsWith(c.id));
      if (!container) return refuse("container_not_found", "Conteneur introuvable sur cet hôte");
      if (container.state !== "running") return refuse("container_not_running", "Le conteneur n'est pas en cours d'exécution");
      if (container.composeProject && RESERVED_STACK_NAMES.includes(container.composeProject)) {
        return refuse("container_protected", "Ce conteneur fait tourner la console ou son agent : le terminal est refusé.");
      }
      const q = z.object({ cols: z.coerce.number().int().min(10).max(500).default(80), rows: z.coerce.number().int().min(2).max(200).default(24) }).parse(request.query);

      const handle = await service.start({
        user,
        host: { id: host.id, name: host.name },
        container: { id: container.id, name: container.names[0] ?? container.id.slice(0, 12), project: container.composeProject ?? null },
        cols: q.cols,
        rows: q.rows,
        settings,
        notify: send,
        closeSocket: () => socket.close(1000, "terminal fermé"),
      });
      send({ t: "ready", sessionId: handle.id, recorded: settings.record, idleMinutes: settings.idleMinutes, maxMinutes: settings.maxMinutes });

      socket.on("message", (raw: Buffer) => {
        let msg: { t?: string; d?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        if (msg.t === "input" && typeof msg.d === "string" && msg.d.length <= 64 * 1024) handle.input(msg.d);
        else if (msg.t === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          handle.resize(Math.min(500, Math.max(10, msg.cols as number)), Math.min(200, Math.max(2, msg.rows as number)));
        }
      });
      socket.on("close", () => handle.close("Fermé par l'utilisateur."));
      socket.on("error", () => handle.close("Connexion du navigateur interrompue."));
    } catch (err) {
      if (err instanceof HttpError) return refuse(err.code, err.message);
      request.log.error({ err }, "erreur d'ouverture de terminal");
      refuse("internal_error", "Erreur interne");
    }
  });
}
