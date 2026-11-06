import {
  ConsoleMessageSchema,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type AgentAuth,
  type AgentMessage,
} from "@infra/shared";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import { AGENT_VERSION, type AgentConfig } from "./config.js";
import { collectInventory } from "./docker.js";

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

  constructor(
    private readonly config: AgentConfig,
    private readonly log: (msg: string) => void = console.log,
  ) {}

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

      const send = (m: AgentMessage): void => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      };
      const sendInventory = async (): Promise<void> => {
        try {
          send({ type: "inventory", inventory: await collectInventory(this.config.dockerSocket) });
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
          capabilities: ["docker.standalone", "inventory"],
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
              heartbeat = setInterval(() => send({ type: "heartbeat" }), msg.heartbeatIntervalSec * 1000);
              inventoryTimer = setInterval(() => void sendInventory(), msg.inventoryIntervalSec * 1000);
              await sendInventory();
              break;
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
        clearInterval(heartbeat);
        clearInterval(inventoryTimer);
        this.socket = null;
        resolve(Date.now() - startedAt);
      };
      ws.on("close", finish);
      ws.on("error", (err) => this.log(`erreur de connexion : ${err.message}`));
    });
  }
}
