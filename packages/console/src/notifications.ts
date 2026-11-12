import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import type { SecretBox } from "./secretbox.js";

/** Événements notifiables (tous optionnels). */
export const EVENT_TYPES = ["remediation.ready", "remediation.failed", "remediation.auto_paused", "registry.gc_failed"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface NotifyEvent {
  type: EventType | "test";
  title: string;
  /** Texte lisible : jamais de secret, de valeur de variable ni d'extrait de configuration. */
  text: string;
  severity: "info" | "warning" | "error";
  /** Chemin dans la console (`/images`) : devient un lien si l'adresse de la console est renseignée. */
  path: string;
  image?: string;
  status?: string;
}

export interface NotificationSettings {
  enabled: boolean;
  /** Adresse publique de la console (origine), pour que les messages contiennent un lien. */
  baseUrl: string | null;
  events: Record<EventType, boolean>;
  /** Autorise un webhook sur une adresse privée ou locale (service interne) : refusé par défaut. */
  allowPrivate: boolean;
  /** Plafond d'envois par heure (hors message de test) : protège contre une rafale. */
  maxPerHour: number;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: false,
  baseUrl: null,
  events: { "remediation.ready": true, "remediation.failed": true, "remediation.auto_paused": true, "registry.gc_failed": true },
  allowPrivate: false,
  maxPerHour: 20,
};

interface Stored extends NotificationSettings {
  urlEnc: string | null;
  secretEnc: string | null;
}

export interface NotificationView extends NotificationSettings {
  /** Une adresse de webhook est enregistrée (elle n'est jamais renvoyée : seul son nom d'hôte l'est). */
  configured: boolean;
  urlHost: string | null;
  hasSecret: boolean;
}

export interface DeliveryRow {
  id: string;
  at: string;
  event: string;
  status: "sent" | "failed" | "skipped";
  httpStatus: number | null;
  durationMs: number | null;
  attempts: number;
  error: string | null;
}

// --- Adresses : jamais d'appel vers un service interne par défaut ------------------------------------

function ipv4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // partage d'adresses des opérateurs (CGNAT)
    (a === 169 && b === 254) || // lien local, dont les métadonnées des fournisseurs de cloud
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19))
  );
}

/** Adresse IP (v4 ou v6) privée, locale, de lien local, de multidiffusion ou non routable. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind !== 6) return true; // inconnue : refusée
  const v = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Private(mapped[1] as string);
  if (v === "::" || v === "::1") return true;
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || v.startsWith("2001:db8");
}

/** Adresse de webhook valide : HTTPS, sans identifiants, sans hôte local ni adresse privée littérale (sauf autorisation). */
export function validateWebhookUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "invalid_url", "Adresse de webhook invalide.");
  }
  if (url.protocol !== "https:") throw new HttpError(400, "invalid_url", "Le webhook doit être en HTTPS.");
  if (url.username || url.password) throw new HttpError(400, "invalid_url", "L'adresse ne doit pas contenir d'identifiants : utilisez la signature.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!allowPrivate) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
      throw new HttpError(400, "private_address", "Adresse locale refusée (cochez « Autoriser une adresse privée » pour un service interne).");
    }
    if (isIP(host) && isPrivateAddress(host)) {
      throw new HttpError(400, "private_address", "Adresse privée refusée (cochez « Autoriser une adresse privée » pour un service interne).");
    }
  }
  return url;
}

/** Adresse de la console pour les liens : origine http(s) uniquement. */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "invalid_base_url", "Adresse de la console invalide.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new HttpError(400, "invalid_base_url", "Indiquez seulement l'origine de la console (ex. https://console.exemple.fr).");
  }
  return url.origin;
}

// --- Message et signature -----------------------------------------------------------------------------

export interface Payload {
  event: string;
  title: string;
  text: string;
  severity: string;
  image: string | null;
  status: string | null;
  url: string | null;
  at: string;
  /** Alias de `text` : Slack lit `text`, Discord lit `content`. */
  content: string;
}

