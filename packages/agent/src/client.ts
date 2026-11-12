import {
  ConsoleMessageSchema,
  DEFAULT_METRICS_INTERVAL_SEC,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type AgentAuth,
  type AgentMessage,
} from "@infra/shared";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { AGENT_VERSION, TRIVY_CACHE_VOLUME, type AgentConfig } from "./config.js";
import { collectInventory, dockerGet } from "./docker.js";
import { ContainerActions } from "./container-actions.js";
import { Executor } from "./executor.js";
import { ReplayGuard, SelfProtection } from "./guard.js";
import { HostMetricsCollector } from "./host-metrics.js";
import { collectDiskUsage, matchingBuildCache, parseDf } from "./disk-usage.js";
import { RetainedBuildCache } from "./retained-cache.js";
import { fitInventory } from "./inventory-fit.js";
import { LogStreamer } from "./logs.js";
import { TerminalManager } from "./terminal.js";
import { Prober } from "./probe.js";
import { planRemoval } from "./removal.js";
import { MetricsCollector } from "./metrics.js";
import { Pruner } from "./pruner.js";
import { ImagePatcher } from "./patcher.js";
import { runRegistryGc } from "./registry-gc.js";
import { TrivyScanner } from "./scanner.js";
import { StorageMeter } from "./storage.js";

interface Credentials {
  agentId: string;
  secret: string;
}

const MIN_BACKOFF_MS = 1_000;
/** Relevé de l'espace disque Docker : coûteux, donc espacé (un relevé à la demande reste possible). */
const DISK_USAGE_INTERVAL_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 60_000;

async function readCredentials(stateDir: string): Promise<Credentials | null> {
  try {
    const data = JSON.parse(await readFile(join(stateDir, "credentials.json"), "utf8")) as Partial<Credentials>;
    if (typeof data.agentId === "string" && typeof data.secret === "string") {
      return { agentId: data.agentId, secret: data.secret };
    }
  } catch {
    /* pas encore enrôlé */
  }
  return null;
}

async function writeCredentials(stateDir: string, creds: Credentials): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const tmp = join(stateDir, "credentials.json.tmp");
  await writeFile(tmp, JSON.stringify(creds), { mode: 0o600 });
  await rename(tmp, join(stateDir, "credentials.json"));
}

