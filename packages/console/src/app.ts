import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  ChangeCredentialsSchema,
  LoginRequestSchema,
  MAX_MESSAGE_BYTES,
  OFFLINE_AFTER_SEC,
  SetupRequestSchema,
  type DiskUsageMessage,
  type HostSummary,
} from "@infra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { z, ZodError } from "zod";
import { BackupService } from "./backup.js";
import { Dashboard } from "./dashboard.js";
import { ImageWatcher } from "./image-watch.js";
import { loadUsedImages } from "./images.js";
import { ObservedWatcher } from "./observed-watch.js";
import { registerTraefikDynamicRoutes } from "./traefik-dynamic-routes.js";
import { registerTraefikRoutes } from "./traefik-routes.js";
import { registerRegistryAppRoutes } from "./registry-app-routes.js";
import { Notifier } from "./notifications.js";
import { registerNotificationRoutes } from "./notification-routes.js";
import { RegistryGc } from "./registry-gc.js";
import { RegistryImages, registerRegistryImageRoutes } from "./registry-images.js";
import { RegistryRetention, registerRegistryMaintenanceRoutes } from "./registry-maintenance.js";
import { RemediationService } from "./remediation.js";
import { registerRemediationRoutes } from "./remediation-routes.js";
import { RemediationApply } from "./remediation-apply.js";
import { registerRemediationAutoRoutes } from "./remediation-auto.js";
import { registerRemediationVerifyRoutes } from "./remediation-verify.js";
import { registerImageRoutes } from "./image-routes.js";
import { RegistryStore } from "./registries.js";
import { RegistryClient, createFetch } from "./registry.js";
import { ScanService } from "./scans.js";
import { listApplications } from "./applications.js";
import { registerDashboardRoutes } from "./dashboard-routes.js";
import { PruneService } from "./host-prune.js";
import { StorageService } from "./storage.js";
import { registerHostDiskRoutes } from "./host-disk-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { MetricsStore } from "./metrics-store.js";
import { registerBackupRoutes } from "./backup-routes.js";
import { GitRunner, validateRepoUrl } from "./git.js";
import { createRestorationKey } from "./restoration.js";
import { SecretBox } from "./secretbox.js";
import {
  LoginLimiter,
  SESSION_COOKIE,
  createSession,
  destroySession,
  requireAuth,
  sessionUser,
  requireSessionOrToken,
} from "./auth.js";
import { ensureBootstrapToken } from "./bootstrap.js";
import type { Config } from "./config.js";
import { hashPassword, randomToken, safeEqualHex, sha256, verifyPassword } from "./crypto.js";
import { audit, type Pool } from "./db.js";
import { AgentGateway } from "./gateway.js";
import { HttpError } from "./http-error.js";
import { LogStreams } from "./log-streams.js";
import { OperationsService } from "./operations.js";
import { buildOpenApi, toOpenApiPath } from "./openapi.js";
import { registerStackRoutes } from "./stack-routes.js";
import { registerTokenRoutes } from "./token-routes.js";
import { consumeRecoveryCode, consumeTotp } from "./mfa.js";
import { registerUserRoutes, sessionInfo } from "./user-routes.js";
import { TerminalService, registerTerminalRoutes } from "./terminal-routes.js";
import { ToolProbeService, registerToolRoutes } from "./tools-routes.js";
import { ContainerActionService, registerContainerRoutes } from "./container-routes.js";
import { RemovalPlanService, registerRemovalRoutes } from "./removal-routes.js";
import { registerAcceptanceRoutes } from "./acceptance-routes.js";
import { registerDisplayRoutes } from "./display.js";
import { registerExportRoutes } from "./export-routes.js";
import { registerComposeAnalyzeRoutes } from "./compose-analyze-routes.js";
import { registerVariableExtractRoutes } from "./variable-extract-routes.js";
import { registerCustomImageRoutes } from "./custom-image-routes.js";
import { CandidateScans } from "./candidates.js";
import { registerCandidateRoutes } from "./candidate-routes.js";

export interface AppDeps {
  config: Config;
  pool: Pool;
  logger?: boolean;
  /** Clé maître locale (32 octets) qui chiffre le jeton Git. */
  masterKey: Buffer;
  /** Tests uniquement : autorise file:// et http:// pour le dépôt de sauvegarde. */
  allowInsecureGit?: boolean;
}