export function buildPayload(e: NotifyEvent, baseUrl: string | null, now: Date): Payload {
  const url = baseUrl ? `${baseUrl}${e.path}` : null;
  const text = `${e.title} — ${e.text}${url ? ` ${url}` : ""}`.slice(0, 1900);
  return { event: e.type, title: e.title, text, severity: e.severity, image: e.image ?? null, status: e.status ?? null, url, at: now.toISOString(), content: text };
}

/** Signature HMAC-SHA256 de `horodatage.corps` : le destinataire la recalcule avec le secret (et refuse un horodatage ancien). */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

// --- Envoi ----------------------------------------------------------------------------------------------

export interface DeliverOptions {
  url: URL;
  body: string;
  headers: Record<string, string>;
  allowPrivate: boolean;
  timeoutMs?: number;
}

export type Deliver = (o: DeliverOptions) => Promise<{ status: number }>;

/**
 * Envoi HTTPS. L'adresse est vérifiée au moment de la connexion (et non seulement à l'enregistrement) : un nom de domaine
 * qui se résout vers une adresse privée est refusé, même après coup. Aucune redirection n'est suivie.
 */
export const deliverHttps: Deliver = ({ url, body, headers, allowPrivate, timeoutMs = 10_000 }) =>
  new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!allowPrivate && isIP(host) && isPrivateAddress(host)) {
      reject(new Error("adresse privée refusée"));
      return;
    }
    const req = httpsRequest(
      {
        host,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        servername: isIP(host) ? undefined : host,
        timeout: timeoutMs,
        headers: { ...headers, host: url.host, "content-length": Buffer.byteLength(body).toString() },
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { all: true })
            .then((addrs) => {
              if (!allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) throw new Error("adresse privée refusée");
              const cb = callback as unknown as (err: Error | null, address: unknown, family?: number) => void;
              if (options.all) cb(null, addrs);
              else cb(null, addrs[0]?.address, addrs[0]?.family);
            })
            .catch((err: unknown) => (callback as unknown as (err: Error) => void)(err instanceof Error ? err : new Error("résolution impossible")));
        },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", reject);
    req.end(body);
  });

// --- Service ----------------------------------------------------------------------------------------------

export interface NotifierOptions {
  deliver?: Deliver;
  /** Délais avant chaque nouvelle tentative (échec réseau, 5xx ou 429) ; 3 reprises par défaut. */
  retryDelaysMs?: number[];
  log?: { error(obj: unknown, msg?: string): void };
  now?: () => Date;
}

const KEEP_DELIVERIES = 50;
const message = (err: unknown): string => (err instanceof Error ? err.message : "erreur").slice(0, 200);

/**
 * Notifications par webhook HTTPS : désactivées par défaut. L'adresse et le secret sont chiffrés (clé maître) et ne
 * sont jamais renvoyés par l'API. Les messages ne contiennent ni secret, ni valeur de variable, ni sortie d'outil.
 */
export class Notifier {
  private readonly deliver: Deliver;
  private readonly delays: number[];
  private readonly now: () => Date;
  private pending = 0;

  constructor(
    private readonly pool: Pool,
    private readonly box: SecretBox,
    private readonly opts: NotifierOptions = {},
  ) {
    this.deliver = opts.deliver ?? deliverHttps;
    this.delays = opts.retryDelaysMs ?? [2_000, 10_000, 60_000];
    this.now = opts.now ?? (() => new Date());
  }

  // --- Réglages ---------------------------------------------------------------------------------------

  private async stored(): Promise<Stored> {
    const { rows } = await this.pool.query<{ value: Partial<Stored> }>("SELECT value FROM app_settings WHERE key = 'notifications'");
    const v = rows[0]?.value ?? {};
    return { ...DEFAULT_NOTIFICATIONS, ...v, events: { ...DEFAULT_NOTIFICATIONS.events, ...(v.events ?? {}) }, urlEnc: v.urlEnc ?? null, secretEnc: v.secretEnc ?? null };
  }

  private async save(s: Stored): Promise<void> {
    await this.pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('notifications', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
      [JSON.stringify(s)],
    );
  }

  private urlOf(s: Stored): URL | null {
    if (!s.urlEnc) return null;
    try {
      return new URL(this.box.open(s.urlEnc));
    } catch {
      return null; // clé maître modifiée : l'adresse est à ressaisir
    }
  }

