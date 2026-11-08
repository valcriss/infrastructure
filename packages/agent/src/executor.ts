import { redact, type AgentMessage, type ImageUsed, type RunMessage, type ServiceState } from "@infra/shared";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { AUTH_HINT, isAuthDenied, prepareDockerAuth, type DockerAuth } from "./docker-auth.js";
import { encodeDotenv } from "./dotenv.js";
import { dockerGet } from "./docker.js";
import { LineBuffer, dockerEnv, runCommand } from "./exec.js";
import { exists, isManaged, syncStackDir } from "./workspace.js";

export interface ExecutorConfig {
  /**
   * Espace de travail des stacks. Il doit être monté au MÊME chemin absolu
   * dans le conteneur de l'agent et sur l'hôte : les bind mounts relatifs
   * d'un Compose sont interprétés par le démon Docker de l'hôte.
   */
  workspaceDir: string;
  dockerSocket: string;
  /** Délai maximal d'une commande Compose (téléchargements d'images inclus). */
  commandTimeoutMs?: number;
}

type Emit = (message: AgentMessage) => void;

const MAX_LOG_SLICE = 30_000;

/** Commande Docker refusée par un registre (droits ou identifiants) : seule erreur qui déclenche le repli anonyme. */
class RegistryDeniedError extends Error {}

/** Exécute les commandes typées reçues de la console. Aucune commande arbitraire. */
export class Executor {
  private readonly running = new Set<string>();
  private readonly timeoutMs: number;

  constructor(private readonly cfg: ExecutorConfig) {
    this.timeoutMs = cfg.commandTimeoutMs ?? 10 * 60 * 1000;
  }

  async run(msg: RunMessage, emit: Emit): Promise<void> {
    const secrets: string[] = [];
    if (msg.revision) {
      for (const name of msg.revision.sensitive) {
        const v = msg.revision.variables[name];
        if (v !== undefined) secrets.push(v);
      }
    }
    const logs = new LineBuffer(
      (text) => {
        for (let i = 0; i < text.length; i += MAX_LOG_SLICE) {
          emit({ type: "operation_log", operationId: msg.operationId, text: text.slice(i, i + MAX_LOG_SLICE) });
        }
      },
      (line) => redact(line, secrets),
    );
    const log = (line: string): void => logs.push(line + "\n");

    if (this.running.has(msg.stack.id)) {
      emit({
        type: "operation_result",
        operationId: msg.operationId,
        status: "failed",
        error: "Une opération est déjà en cours sur cette stack sur cet hôte.",
      });
      return;
    }
    this.running.add(msg.stack.id);
    let auth: DockerAuth | undefined;
    try {
      // Identifiants des registres privés : configuration Docker temporaire, supprimée à la fin de l'opération.
      auth = await prepareDockerAuth(dockerEnv(this.cfg.dockerSocket), msg.registryAuths);
      secrets.push(...auth.secrets);
      const outcome = await this.execute(msg, log, (chunk) => logs.push(chunk), auth);
      logs.end();
      emit({ type: "operation_result", operationId: msg.operationId, status: "succeeded", ...outcome });
    } catch (err) {
      log(`Échec : ${(err as Error).message}`);
      logs.end();
      emit({
        type: "operation_result",
        operationId: msg.operationId,
        status: "failed",
        error: redact((err as Error).message, secrets).slice(0, 4000),
      });
    } finally {
      await auth?.cleanup().catch(() => {});
      this.running.delete(msg.stack.id);
    }
  }

  private composeArgs(project: string, dir: string): string[] {
    return [
      "compose",
      "--project-name",
      project,
      "--project-directory",
      dir,
      "--file",
      join(dir, "compose.yaml"),
      "--env-file",
      join(dir, ".env"),
    ];
  }

  private async docker(args: string[], onOutput: (chunk: string) => void, env: NodeJS.ProcessEnv = dockerEnv(this.cfg.dockerSocket)): Promise<{ stdout: string }> {
    const res = await runCommand("docker", args, { env, timeoutMs: this.timeoutMs, onOutput });
    if (res.timedOut) throw new Error("Délai dépassé pour la commande Docker.");
    if (res.code !== 0) {
      const base = `La commande « docker ${args[0] ?? ""} » a échoué (code ${res.code}).`;
      throw isAuthDenied(res.stderr) ? new RegistryDeniedError(`${base} ${AUTH_HINT}`) : new Error(base);
    }
    return { stdout: res.stdout };
  }

