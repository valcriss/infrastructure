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
import { collectInventory } from "./docker.js";
import { Executor } from "./executor.js";
import { ReplayGuard, SelfProtection } from "./guard.js";
import { HostMetricsCollector } from "./host-metrics.js";
import { fitInventory } from "./inventory-fit.js";
import { LogStreamer } from "./logs.js";
import { MetricsCollector } from "./metrics.js";
import { TrivyScanner } from "./scanner.js";

interface Credentials {
  agentId: string;
  secret: string;
}

const MIN_BACKOFF_MS = 1_000;
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
  private readonly scanner: TrivyScanner;
  /** Écart entre l'horloge de la console et celle de l'hôte (mesuré à la connexion), pour l'échéance des demandes. */
  private clockOffsetMs = 0;
  private readonly guard = new ReplayGuard(() => Date.now() + this.clockOffsetMs);
  private readonly protection: SelfProtection;
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
    this.logs = new LogStreamer({ workspaceDir: config.workspaceDir, dockerSocket: config.dockerSocket });
    this.scanner = new TrivyScanner({
      workspaceDir: config.workspaceDir,
      dockerSocket: config.dockerSocket,
      trivyImage: config.trivyImage,
      cacheVolume: TRIVY_CACHE_VOLUME,
      memory: config.trivyMemory,
      maxImageBytes: config.trivyMaxImageBytes,
      timeoutMs: 20 * 60 * 1000,
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
          capabilities: ["docker.standalone", "inventory", "compose.deploy", "logs.stream", "metrics", "scan.trivy"],
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
              metricsTimer = setInterval(() => void sendMetrics(), (msg.metricsIntervalSec ?? DEFAULT_METRICS_INTERVAL_SEC) * 1000);
              for (const pending of this.unsent.splice(0)) this.emit(pending);
              await sendInventory();
              // Premier relevé : sert de référence pour le calcul du CPU du suivant.
              void sendMetrics();
              break;
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
                .catch((err: unknown) => this.log(`erreur de scan : ${(err as Error).message}`));
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
                    : this.executor.run(msg, (m) => this.emit(m)),
                )
                .catch((err: unknown) => this.log(`erreur d'exécution : ${(err as Error).message}`));
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
        clearInterval(heartbeat);
        clearInterval(inventoryTimer);
        clearInterval(metricsTimer);
        this.socket = null;
        resolve(Date.now() - startedAt);
      };
      ws.on("close", finish);
      ws.on("error", (err) => this.log(`erreur de connexion : ${err.message}`));
    });
  }
}