  async view(): Promise<NotificationView> {
    const { urlEnc, secretEnc, ...settings } = await this.stored();
    const url = this.urlOf({ ...DEFAULT_NOTIFICATIONS, ...settings, urlEnc, secretEnc });
    return { ...settings, configured: urlEnc !== null, urlHost: url?.host ?? null, hasSecret: secretEnc !== null };
  }

  /** `url` : absent = inchangée ; chaîne vide = supprimée. Le secret de signature est créé avec la première adresse. */
  async update(input: { enabled: boolean; url?: string | undefined; baseUrl?: string | null | undefined; events: Record<EventType, boolean>; allowPrivate: boolean; maxPerHour: number }, actor: string): Promise<NotificationView> {
    const cur = await this.stored();
    const next: Stored = { ...cur, enabled: input.enabled, events: input.events, allowPrivate: input.allowPrivate, maxPerHour: input.maxPerHour, baseUrl: input.baseUrl === undefined ? cur.baseUrl : normalizeBaseUrl(input.baseUrl) };
    if (input.url !== undefined) {
      if (input.url.trim() === "") next.urlEnc = null;
      else {
        next.urlEnc = this.box.seal(validateWebhookUrl(input.url, input.allowPrivate).toString());
        next.secretEnc ??= this.box.seal(randomBytes(32).toString("base64url"));
      }
    } else if (cur.urlEnc && !input.allowPrivate) {
      // Retrait de l'autorisation : l'adresse déjà enregistrée doit rester valide sans elle.
      const url = this.urlOf(cur);
      if (url) validateWebhookUrl(url.toString(), false);
    }
    if (next.enabled && !next.urlEnc) throw new HttpError(400, "no_url", "Renseignez l'adresse du webhook avant d'activer les notifications.");
    await this.save(next);
    await audit(this.pool, actor, "settings.notifications", next.enabled ? "activées" : "désactivées", "success");
    return this.view();
  }

  async secret(): Promise<string | null> {
    const s = await this.stored();
    if (!s.secretEnc) return null;
    try {
      return this.box.open(s.secretEnc);
    } catch {
      return null;
    }
  }

  async rotateSecret(actor: string): Promise<string> {
    const s = await this.stored();
    const secret = randomBytes(32).toString("base64url");
    await this.save({ ...s, secretEnc: this.box.seal(secret) });
    await audit(this.pool, actor, "settings.notifications.secret", "renouvelé", "success");
    return secret;
  }

  // --- Journal ----------------------------------------------------------------------------------------