async function readEnrollmentToken(config: AgentConfig): Promise<string | null> {
  if (config.enrollmentToken) return config.enrollmentToken;
  try {
    return (await readFile(config.bootstrapTokenFile, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Boucle de connexion sortante vers la console, avec reconnexion
 * exponentielle. L'agent n'exécute aucune commande reçue : il répond
 * uniquement aux messages typés du protocole.
 */
export class AgentClient {
  private stopped = false;
  private socket: WebSocket | null = null;
  private readonly executor: Executor;
  private readonly logs: LogStreamer;
  private readonly terminals: TerminalManager;
  private readonly prober: Prober;
  private readonly containerActions: ContainerActions;
  private readonly scanner: TrivyScanner;
  private readonly patcher: ImagePatcher;
  private gcRunning = false;
  private readonly storage: StorageMeter;
  /** Écart entre l'horloge de la console et celle de l'hôte (mesuré à la connexion), pour l'échéance des demandes. */
  private clockOffsetMs = 0;
  private readonly guard = new ReplayGuard(() => Date.now() + this.clockOffsetMs);
  private readonly protection: SelfProtection;
  private readonly pruner: Pruner;
  private readonly retained: RetainedBuildCache;
  /** Résultats terminés pendant une coupure : renvoyés à la reconnexion. */
  private unsent: AgentMessage[] = [];

  constructor(
    private readonly config: AgentConfig,
    private readonly log: (msg: string) => void = console.log,
  ) {
    this.executor = new Executor({
      workspaceDir: config.workspaceDir,
      dockerSocket: config.dockerSocket,
    });
    this.protection = new SelfProtection(config.dockerSocket, config.selfContainer, config.protectedProjects, { warn: (m) => this.log(m) });
    this.retained = new RetainedBuildCache(join(config.stateDir, "build-cache-retained.json"));
    this.pruner = new Pruner({
      socket: config.dockerSocket,
      collect: () => this.collectDisk(),
      retainedAfterBuildPrune: async (criteria, startedAtMs) => {
        const df = parseDf(await dockerGet(config.dockerSocket, "/system/df", 120_000));
        const left = matchingBuildCache(df, criteria, startedAtMs);
        await this.retained.add(left.map((x) => x.id));
        return { count: left.length, bytes: left.reduce((s, x) => s + x.sizeBytes, 0) };
      },
    });
    this.prober = new Prober(config.dockerSocket, (project) => this.protection.isProtected(project));
    this.terminals = new TerminalManager(config.dockerSocket, (project) => this.protection.isProtected(project));
    this.containerActions = new ContainerActions(config.dockerSocket, (project) => this.protection.isProtected(project));
    this.logs = new LogStreamer({ workspaceDir: config.workspaceDir, dockerSocket: config.dockerSocket });
    this.storage = new StorageMeter({ socket: config.dockerSocket, selfContainer: config.selfContainer, fallbackImage: config.trivyImage });
    this.scanner = new TrivyScanner({
      workspaceDir: config.workspaceDir,
      dockerSocket: config.dockerSocket,
      trivyImage: config.trivyImage,
      cacheVolume: TRIVY_CACHE_VOLUME,
      memory: config.trivyMemory,
      maxImageBytes: config.trivyMaxImageBytes,
      timeoutMs: 20 * 60 * 1000,
    });
    this.patcher = new ImagePatcher({
      workspaceDir: config.workspaceDir,
      dockerSocket: config.dockerSocket,
      patcherImage: config.patcherImage,
      buildkitImage: config.buildkitImage,
      buildkitPrivileged: config.buildkitPrivileged,
      buildkitPrivilegedImage: config.buildkitPrivilegedImage,
      trivyImage: config.trivyImage,
      trivyCacheVolume: TRIVY_CACHE_VOLUME,
      buildkitMemory: config.buildkitMemory,
      trivyMemory: config.trivyMemory,
      maxImageBytes: config.trivyMaxImageBytes,
    });
  }

  /** Espace disque Docker et candidats au nettoyage, sans les projets protégés ni l'image de Trivy. */
  private collectDisk() {
    return collectDiskUsage({
      socket: this.config.dockerSocket,
      protectedAmong: (projects) => this.protection.protectedAmong(projects),
      protectedImageRefs: [this.config.trivyImage, this.config.patcherImage, this.config.buildkitImage, this.config.buildkitPrivilegedImage],
      retained: this.retained,
    });
  }

  /** Envoie un message sur la connexion courante ; conserve les résultats si elle est coupée. */
  private emit(message: AgentMessage): void {
    const ws = this.socket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else if (message.type === "operation_result" || message.type === "scan_result") {
      this.unsent.push(message);
    }
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close(1001, "shutdown");
  }

  async run(): Promise<void> {
    let backoff = MIN_BACKOFF_MS;
    while (!this.stopped) {
      const connectedFor = await this.connectOnce();
      if (this.stopped) break;
      // Une session stable remet le délai à zéro.
      backoff = connectedFor > 30_000 ? MIN_BACKOFF_MS : Math.min(backoff * 2, MAX_BACKOFF_MS);
      this.log(`reconnexion dans ${Math.round(backoff / 1000)} s`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  /** Retourne la durée de la connexion en millisecondes. */
  private async connectOnce(): Promise<number> {
    let auth: AgentAuth | null = null;
    const creds = await readCredentials(this.config.stateDir);
    if (creds) {
      auth = { kind: "credentials", agentId: creds.agentId, secret: creds.secret };
    } else {
      const token = await readEnrollmentToken(this.config);
      if (token) auth = { kind: "enrollment", token };
    }
    if (!auth) {
      this.log("aucun identifiant ni jeton d'enrôlement disponible, nouvel essai plus tard");
      return 0;
    }

    return new Promise<number>((resolve) => {
      const startedAt = Date.now();
      const ws = new WebSocket(this.config.consoleUrl, { maxPayload: MAX_MESSAGE_BYTES });
      this.socket = ws;
      let heartbeat: NodeJS.Timeout | undefined;
      let inventoryTimer: NodeJS.Timeout | undefined;
      let metricsTimer: NodeJS.Timeout | undefined;
      let diskTimer: NodeJS.Timeout | undefined;
      let diskBusy = false;
      // Après une opération, l'état réel des conteneurs (démarrage, healthchecks) évolue pendant quelques
      // secondes : on renvoie l'inventaire à intervalles rapprochés au lieu d'attendre la période normale.
      const burstTimers = new Set<NodeJS.Timeout>();
      const POST_OPERATION_INVENTORY_DELAYS_SEC = [0, 5, 15, 30, 60];
      const collector = new MetricsCollector(this.config.dockerSocket);
      const hostCollector = new HostMetricsCollector(this.config.workspaceDir);

      const send = (m: AgentMessage): void => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      };
      let lastDropped = "";
      const sendMetrics = async (): Promise<void> => {
        try {
          const samples = await collector.collect();
          const host = await hostCollector.collect();
          send({ type: "metrics", observedAt: new Date().toISOString(), samples, ...(host ? { host } : {}) });
        } catch (err) {
          this.log(`métriques Docker impossibles : ${(err as Error).message}`);
        }
      };
      // `docker system df` peut être lent avec beaucoup d'images : un relevé à la fois, jamais en parallèle d'un autre.
      const sendDiskUsage = async (): Promise<void> => {
        if (diskBusy) return;
        diskBusy = true;
        try {
          send(await this.collectDisk());
        } catch (err) {
          this.log(`espace disque Docker indisponible : ${(err as Error).message}`);
        } finally {
          diskBusy = false;
        }
      };
      const inventoryAfterOperation = (): void => {
        for (const delay of POST_OPERATION_INVENTORY_DELAYS_SEC) {
          const t = setTimeout(() => {
            burstTimers.delete(t);
            void sendInventory();
          }, delay * 1000);
          burstTimers.add(t);
        }
      };
      const sendInventory = async (): Promise<void> => {
        try {
          // Un inventaire trop gros ferait fermer la connexion : on abandonne les détails facultatifs plutôt que l'état.
          const { inventory, dropped } = fitInventory(await collectInventory(this.config.dockerSocket), MAX_MESSAGE_BYTES * 0.9);
          if (dropped.length > 0 && dropped.join() !== lastDropped) this.log(`inventaire réduit pour tenir dans la limite de taille : ${dropped.join(", ")} omis`);
          lastDropped = dropped.join();
          send({ type: "inventory", inventory });
        } catch (err) {
          this.log(`inventaire Docker impossible : ${(err as Error).message}`);
        }
      };

      ws.on("open", () => {
        send({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          agentVersion: AGENT_VERSION,
          hostname: this.config.hostname,
          capabilities: ["docker.standalone", "inventory", "compose.deploy", "logs.stream", "terminal.exec", "image.pull", "metrics", "scan.trivy", "image.patch", "image.patch.cancel", "image.patch.verify", "registry.gc"],
          auth: auth,
        });
      });

      ws.on("message", (raw) => {
        void (async () => {
          let parsed;
          try {
            parsed = ConsoleMessageSchema.safeParse(JSON.parse(raw.toString()));
          } catch {
            return;
          }
          if (!parsed.success) return;
          const msg = parsed.data;
          switch (msg.type) {
            case "welcome":
              if (msg.credentials) {
                await writeCredentials(this.config.stateDir, msg.credentials);
                this.log(`enrôlé comme ${msg.credentials.agentId}`);
              } else {
                this.log("connecté à la console");
              }
              if (msg.serverTime) this.clockOffsetMs = Date.parse(msg.serverTime) - Date.now();
              heartbeat = setInterval(() => send({ type: "heartbeat" }), msg.heartbeatIntervalSec * 1000);
              inventoryTimer = setInterval(() => void sendInventory(), msg.inventoryIntervalSec * 1000);
              // Période de collecte fixée par la console (30 s par défaut).
              diskTimer = setInterval(() => void sendDiskUsage(), DISK_USAGE_INTERVAL_MS);
              setTimeout(() => void sendDiskUsage(), 15_000).unref();
              metricsTimer = setInterval(() => void sendMetrics(), (msg.metricsIntervalSec ?? DEFAULT_METRICS_INTERVAL_SEC) * 1000);
              for (const pending of this.unsent.splice(0)) this.emit(pending);
              await sendInventory();
              // Premier relevé : sert de référence pour le calcul du CPU du suivant.
              void sendMetrics();
              break;
            case "patch": {
              const verdict = this.guard.check(msg.jobId, msg.expiresAt);
              if (verdict !== "ok") {
                this.log(`demande de correctif ${verdict === "replayed" ? "rejouée" : "expirée"} ignorée (${msg.jobId})`);
                if (verdict === "expired") this.emit({ type: "patch_result", jobId: msg.jobId, status: "failed", error: "Demande de correctif expirée avant exécution." });
                break;
              }
              // Un correctif à la fois ; le résultat repasse par emit() (conservé si la connexion est coupée).
              void this.patcher
                .patch(msg, (m) => this.emit(m))
                .then((result) => this.emit(result))
                .catch((err: unknown) => {
                  this.log(`erreur de correctif : ${(err as Error).message}`);
                  this.emit({ type: "patch_result", jobId: msg.jobId, status: "failed", error: `Erreur inattendue de l'agent : ${(err as Error).message}`.slice(0, 500) });
                });
              break;
            }
            case "patch_cancel":
              // Sans effet si le correctif est terminé ou inconnu : la console le déduira du résultat ou de son délai.
              this.log(`annulation du correctif ${msg.jobId} : ${this.patcher.cancel(msg.jobId) ? "demandée" : "rien à arrêter"}`);
              break;
            case "registry_gc": {
              const verdict = this.guard.check(msg.requestId, msg.expiresAt);
              if (verdict !== "ok") {
                this.log(`demande de ramasse-miettes ${verdict === "replayed" ? "rejouée" : "expirée"} ignorée (${msg.requestId})`);
                if (verdict === "expired") this.emit({ type: "registry_gc_result", requestId: msg.requestId, status: "failed", dryRun: msg.dryRun, error: "Demande expirée avant exécution." });
                break;
              }
              // Un seul ramasse-miettes à la fois : un second est refusé (le registre ne supporte pas deux GC simultanés).
              if (this.gcRunning) {
                this.emit({ type: "registry_gc_result", requestId: msg.requestId, status: "failed", dryRun: msg.dryRun, error: "Un ramasse-miettes est déjà en cours sur cet hôte." });
                break;
              }
              this.gcRunning = true;
              void runRegistryGc(msg, this.config.dockerSocket)
                .then((result) => this.emit(result))
                .catch((err: unknown) => this.emit({ type: "registry_gc_result", requestId: msg.requestId, status: "failed", dryRun: msg.dryRun, error: `Erreur inattendue de l'agent : ${(err as Error).message}`.slice(0, 500) }))
                .finally(() => (this.gcRunning = false));
              break;
            }
            case "scan": {
              const verdict = this.guard.check(msg.scanId, msg.expiresAt);
              if (verdict !== "ok") {
                this.log(`demande de scan ${verdict === "replayed" ? "rejouée" : "expirée"} ignorée (${msg.scanId})`);
                if (verdict === "expired") {
                  this.emit({ type: "scan_result", scanId: msg.scanId, status: "failed", error: "Demande de scan expirée avant exécution." });
                }
                break;
              }
              // Un scan à la fois ; le résultat repasse par emit() (conservé si la connexion est coupée).
              void this.scanner
                .scan(msg)
                .then((result) => this.emit(result))
                .catch((err: unknown) => {
                  // Toujours répondre : sans résultat, la console garderait le scan « en cours » et bloquerait la file.
                  this.log(`erreur de scan : ${(err as Error).message}`);
                  this.emit({ type: "scan_result", scanId: msg.scanId, status: "failed", error: `Erreur inattendue de l'agent : ${(err as Error).message}`.slice(0, 500) });
                });
              break;
            }
            case "logs_start":
              void this.logs
                .start(msg, (m) => this.emit(m))
                .catch((err: unknown) => this.log(`erreur de flux de logs : ${(err as Error).message}`));
              break;
            case "logs_stop":
              this.logs.stop(msg.streamId);
              break;
            case "terminal_open":
              void this.terminals
                .open(msg, (m) => this.emit(m))
                .catch((err: unknown) => {
                  this.log(`erreur de terminal : ${(err as Error).message}`);
                  this.emit({ type: "terminal_end", sessionId: msg.sessionId, reason: "Erreur inattendue de l'agent." });
                });
              break;
            case "terminal_input":
              this.terminals.input(msg.sessionId, msg.data);
              break;
            case "terminal_resize":
              this.terminals.resize(msg.sessionId, msg.cols, msg.rows);
              break;
            case "terminal_close":
              this.terminals.close(msg.sessionId);
              break;
            case "tools_probe":
              void this.prober
                .tools(msg.probeId, msg.containerId, (m) => this.emit(m))
                .catch((err: unknown) => this.emit({ type: "tools_result", probeId: msg.probeId, error: `Erreur de l'agent : ${(err as Error).message}`.slice(0, 300), tools: [], packageManagers: [], user: "", shell: false }));
              break;
            case "image_pull": {
              const verdict = this.guard.check(msg.pullId, msg.expiresAt);
              if (verdict === "replayed") break;
              if (verdict === "expired") {
                this.emit({ type: "image_pull_result", pullId: msg.pullId, status: "failed", error: "Demande expirée avant exécution." });
                break;
              }
              void this.prober.pull(msg, (m) => this.emit(m));
              break;
            }
            case "image_remove":
              void this.prober.remove(msg.imageId);
              break;
            case "container_action": {
              const verdict = this.guard.check(msg.actionId, msg.expiresAt);
              // Rejouée : ignorée sans réponse (un « échec » écraserait le vrai résultat).
              if (verdict === "replayed") break;
              if (verdict === "expired") {
                this.emit({ type: "container_action_result", actionId: msg.actionId, status: "failed", error: "Demande expirée avant exécution." });
                break;
              }
              void this.containerActions
                .run(msg, (m) => this.emit(m))
                .then(inventoryAfterOperation)
                .catch((err: unknown) => this.emit({ type: "container_action_result", actionId: msg.actionId, status: "failed", error: `Erreur de l'agent : ${(err as Error).message}`.slice(0, 300) }));
              break;
            }
            case "removal_plan": {
              const failed = (error: string): void =>
                this.emit({ type: "removal_plan_result", planId: msg.planId, error: error.slice(0, 300), containers: [], running: 0, networks: [], volumes: [], images: [], binds: [], workspace: false });
              void this.protection
                .isProtected(msg.stack.project)
                .then((isProtected) =>
                  isProtected ? failed(`La stack « ${msg.stack.project} » fait tourner la console ou son agent : elle ne peut pas être supprimée depuis son propre interface.`) : planRemoval(this.config.dockerSocket, this.config.workspaceDir, msg).then((plan) => this.emit(plan)),
                )
                .catch((err: unknown) => failed(`Erreur de l'agent : ${(err as Error).message}`));
              break;
            }
            case "run": {
              const verdict = this.guard.check(msg.operationId, msg.expiresAt);
              if (verdict === "replayed") {
                // Ne répond pas : un « échec » écraserait le vrai résultat de l'opération déjà traitée.
                this.log(`demande rejouée ignorée (${msg.operationId})`);
                break;
              }
              const refuse = (error: string): void => this.emit({ type: "operation_result", operationId: msg.operationId, status: "failed", error });
              if (verdict === "expired") {
                refuse("Demande expirée avant exécution.");
                break;
              }
              // Traité en tâche de fond ; le résultat repasse par emit().
              void this.protection
                .isProtected(msg.stack.project)
                .then((isProtected) =>
                  isProtected
                    ? refuse(`La stack « ${msg.stack.project} » fait tourner la console ou son agent : elle ne peut pas être arrêtée ni redéployée depuis son propre interface.`)
                    : this.executor.run(msg, (m) => this.emit(m)).then(inventoryAfterOperation),
                )
                .catch((err: unknown) => this.log(`erreur d'exécution : ${(err as Error).message}`));
              break;
            }
            case "request_disk_usage":
              void sendDiskUsage();
              break;
            case "request_storage":
              // En tâche de fond : un `du` peut durer plusieurs minutes ; le résultat repasse par emit().
              void this.storage
                .measure(msg.requestId, msg.volumes, msg.binds)
                .then((result) => {
                  if (result) this.emit(result);
                })
                .catch((err: unknown) => this.log(`mesure des montages impossible : ${(err as Error).message}`));
              break;
            case "prune": {
              const verdict = this.guard.check(msg.operationId, msg.expiresAt);
              if (verdict === "replayed") {
                this.log(`demande de nettoyage rejouée ignorée (${msg.operationId})`);
                break;
              }
              const failed = (error: string): void =>
                this.emit({ type: "prune_result", operationId: msg.operationId, status: "failed", error, removed: { containers: 0, images: 0, networks: 0, volumes: 0, buildCache: 0 }, reclaimedBytes: 0, skipped: [], errors: [] });
              if (verdict === "expired") {
                failed("Demande de nettoyage expirée avant exécution.");
                break;
              }
              // Un nettoyage à la fois ; le résultat repasse par emit() (conservé si la connexion est coupée).
              void this.pruner
                .run(msg, (p) => this.emit(p))
                .then((result) => {
                  this.emit(result);
                  void sendDiskUsage();
                })
                .catch((err: unknown) => failed(`erreur de nettoyage : ${(err as Error).message}`));
              break;
            }
            case "request_inventory":
              await sendInventory();
              break;
            case "error":
              this.log(`erreur de la console (${msg.code}) : ${msg.message}`);
              break;
          }
        })();
      });

      const finish = (): void => {
        // Plus de client pour lire les flux : ils sont arrêtés avec la connexion.
        this.logs.stopAll();
        this.terminals.closeAll();
        clearInterval(heartbeat);
        clearInterval(inventoryTimer);
        clearInterval(metricsTimer);
        clearInterval(diskTimer);
        for (const t of burstTimers) clearTimeout(t);
        burstTimers.clear();
        this.socket = null;
        resolve(Date.now() - startedAt);
      };
      ws.on("close", finish);
      ws.on("error", (err) => this.log(`erreur de connexion : ${err.message}`));
    });
  }
}