  private async execute(
    msg: RunMessage,
    log: (line: string) => void,
    onOutput: (chunk: string) => void,
    auth: DockerAuth,
  ): Promise<{ images?: ImageUsed[]; services?: ServiceState[] }> {
    const { id, project } = msg.stack;
    const dir = join(this.cfg.workspaceDir, id);

    if (msg.action !== "deploy") {
      if (!(await exists(join(dir, "compose.yaml")))) {
        throw new Error("Cette stack n'a jamais été déployée sur cet hôte : rien à " + (msg.action === "stop" ? "arrêter." : "démarrer."));
      }
      log(`docker compose ${msg.action} (dernière configuration déployée)`);
      await this.docker([...this.composeArgs(project, dir), msg.action], onOutput);
      return { services: await this.observe(project, dir).catch(() => []) };
    }

    const revision = msg.revision;
    if (!revision) throw new Error("Révision absente de la commande de déploiement.");
    const options = msg.options ?? { pullImages: false, forceRecreate: false };

    // Ne jamais prendre le contrôle d'un projet Compose qui n'est pas le nôtre
    // (y compris la console elle-même).
    let adopting = false;
    if (!(await isManaged(dir))) {
      const existing = await this.projectContainers(project);
      if (existing > 0 && !options.adoptExisting) {
        throw new Error(
          `Un projet Compose « ${project} » existe déjà sur cet hôte et n'est pas géré par la console : déploiement refusé.`,
        );
      }
      if (existing > 0) {
        adopting = true;
        log(`Reprise du projet existant « ${project} » (${existing} conteneur(s)). Les services absents de ce Compose ne seront pas supprimés.`);
      }
    }

    const content = {
      compose: revision.compose,
      env: encodeDotenv(revision.variables),
      files: revision.files,
    };

    // 1. Validation dans un dossier temporaire : une configuration invalide
    //    échoue avant toute modification des conteneurs ou du dossier de la stack.
    const staging = `${dir}.staging`;
    await rm(staging, { recursive: true, force: true });
    log(`Validation de la révision ${revision.number}…`);
    try {
      await syncStackDir(staging, content);
      await this.docker([...this.composeArgs(project, staging), "config", "--quiet"], onOutput);
    } catch (err) {
      throw new Error(`Configuration invalide, aucun conteneur modifié. ${(err as Error).message}`, { cause: err });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    // 2. Matérialisation dans le dossier stable, puis application.
    await syncStackDir(dir, content);
    // Image personnalisée (« build: » dans le Compose) : construite sur l'hôte à chaque déploiement, avec le cache de couches.
    const hasBuild = /^\s*build\s*:/m.test(revision.compose);
    if (options.pullImages) {
      log("Téléchargement des images…");
      // Les images construites localement n'existent pas dans un registre : on ne tente pas de les télécharger.
      const pullArgs = [...this.composeArgs(project, dir), "pull", ...(hasBuild ? ["--ignore-buildable"] : [])];
      try {
        await this.docker(pullArgs, onOutput, auth.env);
      } catch (err) {
        // Un jeton périmé ne doit pas bloquer les images publiques : un seul nouvel essai, sans identifiants.
        if (!auth.active || !(err instanceof RegistryDeniedError)) throw err;
        log("Identifiants refusés par un registre : nouvel essai sans identifiants…");
        await this.docker(pullArgs, onOutput);
      }
    }
    if (hasBuild) {
      log("Construction des images personnalisées…");
      await this.docker([...this.composeArgs(project, dir), "build", ...(options.pullImages ? ["--pull"] : [])], onOutput, auth.env);
    }
    if (adopting) {
      // Information seulement : montre ce que la reprise va recréer. Un échec n'est pas bloquant.
      log("Prévisualisation des changements (aucune modification) :");
      try {
        await this.docker([...this.composeArgs(project, dir), "--dry-run", "up", "--detach"], onOutput);
      } catch {
        log("Prévisualisation indisponible avec cette version de Docker Compose.");
      }
    }
    log("Application de la configuration…");
    await this.docker(
      [
        ...this.composeArgs(project, dir),
        "up",
        "--detach",
        // Une reprise ne supprime jamais les conteneurs que le Compose fourni ne décrit pas.
        ...(adopting ? [] : ["--remove-orphans"]),
        ...(options.forceRecreate ? ["--force-recreate"] : []),
      ],
      onOutput,
      auth.env,
    );

    // 3. État observé et images réellement utilisées (digests).
    const [services, images] = await Promise.all([
      this.observe(project, dir).catch(() => []),
      this.imagesUsed(project).catch(() => []),
    ]);
    return { services, images };
  }

  private async projectContainers(project: string): Promise<number> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
    const list = await dockerGet(this.cfg.dockerSocket, `/containers/json?all=1&filters=${filters}`);
    return Array.isArray(list) ? list.length : 0;
  }

  /** `docker compose ps` après exécution : succès de la commande ≠ santé observée. */
  private async observe(project: string, dir: string): Promise<ServiceState[]> {
    const { stdout } = await this.docker(
      [...this.composeArgs(project, dir), "ps", "--all", "--format", "json"],
      () => {},
    );
    return parseComposePs(stdout);
  }

  private async imagesUsed(project: string): Promise<ImageUsed[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }));
    const list = (await dockerGet(this.cfg.dockerSocket, `/containers/json?all=1&filters=${filters}`)) as {
      Labels?: Record<string, string>;
      Image?: string;
      ImageID?: string;
    }[];
    const out = new Map<string, ImageUsed>();
    for (const c of list) {
      const service = c.Labels?.["com.docker.compose.service"] ?? "";
      const imageId = c.ImageID ?? "";
      if (!service || !imageId || out.has(service)) continue;
      let repoDigests: string[] = [];
      try {
        const info = (await dockerGet(this.cfg.dockerSocket, `/images/${encodeURIComponent(imageId)}/json`)) as {
          RepoDigests?: string[];
        };
        repoDigests = info.RepoDigests ?? [];
      } catch {
        /* image locale sans digest */
      }
      out.set(service, { service, image: c.Image ?? "", imageId, repoDigests });
    }
    return [...out.values()];
  }
}

/** `docker compose ps --format json` : tableau JSON ou une ligne JSON par conteneur. */
export function parseComposePs(stdout: string): ServiceState[] {
  const text = stdout.trim();
  if (!text) return [];
  let items: unknown[];
  try {
    const parsed: unknown = JSON.parse(text);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    items = text
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null);
  }
  return items.flatMap((i) => {
    const o = i as { Service?: unknown; State?: unknown; Health?: unknown };
    if (typeof o.Service !== "string" || typeof o.State !== "string") return [];
    return [{ service: o.Service, state: o.State, ...(typeof o.Health === "string" && o.Health ? { health: o.Health } : {}) }];
  });
}