  async deliveries(): Promise<DeliveryRow[]> {
    const { rows } = await this.pool.query<{ id: string; at: Date; event: string; status: DeliveryRow["status"]; http_status: number | null; duration_ms: number | null; attempts: number; error: string | null }>(
      "SELECT id, at, event, status, http_status, duration_ms, attempts, error FROM notification_deliveries ORDER BY at DESC LIMIT 10",
    );
    return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), event: r.event, status: r.status, httpStatus: r.http_status, durationMs: r.duration_ms, attempts: r.attempts, error: r.error }));
  }

  private async record(event: string, r: { status: DeliveryRow["status"]; httpStatus?: number | null; durationMs?: number | null; attempts?: number; error?: string | null }): Promise<void> {
    await this.pool.query("INSERT INTO notification_deliveries (event, status, http_status, duration_ms, attempts, error) VALUES ($1, $2, $3, $4, $5, $6)", [event, r.status, r.httpStatus ?? null, r.durationMs ?? null, r.attempts ?? 0, r.error ?? null]);
    await this.pool.query("DELETE FROM notification_deliveries WHERE id NOT IN (SELECT id FROM notification_deliveries ORDER BY at DESC LIMIT $1)", [KEEP_DELIVERIES]);
  }

  // --- Envoi ------------------------------------------------------------------------------------------

  private async request(s: Stored, e: NotifyEvent): Promise<DeliverOptions | null> {
    const url = this.urlOf(s);
    let secret: string | null;
    try {
      secret = s.secretEnc ? this.box.open(s.secretEnc) : null;
    } catch {
      secret = null; // clé maître modifiée : le secret est à régénérer
    }
    if (!url || !secret) return null;
    const at = this.now();
    const body = JSON.stringify(buildPayload(e, s.baseUrl, at));
    const timestamp = String(Math.floor(at.getTime() / 1000));
    return {
      url,
      body,
      allowPrivate: s.allowPrivate,
      headers: {
        "content-type": "application/json",
        "user-agent": "console-docker-notifier",
        "x-console-event": e.type,
        "x-console-delivery": randomUUID(),
        "x-console-timestamp": timestamp,
        "x-console-signature": signPayload(secret, timestamp, body),
      },
    };
  }

  /** Message de test : envoi immédiat, sans reprise, résultat renvoyé à l'appelant (et journalisé). */
  async sendTest(): Promise<{ ok: boolean; status: number | null; error: string | null; durationMs: number }> {
    const s = await this.stored();
    const started = Date.now();
    const req = await this.request(s, { type: "test", title: "Message de test", text: "Les notifications de la console fonctionnent.", severity: "info", path: "/" });
    if (!req) throw new HttpError(409, "no_url", "Aucune adresse de webhook n'est enregistrée.");
    try {
      const res = await this.deliver(req);
      const ok = res.status >= 200 && res.status < 300;
      const durationMs = Date.now() - started;
      await this.record("test", { status: ok ? "sent" : "failed", httpStatus: res.status, durationMs, attempts: 1, error: ok ? null : `HTTP ${res.status}` });
      return { ok, status: res.status, error: ok ? null : `Le service a répondu HTTP ${res.status}.`, durationMs };
    } catch (err) {
      const durationMs = Date.now() - started;
      await this.record("test", { status: "failed", durationMs, attempts: 1, error: message(err) });
      return { ok: false, status: null, error: message(err), durationMs };
    }
  }

  /**
   * Notifie un événement (sans jamais bloquer ni faire échouer l'appelant) : ignoré si les notifications sont
   * désactivées ou l'événement coupé ; limité par heure ; reprises espacées en cas d'échec réseau, 5xx ou 429.
   */
  notify(e: NotifyEvent): void {
    this.pending++;
    void this.process(e)
      .catch((err: unknown) => this.opts.log?.error(err, "notification"))
      .finally(() => this.pending--);
  }

  /** Attend la fin des envois en cours (tests, arrêt propre). */
  async drain(): Promise<void> {
    while (this.pending > 0) await new Promise((r) => setTimeout(r, 10));
  }

  private async process(e: NotifyEvent): Promise<void> {
    const s = await this.stored();
    if (!s.enabled || !s.urlEnc || e.type === "test" || !s.events[e.type]) return;
    const recent = await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM notification_deliveries WHERE event <> 'test' AND status <> 'skipped' AND at > now() - interval '1 hour'");
    if ((recent.rows[0]?.n ?? 0) >= s.maxPerHour) {
      await this.record(e.type, { status: "skipped", error: "Plafond horaire atteint." });
      return;
    }
    const started = Date.now();
    let attempts = 0;
    let lastError = "";
    let httpStatus: number | null = null;
    for (let i = 0; i <= this.delays.length; i++) {
      attempts++;
      const req = await this.request(s, e);
      if (!req) {
        lastError = "adresse ou secret illisible (clé maître modifiée ?)";
        break;
      }
      try {
        const res = await this.deliver(req);
        httpStatus = res.status;
        if (res.status >= 200 && res.status < 300) {
          await this.record(e.type, { status: "sent", httpStatus, durationMs: Date.now() - started, attempts });
          return;
        }
        lastError = `HTTP ${res.status}`;
        // Une erreur du destinataire (4xx, hors 429) ne se corrige pas en réessayant.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (err) {
        lastError = message(err);
        if (/privée refusée/.test(lastError)) break;
      }
      const delay = this.delays[i];
      if (delay !== undefined) await new Promise((r) => setTimeout(r, delay));
    }
    await this.record(e.type, { status: "failed", httpStatus, durationMs: Date.now() - started, attempts, error: lastError });
  }
}