export interface SetupState {
  /** Secret d'initialisation temporaire ; null une fois la console initialisée. */
  token: string | null;
}

export interface BuiltApp {
  app: FastifyInstance;
  setup: SetupState;
  gateway: AgentGateway;
  ops: OperationsService;
  backup: BackupService;
  metrics: MetricsStore;
  scans: ScanService;
  remediation: RemediationService;
  notifier: Notifier;
  /** Rétention automatique du registre (désactivée tant qu'un administrateur ne choisit pas le mode « auto »). */
  retention: RegistryRetention;
  candidates: CandidateScans;
  pruning: PruneService;
  watcher: ImageWatcher;
  observedWatcher: ObservedWatcher;
  storage: StorageService;
  /** Routes HTTP enregistrées (`METHODE chemin-openapi`), pour vérifier la documentation. */
  routes: string[];
}

const apiError = (code: string, message: string) => ({ error: { code, message } });

// Hash factice : égalise le temps de réponse quand l'identifiant est inconnu.
const DUMMY_HASH =
  "$argon2id$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export async function buildApp({ config, pool, logger = false, masterKey, allowInsecureGit = false }: AppDeps): Promise<BuiltApp> {
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  const limiter = new LoginLimiter();
  // `auth` : session de l'administrateur uniquement. `apiAuth` : session ou jeton API.
  const auth = requireAuth(pool);
  const apiAuth = requireSessionOrToken(pool, new LoginLimiter());

  const adminExists = async (): Promise<boolean> =>
    ((await pool.query("SELECT 1 FROM admin")).rowCount ?? 0) > 0;

  const setup: SetupState = { token: (await adminExists()) ? null : randomToken(24) };
  const gateway = new AgentGateway(pool, config.sharedDir, app.log, config.metricsIntervalSec);
  const metrics = new MetricsStore(pool, config.metricsIntervalSec, config.metricsRetentionDays);

  const routes: string[] = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      if (m !== "HEAD" && m !== "OPTIONS") routes.push(`${m.toLowerCase()} ${toOpenApiPath(route.url)}`);
    }
  });
  app.decorateRequest("actor", "");
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  app.addHook("onClose", async () => gateway.close());

  // Défense CSRF en plus de SameSite=Strict : refuse les requêtes modifiantes
  // dont l'en-tête Origin ne correspond pas à l'hôte demandé.
  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      /* origine invalide */
    }
    if (originHost !== request.headers.host) {
      await reply.code(403).send(apiError("forbidden_origin", "Origine refusée"));
    }
  });

  app.addHook("onSend", async (request, reply) => {
    // Le terminal utilise un WebSocket vers la console elle-même ; certains navigateurs ne le couvrent pas avec 'self'.
    const host = /^[A-Za-z0-9.:[\]-]+$/.test(request.headers.host ?? "") ? request.headers.host : "";
    const ws = host ? ` ws://${host} wss://${host}` : "";
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${ws}; frame-ancestors 'none'`,
    );
  });

  app.setErrorHandler(async (err: Error & { statusCode?: number }, _request, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
      });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: "Requête invalide",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send(apiError("bad_request", err.message));
    }
    app.log.error({ err }, "erreur interne");
    return reply.code(500).send(apiError("internal_error", "Erreur interne"));
  });

  // --- Statut public minimal ------------------------------------------------
  app.get("/api/v1/openapi.json", async () => buildOpenApi());

  app.get("/status", async () => ({ status: "ok", initialized: setup.token === null, passkeys: Boolean(config.webauthnRpId && config.webauthnOrigin) }));

  // --- Initialisation (une seule fois) --------------------------------------
  app.post("/api/v1/setup", async (request, reply) => {
    if (setup.token === null) {
      return reply.code(404).send(apiError("not_found", "Introuvable"));
    }
    const body = SetupRequestSchema.parse(request.body);
    if (!safeEqualHex(sha256(body.setupToken), sha256(setup.token))) {
      await audit(pool, "anonymous", "setup", null, "failure");
      return reply.code(403).send(apiError("invalid_setup_token", "Secret d'initialisation invalide"));
    }
    const passwordHash = await hashPassword(body.password);
    try {
      // La clé primaire `singleton` garantit un seul administrateur, même si
      // deux requêtes concurrentes passent la vérification ci-dessus. La clé de
      // restauration est générée (ou reprise du dépôt Git) à l'étape suivante
      // de l'assistant d'initialisation.
      await pool.query("INSERT INTO admin (username, password_hash) VALUES ($1, $2)", [body.username, passwordHash]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") {
        setup.token = null;
        return reply.code(409).send(apiError("already_initialized", "Déjà initialisée"));
      }
      throw err;
    }
    setup.token = null;
    // Premier utilisateur : administrateur. Un identifiant sans « @ » (compatibilité) reçoit une adresse locale.
    const email = body.username.includes("@") ? body.username.toLowerCase() : `${body.username.toLowerCase()}@console.local`;
    const legacy = body.username.includes("@") ? null : body.username;
    const created = await pool.query<{ id: string }>(
      `INSERT INTO users (email, username, display_name, role, password_hash) VALUES ($1, $2, $3, 'admin', $4) RETURNING id`,
      [email, legacy, body.username, passwordHash],
    );
    await audit(pool, body.username, "setup", null, "success");
    await ensureBootstrapToken(pool, config.sharedDir);
    await createSession(pool, config, reply, { userId: created.rows[0]?.id ?? "", method: "password", mfa: false });
    return reply.code(201).send({ username: body.username });
  });

  // --- Session ----------------------------------------------------------------
  app.post("/api/v1/session", async (request, reply) => {
    const body = LoginRequestSchema.parse(request.body);
    const id = body.username.toLowerCase();
    const key = `${id}|${request.ip}`;
    if (limiter.isBlocked(key)) {
      return reply.code(429).send(apiError("too_many_attempts", "Trop de tentatives, réessayez plus tard"));
    }
    const { rows } = await pool.query<{ id: string; email: string; username: string | null; role: string; password_hash: string | null; totp_secret: string | null; totp_enabled: boolean }>(
      `SELECT id, email, username, role, password_hash, totp_secret, totp_enabled FROM users
        WHERE (lower(email) = $1 OR lower(username) = $1) AND active`,
      [id],
    );
    const user = rows[0];
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !user.password_hash || !ok) {
      limiter.recordFailure(key);
      await audit(pool, body.username, "login", null, "failure");
      return reply.code(401).send(apiError("invalid_credentials", "Identifiants invalides"));
    }
    // Deuxième facteur : demandé seulement si le compte en a un (TOTP) ; un code de secours le remplace.
    let mfa = false;
    if (user.totp_enabled && user.totp_secret) {
      if (!body.code) {
        return reply.code(401).send(apiError("mfa_required", "Code à usage unique requis"));
      }
      mfa = (await consumeTotp(pool, user.id, box.open(user.totp_secret), body.code)) || (await consumeRecoveryCode(pool, user.id, body.code));
      if (!mfa) {
        limiter.recordFailure(key);
        await audit(pool, user.username ?? user.email, "login", null, "failure");
        return reply.code(401).send(apiError("invalid_code", "Code invalide"));
      }
    }
    limiter.reset(key);
    await createSession(pool, config, reply, { userId: user.id, method: "password", mfa });
    await audit(pool, user.username ?? user.email, "login", null, "success");
    return { username: user.username ?? user.email };
  });

  app.get("/api/v1/session", async (request, reply) => {
    const user = await sessionUser(pool, request);
    if (!user) {
      return reply.code(401).send(apiError("unauthorized", "Authentification requise"));
    }
    return sessionInfo(user, config);
  });

  // --- Compte administrateur ----------------------------------------------------
  app.get("/api/v1/admin/restoration-key", { preHandler: auth }, async () => {
    const { rows } = await pool.query<{ restoration_recipient: string | null }>(
      "SELECT restoration_recipient FROM admin",
    );
    return { recipient: rows[0]?.restoration_recipient ?? null };
  });

  // Génère la clé de restauration (une seule fois). La clé privée n'est jamais
  // stockée : elle n'est montrée qu'ici. Pas de rotation dans cette version.
  app.post("/api/v1/admin/restoration-key", { preHandler: auth }, async (request, reply) => {
    const key = await createRestorationKey();
    const res = await pool.query("UPDATE admin SET restoration_recipient = $1 WHERE restoration_recipient IS NULL", [key.recipient]);
    if ((res.rowCount ?? 0) === 0) {
      throw new HttpError(409, "restoration_key_exists", "Une clé de restauration existe déjà (la rotation n'est pas supportée).");
    }
    await audit(pool, request.actor, "restoration-key.create", null, "success");
    reply.header("Cache-Control", "no-store");
    return reply.code(201).send({ restorationKey: key.identity, recipient: key.recipient });
  });

  app.put("/api/v1/admin/credentials", { preHandler: auth }, async (request, reply) => {
    const body = ChangeCredentialsSchema.parse(request.body);
    const key = `credentials|${request.ip}`;
    if (limiter.isBlocked(key)) {
      return reply.code(429).send(apiError("too_many_attempts", "Trop de tentatives, réessayez plus tard"));
    }
    const current = request.user;
    if (!current) return reply.code(401).send(apiError("unauthorized", "Authentification requise"));
    const { rows } = await pool.query<{ password_hash: string | null; email: string; username: string | null }>(
      "SELECT password_hash, email, username FROM users WHERE id = $1",
      [current.id],
    );
    const row = rows[0];
    if (!row || !row.password_hash || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      limiter.recordFailure(key);
      await audit(pool, request.actor, "credentials.change", null, "failure");
      return reply.code(403).send(apiError("invalid_credentials", "Mot de passe actuel invalide"));
    }
    limiter.reset(key);
    const email = body.newEmail ?? row.email;
    const passwordHash = body.newPassword ? await hashPassword(body.newPassword) : row.password_hash;
    try {
      await pool.query(
        "UPDATE users SET email = $2, password_hash = $3, must_change_password = false, updated_at = now() WHERE id = $1",
        [current.id, email, passwordHash],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return reply.code(409).send(apiError("email_taken", "Un utilisateur porte déjà cet e-mail"));
      throw err;
    }
    // Toute autre session de cet utilisateur est révoquée ; seule la session courante est conservée.
    const token = request.cookies[SESSION_COOKIE];
    await pool.query("DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2", [current.id, sha256(token ?? "")]);
    await audit(pool, row.username ?? email, "credentials.change", null, "success");
    return { username: row.username ?? email, email };
  });

  app.delete("/api/v1/session", async (request, reply) => {
    await destroySession(pool, request, reply);
    return reply.code(204).send();
  });

  // --- Hôtes et agents ------------------------------------------------------
  interface HostRow {
    id: string;
    name: string;
    agent_version: string | null;
    capabilities: string[];
    last_seen_at: Date | null;
    docker_version: string | null;
    inventory_observed_at: Date | null;
    inventory: unknown[] | null;
    disk_summary?: DiskUsageMessage["summary"] | null;
    disk_observed_at?: string | null;
    disk_truncated?: boolean | null;
  }

  const toSummary = (row: HostRow): HostSummary => {
    const online = gateway.isOnline(row.id);
    return {
      id: row.id,
      name: row.name,
      agentVersion: row.agent_version,
      capabilities: row.capabilities,
      // Hors ligne = dernier état connu, pas « arrêté » (cf. project.md §6).
      presence: online ? "online" : "offline",
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
      dockerVersion: row.docker_version,
      inventoryObservedAt: row.inventory_observed_at?.toISOString() ?? null,
      containerCount: row.inventory ? row.inventory.length : null,
      diskUsage: row.disk_summary && row.disk_observed_at ? { observedAt: row.disk_observed_at, summary: row.disk_summary, truncated: row.disk_truncated ?? false } : null,
    };
  };

  const HOST_COLUMNS = `id, name, agent_version, capabilities, last_seen_at, docker_version,
                        inventory_observed_at, inventory, disk_usage->'summary' AS disk_summary,
                        disk_usage->>'observedAt' AS disk_observed_at, (disk_usage->>'truncated')::boolean AS disk_truncated`;

  app.get("/api/v1/hosts", { preHandler: apiAuth }, async () => {
    const { rows } = await pool.query<HostRow>(
      `SELECT ${HOST_COLUMNS} FROM hosts WHERE revoked_at IS NULL ORDER BY created_at`,
    );
    return { offlineAfterSec: OFFLINE_AFTER_SEC, hosts: rows.map(toSummary) };
  });

  const IdParams = z.object({ id: z.uuid() });

  app.get("/api/v1/hosts/:id", { preHandler: apiAuth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { rows } = await pool.query<HostRow>(
      `SELECT ${HOST_COLUMNS} FROM hosts WHERE id = $1 AND revoked_at IS NULL`,
      [id],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send(apiError("not_found", "Hôte introuvable"));
    return { ...toSummary(row), containers: row.inventory ?? [] };
  });

  app.delete("/api/v1/hosts/:id", { preHandler: apiAuth }, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const res = await pool.query(
      "UPDATE hosts SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
      [id],
    );
    if ((res.rowCount ?? 0) === 0) {
      return reply.code(404).send(apiError("not_found", "Hôte introuvable"));
    }
    gateway.disconnect(id);
    await audit(pool, request.actor, "host.revoke", id, "success");
    return reply.code(204).send();
  });

  const EnrollBody = z.object({ hostName: z.string().min(1).max(128).optional() }).default({});

  app.post("/api/v1/agents/enrollment-tokens", { preHandler: apiAuth }, async (request, reply) => {
    const body = EnrollBody.parse(request.body ?? {});
    const token = randomToken(32);
    const { rows } = await pool.query<{ expires_at: Date }>(
      `INSERT INTO enrollment_tokens (token_hash, purpose, host_name, expires_at)
       VALUES ($1, 'manual', $2, now() + interval '1 hour') RETURNING expires_at`,
      [sha256(token), body.hostName ?? null],
    );
    await audit(pool, request.actor, "enrollment-token.create", null, "success");
    // Le jeton n'est affiché qu'une seule fois ; seule son empreinte est stockée.
    return reply.code(201).send({ token, expiresAt: rows[0]?.expires_at.toISOString() });
  });

  const box = new SecretBox(masterKey);
  const registries = new RegistryStore(pool, box);
  const ops = new OperationsService(pool, gateway, registries);
  if (config.tlsSkipVerifyHosts?.length) {
    app.log.warn({ hosts: config.tlsSkipVerifyHosts }, "Vérification TLS désactivée pour Git et les vérifications de registres sur ces hôtes uniquement.");
  }
  const registryClient = new RegistryClient({ credentials: (r) => registries.credentials(r), fetchFn: await createFetch(config.registryCaFile, config.tlsSkipVerifyHosts) });
  const scans = new ScanService(pool, gateway, { warn: (m) => app.log.warn(m), error: (o, m) => app.log.error(o as object, m) });
  const remediation = new RemediationService(pool, gateway, scans, registries, { warn: (m) => app.log.warn(m), error: (o, m) => app.log.error(o as object, m) });
  const registryImages = new RegistryImages(pool, registryClient);
  const notifier = new Notifier(pool, box, { log: { error: (o, m) => app.log.error(o as object, m) } });
  remediation.notifier = notifier;
  const registryGc = new RegistryGc(pool, gateway, (held) => remediation.hold(held), (o) =>
    notifier.notify({ type: "registry.gc_failed", title: "Ramasse-miettes du registre en échec", text: `Le ramasse-miettes du registre est ${o.status === "unknown" ? "indéterminé" : "en échec"}${o.dryRun ? " (simulation)" : ""}. Consultez la page Registry.`, severity: "warning", path: "/settings?tab=registry", status: o.status }),
  );
  const retention = new RegistryRetention(pool, registryImages, registryGc, { error: (o, m) => app.log.error(o as object, m) });
  const watcher = new ImageWatcher(pool, registryClient, { error: (o, m) => app.log.error(o as object, m) });
  const observedWatcher = new ObservedWatcher(pool, registryClient, { error: (o, m) => app.log.error(o as object, m) });
  // Une image qui change sur un projet observé est revérifiée (versions) et rescannée tout de suite, sans attendre la planification.
  gateway.onObservedChange = (hostId, changes) => {
    const logError = (err: unknown, msg: string): void => app.log.error({ err, hostId }, msg);
    for (const project of new Set(changes.map((c) => c.project))) {
      void observedWatcher.checkProject(hostId, project).catch((err: unknown) => logError(err, "vérification d'un changement d'image observé"));
    }
    void (async () => {
      const images = await loadUsedImages(pool, { hostId });
      for (const change of changes) {
        const img = images.find((i) => i.imageId === change.imageId);
        const user = img?.usedBy.find((u) => u.project === change.project && u.service === change.service);
        if (!img || !user) continue;
        await scans
          .request({ imageId: img.imageId, platform: img.platform, hostId, imageRef: user.ref, trigger: "scheduled", requestedBy: "changement d'image" })
          .catch((err: unknown) => logError(err, "scan d'un changement d'image observé"));
      }
    })().catch((err: unknown) => logError(err, "scan d'un changement d'image observé"));
  };
  const candidates = new CandidateScans(pool, scans, gateway, registries);
  const logStreams = new LogStreams(gateway);
  const terminals = new TerminalService(pool, gateway);
  const toolProbes = new ToolProbeService(gateway);
  const containerActions = new ContainerActionService(gateway);
  const removalPlans = new RemovalPlanService(gateway);
  app.addHook("onClose", async () => terminals.closeAll());
  const pruning = new PruneService(pool, gateway);
  const storage = new StorageService(pool, gateway, { error: (o, m) => app.log.error(o as object, m) });
  gateway.setHandlers({
    onLog: (hostId, operationId, text) => ops.onLog(hostId, operationId, text),
    onResult: (hostId, msg) => ops.onResult(hostId, msg),
    onDisconnect: async (hostId) => {
      logStreams.onHostDisconnect(hostId);
      terminals.onHostDisconnect(hostId);
      toolProbes.onHostDisconnect(hostId);
      containerActions.onHostDisconnect(hostId);
      removalPlans.onHostDisconnect(hostId);
      await ops.onDisconnect(hostId);
      await scans.onDisconnect(hostId);
      await remediation.onDisconnect(hostId);
      registryGc.onDisconnect(hostId);
      await pruning.onDisconnect(hostId);
      storage.onDisconnect(hostId);
    },
    onLogChunk: (hostId, streamId, lines) => logStreams.onChunk(hostId, streamId, lines),
    onLogEnd: (hostId, streamId, reason) => logStreams.onEnd(hostId, streamId, reason),
    onToolsResult: (hostId, msg) => toolProbes.onResult(hostId, msg),
    onContainerActionResult: (hostId, msg) => containerActions.onResult(hostId, msg),
    onRemovalPlanResult: (hostId, msg) => removalPlans.onResult(hostId, msg),
    onImagePullResult: (hostId, msg) => void candidates.onPullResult(hostId, msg).catch((err: unknown) => app.log.error({ err }, "résultat de téléchargement d'image")),
    onTerminalData: (hostId, sessionId, data) => terminals.onData(hostId, sessionId, data),
    onTerminalEnd: (hostId, sessionId, reason, exitCode) => terminals.onEnd(hostId, sessionId, reason, exitCode),
    onMetrics: async (hostId, samples, host) => {
      await metrics.ingest(hostId, samples, host);
    },
    onScanResult: (hostId, result) => scans.onResult(hostId, result),
    onPatchProgress: (hostId, progress) => remediation.onProgress(hostId, progress),
    onPatchResult: (hostId, result) => remediation.onResult(hostId, result),
    onRegistryGcResult: (hostId, result) => registryGc.onResult(hostId, result),
    onStorageUsage: (hostId, msg) => storage.onResult(hostId, msg),
    onPruneResult: (hostId, result) => pruning.onResult(hostId, result),
    onPruneProgress: (hostId, progress) => pruning.onProgress(hostId, progress),
    onConnect: async () => {
      await scans.pumpAny();
      await remediation.pumpAny();
    },
  });
  app.addHook("onClose", async () => ops.close());
  const backup = new BackupService({
    pool,
    box,
    git: new GitRunner({ dataDir: config.dataDir, caFile: config.gitCaFile, allowInsecureProtocols: allowInsecureGit, tlsSkipVerifyHosts: config.tlsSkipVerifyHosts }),
    dataDir: config.dataDir,
    log: {
      info: (m) => app.log.info(m),
      warn: (m) => app.log.warn(m),
      error: (o, m) => app.log.error(o as object, m),
    },
    validateUrl: (url) => validateRepoUrl(url, allowInsecureGit),
  });
  app.addHook("onClose", async () => {
    backup.close();
    metrics.close();
    scans.close();
    remediation.close();
    retention.close();
    registryGc.close();
    candidates.close();
    watcher.close();
    observedWatcher.close();
    storage.close();
  });
  const dashboard = new Dashboard({ pool, metrics, backup, scans, watcher, observedWatcher, isOnline: (id) => gateway.isOnline(id) });
  registerImageRoutes(app, { pool, session: auth, apiAuth, scans, watcher, registries, registryClient, isOnline: (id) => gateway.isOnline(id) });
  registerHostDiskRoutes(app, { auth: apiAuth, session: auth, pruning });
  registerTraefikRoutes(app, { pool, auth: apiAuth, isOnline: (id) => gateway.isOnline(id) });
  registerTraefikDynamicRoutes(app, { pool, auth: apiAuth });
  registerRegistryAppRoutes(app, { pool, auth: apiAuth, registries });
  registerRegistryImageRoutes(app, { auth: apiAuth, images: registryImages });
  registerNotificationRoutes(app, { pool, auth: apiAuth, notifier });
  registerRegistryMaintenanceRoutes(app, { pool, auth: apiAuth, retention, gc: registryGc });
  registerRemediationRoutes(app, { auth: apiAuth, remediation, apply: new RemediationApply(pool, remediation) });
  registerRemediationAutoRoutes(app, { pool, auth: apiAuth, auto: remediation.auto });
  registerRemediationVerifyRoutes(app, { pool, auth: apiAuth });
  registerProjectRoutes(app, { pool, auth: apiAuth, observedWatcher, storage, metrics, logStreams, isOnline: (id) => gateway.isOnline(id), applications: () => listApplications({ pool, metrics, scans, watcher, isOnline: (id) => gateway.isOnline(id) }) });
  registerDashboardRoutes(app, { auth: apiAuth, dashboard, metrics, pool, applications: () => listApplications({ pool, metrics, scans, watcher, isOnline: (id) => gateway.isOnline(id) }) });
  registerStackRoutes(app, { pool, auth: apiAuth, ops, logStreams, backup, isOnline: (id) => gateway.isOnline(id) });
  registerTokenRoutes(app, { pool, auth });
  registerUserRoutes(app, { pool, config, box, auth, limiter });
  registerToolRoutes(app, { pool, auth, service: toolProbes });
  registerContainerRoutes(app, { pool, auth: apiAuth, metrics, logStreams, actions: containerActions, isOnline: (id) => gateway.isOnline(id) });
  registerRemovalRoutes(app, { pool, auth: apiAuth, ops, plans: removalPlans, isOnline: (id) => gateway.isOnline(id) });
  registerAcceptanceRoutes(app, { pool, auth });
  registerDisplayRoutes(app, { pool, auth });
  registerExportRoutes(app, { pool, auth, limiter, config });
  registerVariableExtractRoutes(app, { pool, auth });
  registerComposeAnalyzeRoutes(app, { pool, auth });
  registerCustomImageRoutes(app, { pool, auth });
  registerCandidateRoutes(app, { pool, auth, candidates, scans, watcher, registryClient });
  registerTerminalRoutes(app, { pool, auth, service: terminals, hasFactor: async (id) => ((await pool.query("SELECT 1 FROM passkeys WHERE user_id = $1", [id])).rowCount ?? 0) > 0 });
  registerBackupRoutes(app, { backup, session: auth, apiAuth });

  app.get("/agent/ws", { websocket: true }, (socket) => gateway.handle(socket));

  // --- Frontend statique ------------------------------------------------------
  if (config.webDir && existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir });
    app.setNotFoundHandler(async (request, reply) => {
      const path = request.url.split("?")[0] ?? "";
      if (request.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/agent/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send(apiError("not_found", "Introuvable"));
    });
  }

  return { app, setup, gateway, ops, backup, metrics, scans, remediation, notifier, retention, candidates, pruning, watcher, observedWatcher, storage, routes };
}
