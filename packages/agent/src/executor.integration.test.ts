import type { AgentMessage, RunMessage } from "@infra/shared";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectDiskUsage } from "./disk-usage.js";
import { collectInventory } from "./docker.js";
import { Executor } from "./executor.js";
import { LogStreamer } from "./logs.js";
import { DEFAULT_TRIVY_IMAGE } from "./config.js";
import { MetricsCollector } from "./metrics.js";
import { Prober } from "./probe.js";
import { Pruner } from "./pruner.js";
import { TrivyScanner } from "./scanner.js";

/**
 * Test d'intégration avec un vrai démon Docker (Linux uniquement). Le dossier
 * de travail est lu par le démon Docker : il doit donc avoir le même chemin
 * pour ce processus et pour le démon, comme dans le déploiement réel.
 *
 *   DOCKER_INTEGRATION=1 npm test -w @infra/agent
 *
 * Variable optionnelle INFRA_IT_DIR : dossier de travail à utiliser (monté au
 * même chemin dans un conteneur de test).
 */
const enabled = process.env.DOCKER_INTEGRATION === "1" && process.platform === "linux";

describe.skipIf(!enabled)("exécuteur avec un vrai Docker", () => {
  const root = process.env.INFRA_IT_DIR ?? mkdtempSync(join(tmpdir(), "infra-it-"));
  const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
  const projects: string[] = [];
  const executor = new Executor({ workspaceDir: root, dockerSocket: socket, commandTimeoutMs: 180_000 });

  const runAction = async (msg: RunMessage): Promise<{ result: Extract<AgentMessage, { type: "operation_result" }>; log: string }> => {
    let log = "";
    let result: Extract<AgentMessage, { type: "operation_result" }> | undefined;
    await executor.run(msg, (m) => {
      if (m.type === "operation_log") log += m.text;
      if (m.type === "operation_result") result = m;
    });
    if (!result) throw new Error("aucun résultat");
    return { result, log };
  };

  const deployMsg = (project: string, stackId: string, compose: string, variables: Record<string, string>, files: Record<string, string>, sensitive: string[] = []): RunMessage => ({
    type: "run",
    operationId: randomUUID(),
    action: "deploy",
    stack: { id: stackId, project },
    revision: { number: 1, compose, variables, sensitive, files },
    options: { pullImages: false, forceRecreate: false },
  });

  const dockerOut = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" });

  afterAll(() => {
    for (const p of projects) {
      try {
        dockerOut("compose", "--project-name", p, "down", "--volumes", "--remove-orphans", "--timeout", "1");
      } catch {
        /* déjà supprimé */
      }
    }
    if (!process.env.INFRA_IT_DIR) rmSync(root, { recursive: true, force: true });
  });

  it("monte un fichier relatif dans une application réelle et transmet les variables sans altération", async () => {
    const project = "it-" + randomBytes(4).toString("hex");
    projects.push(project);
    const stackId = randomUUID();
    const compose = [
      "services:",
      "  app:",
      "    image: alpine:3.20",
      '    command: ["sh", "-c", "cat /data/hello.txt; echo \\"S=$$S\\"; echo \\"Q=$$Q\\"; echo \\"D=$$D\\"; sleep 120"]',
      "    environment:",
      "      S: ${S}",
      "      Q: ${Q}",
      "      D: ${D}",
      "    volumes:",
      "      - ./data:/data:ro",
      "",
    ].join("\n");
    const variables = { S: "it's $HOME \\ \"x\" # no", Q: "motdepasse-secret-123", D: "a  b " };

    const { result, log } = await runAction(deployMsg(project, stackId, compose, variables, { "data/hello.txt": "bonjour-bind-mount" }, ["Q"]));
    expect(result.status, result.error ?? log).toBe("succeeded");
    expect(result.services?.[0]).toMatchObject({ service: "app", state: "running" });
    expect(result.images?.[0]?.imageId).toMatch(/^sha256:/);

    await new Promise((r) => setTimeout(r, 1500));
    const logs = dockerOut("compose", "--project-name", project, "logs", "--no-log-prefix", "app");
    expect(logs).toContain("bonjour-bind-mount");
    expect(logs).toContain(`S=${variables.S}`);
    expect(logs).toContain(`Q=${variables.Q}`);
    expect(logs).toContain(`D=${variables.D}`);
    // Les valeurs sensibles ne sont pas dans le journal d'opération renvoyé à la console.
    expect(log).not.toContain("motdepasse-secret-123");
  }, 240_000);

  it("construit une image personnalisée au déploiement, la reconstruit quand le Dockerfile change et sonde ses outils", async () => {
    const project = "it-" + randomBytes(4).toString("hex");
    projects.push(project);
    const stackId = randomUUID();
    const compose = ["services:", "  app:", "    build: ./build/app", `    image: ${project}-app-custom:local`, '    command: ["sh", "-c", "cat /marker; sleep 120"]', ""].join("\n");
    const dockerfile = (v: string) => `FROM alpine:3.20\nRUN echo ${v} > /marker\n`;

    const first = await runAction(deployMsg(project, stackId, compose, {}, { "build/app/Dockerfile": dockerfile("version-un") }));
    expect(first.result.status, first.result.error ?? first.log).toBe("succeeded");
    expect(first.log).toContain("Construction des images personnalisées");
    await new Promise((r) => setTimeout(r, 1500));
    expect(dockerOut("compose", "--project-name", project, "logs", "--no-log-prefix", "app")).toContain("version-un");

    // Sonde des outils du conteneur obtenu (alpine : wget et busybox, pas curl ; apk).
    const containerId = dockerOut("compose", "--project-name", project, "ps", "-q", "app").trim();
    const probe = new Prober(socket, async () => false);
    const probed: AgentMessage[] = [];
    await probe.tools(randomUUID(), containerId, (m) => probed.push(m));
    const tools = probed[0] as Extract<AgentMessage, { type: "tools_result" }>;
    expect(tools.error).toBeUndefined();
    expect(tools).toMatchObject({ shell: true, packageManager: "apk" });
    expect(tools.tools).toContain("wget");
    expect(tools.tools).not.toContain("curl");

    // Un nouveau Dockerfile est reconstruit et appliqué sans « forcer la recréation ».
    const second = await runAction(deployMsg(project, stackId, compose, {}, { "build/app/Dockerfile": dockerfile("version-deux") }));
    expect(second.result.status, second.result.error ?? second.log).toBe("succeeded");
    await new Promise((r) => setTimeout(r, 1500));
    expect(dockerOut("compose", "--project-name", project, "logs", "--no-log-prefix", "app")).toContain("version-deux");
    dockerOut("rmi", "-f", `${project}-app-custom:local`);
  }, 300_000);

  it("suit les logs d'une stack en direct puis arrête le flux", async () => {
    const project = "it-" + randomBytes(4).toString("hex");
    projects.push(project);
    const stackId = randomUUID();
    const compose = [
      "services:",
      "  app:",
      "    image: alpine:3.20",
      '    command: ["sh", "-c", "echo ligne-logs-1; sleep 1; echo ligne-logs-2; sleep 120"]',
      "",
    ].join("\n");
    expect((await runAction(deployMsg(project, stackId, compose, {}, {}))).result.status).toBe("succeeded");

    const streamer = new LogStreamer({ workspaceDir: root, dockerSocket: socket });
    const streamId = randomUUID();
    const lines: string[] = [];
    let ended = "";
    await streamer.start({ type: "logs_start", streamId, stack: { id: stackId, project }, service: "app", tail: 10 }, (m) => {
      if (m.type === "log_chunk") lines.push(...m.lines);
      if (m.type === "log_end") ended = m.reason;
    });
    const deadline = Date.now() + 15_000;
    while (!lines.join(" ").includes("ligne-logs-2") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    streamer.stop(streamId);
    expect(lines.join(" ")).toContain("ligne-logs-1");
    expect(lines.join(" ")).toContain("ligne-logs-2");
    expect(lines[0]).toMatch(/\d{4}-\d{2}-\d{2}T/); // horodatage demandé à Docker
    expect(ended).toBe("");

    // Stack jamais déployée : fin immédiate et explicite.
    let reason = "";
    await streamer.start({ type: "logs_start", streamId: randomUUID(), stack: { id: randomUUID(), project: "x" }, tail: 5 }, (m) => {
      if (m.type === "log_end") reason = m.reason;
    });
    expect(reason).toContain("jamais été déployée");
  }, 240_000);

  it("remonte la santé des conteneurs et des métriques réelles", async () => {
    const project = "it-" + randomBytes(4).toString("hex");
    projects.push(project);
    const compose = [
      "services:",
      "  sain:",
      "    image: alpine:3.20",
      "    command: ['sleep', '120']",
      "    healthcheck:",
      "      test: ['CMD', 'true']",
      "      interval: 1s",
      "  sans-check:",
      "    image: alpine:3.20",
      "    command: ['sh', '-c', 'while :; do :; done']", // boucle active : consomme du CPU
      "",
    ].join("\n");
    const { result, log } = await runAction(deployMsg(project, randomUUID(), compose, {}, {}));
    expect(result.status, result.error ?? log).toBe("succeeded");

    // Inventaire : healthcheck « healthy » vs « none » (non configuré), infos de l'hôte.
    const deadline = Date.now() + 30_000;
    let inv = await collectInventory(socket);
    const mine = () => inv.containers.filter((c) => c.composeProject === project);
    while (mine().find((c) => c.composeService === "sain")?.health !== "healthy" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      inv = await collectInventory(socket);
    }
    expect(mine().find((c) => c.composeService === "sain")).toMatchObject({ health: "healthy", state: "running", restartCount: 0 });
    expect(mine().find((c) => c.composeService === "sans-check")).toMatchObject({ health: "none", state: "running" });
    expect(mine()[0]?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(inv.hostInfo?.cpus).toBeGreaterThan(0);
    expect(inv.hostInfo?.memTotalBytes).toBeGreaterThan(0);

    // Métriques : le premier échantillon n'a pas de CPU, le second oui (boucle active > 5 %).
    const collector = new MetricsCollector(socket);
    const first = (await collector.collect()).filter((s) => s.project === project);
    expect(first.every((s) => s.cpuPercent === null)).toBe(true);
    await new Promise((r) => setTimeout(r, 2000));
    const second = (await collector.collect()).filter((s) => s.project === project);
    const busy = second.find((s) => s.service === "sans-check");
    expect(busy?.cpuPercent ?? 0).toBeGreaterThan(5);
    expect(busy?.memBytes).toBeGreaterThan(0);
    expect(busy?.memLimitBytes).toBeGreaterThan(busy?.memBytes ?? 0);
    expect(second.find((s) => s.service === "sain")?.cpuPercent ?? 100).toBeLessThan(50);
    expect(second.find((s) => s.service === "sain")?.netRxBytes).toBeGreaterThanOrEqual(0);
  }, 240_000);

  it("scanne une image avec Trivy (conteneur éphémère restreint) et nettoie derrière lui", async () => {
    dockerOut("pull", "-q", "alpine:3.12");
    const imageId = dockerOut("image", "inspect", "alpine:3.12", "--format", "{{.Id}}").trim();
    const cacheVolume = "it-trivy-cache-" + randomBytes(3).toString("hex");
    const cfg = { workspaceDir: root, dockerSocket: socket, trivyImage: DEFAULT_TRIVY_IMAGE, cacheVolume, memory: "2g", maxImageBytes: 5 * 1024 ** 3, timeoutMs: 15 * 60_000 };
    const scanner = new TrivyScanner(cfg);
    try {
      const ok = await scanner.scan({ type: "scan", scanId: randomUUID(), imageId, imageRef: "alpine:3.12" });
      expect(ok.status, ok.error).toBe("succeeded");
      expect(ok.trivy?.version).toBeTruthy();
      expect(ok.trivy?.dbUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // fraîcheur de la base
      expect(ok.os).toMatchObject({ family: "alpine" });
      expect(ok.total).toBeGreaterThan(0); // alpine 3.12 est en fin de vie et vulnérable
      const first = ok.vulnerabilities?.[0];
      expect(first).toMatchObject({ id: expect.stringMatching(/^CVE-/), pkg: expect.any(String), installed: expect.any(String) });
      expect(Object.values(ok.counts ?? {}).reduce((a, b) => a + b, 0)).toBe(ok.total);

      // Image inconnue, puis image trop volumineuse : échecs explicites, jamais un « aucune vulnérabilité ».
      const missing = await scanner.scan({ type: "scan", scanId: randomUUID(), imageId: "sha256:" + "0".repeat(64), imageRef: "absente" });
      expect(missing).toMatchObject({ status: "failed" });
      expect(missing.error).toContain("introuvable");
      const big = await new TrivyScanner({ ...cfg, maxImageBytes: 1000 }).scan({ type: "scan", scanId: randomUUID(), imageId, imageRef: "alpine:3.12" });
      expect(big.status).toBe("failed");
      expect(big.error).toContain("trop volumineuse");
      expect(big.vulnerabilities).toBeUndefined();

      // Aucune archive ni conteneur de scan ne subsiste.
      expect(readdirSync(root).filter((n) => n.startsWith(".scan-"))).toEqual([]);
      expect(dockerOut("ps", "-a", "--filter", "name=console-docker-scan-", "-q").trim()).toBe("");
    } finally {
      try {
        dockerOut("volume", "rm", "-f", cacheVolume);
      } catch {
        /* déjà supprimé */
      }
    }
  }, 900_000);

  it("scanne une image qui contient un .jar : la base Java (plusieurs centaines de Mo) ne doit pas saturer /tmp", async () => {
    const tag = "infra-jar-" + randomBytes(3).toString("hex");
    const cacheVolume = "it-trivy-cache-" + randomBytes(3).toString("hex");
    try {
      // Archive ZIP vide nommée .jar : suffit à faire initialiser la base Java par Trivy.
      execFileSync("docker", ["build", "-q", "-t", tag, "-"], {
        input: "FROM alpine:3.20\nRUN printf 'PK\\005\\006\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000\\000' > /app.jar\n",
        encoding: "utf8",
      });
      const imageId = dockerOut("image", "inspect", tag, "--format", "{{.Id}}").trim();
      const scanner = new TrivyScanner({ workspaceDir: root, dockerSocket: socket, trivyImage: DEFAULT_TRIVY_IMAGE, cacheVolume, memory: "2g", maxImageBytes: 5 * 1024 ** 3, timeoutMs: 20 * 60_000 });
      const r = await scanner.scan({ type: "scan", scanId: randomUUID(), imageId, imageRef: tag });
      expect(r.status, r.error).toBe("succeeded");
      expect(readdirSync(root).filter((n) => n.startsWith(".scan-"))).toEqual([]); // les fichiers temporaires sont supprimés avec le scan
    } finally {
      for (const args of [["rmi", "-f", tag], ["volume", "rm", "-f", cacheVolume]]) {
        try {
          dockerOut(...args);
        } catch {
          /* déjà supprimé */
        }
      }
    }
  }, 25 * 60_000);

  it("rejette une configuration invalide avant de toucher aux conteneurs", async () => {
    const project = "it-" + randomBytes(4).toString("hex");
    projects.push(project);
    const stackId = randomUUID();
    const ok = "services:\n  app:\n    image: alpine:3.20\n    command: ['sleep', '120']\n";
    expect((await runAction(deployMsg(project, stackId, ok, {}, {}))).result.status).toBe("succeeded");
    const before = dockerOut("ps", "-q", "--filter", `label=com.docker.compose.project=${project}`).trim();

    const bad = "services:\n  app:\n    image: alpine:3.20\n    environment:\n      X: ${ABSENTE:?obligatoire}\n";
    const { result } = await runAction(deployMsg(project, stackId, bad, {}, {}));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("aucun conteneur modifié");
    const after = dockerOut("ps", "-q", "--filter", `label=com.docker.compose.project=${project}`).trim();
    expect(after).toBe(before);
    expect(after).not.toBe("");
  }, 240_000);

  it("reprend un projet existant sur demande explicite sans supprimer ses autres services", async () => {
    const project = "it-" + randomBytes(4).toString("hex");
    projects.push(project);
    const foreign = mkdtempSync(join(tmpdir(), "infra-adopt-"));
    execFileSync("sh", ["-c", `printf "services:\n  ancien:\n    image: alpine:3.20\n    command: ['sleep','120']\n" > ${foreign}/compose.yaml`]);
    dockerOut("compose", "--project-name", project, "--project-directory", foreign, "-f", `${foreign}/compose.yaml`, "up", "-d");
    try {
      const compose = ["services:", "  nouveau:", "    image: alpine:3.20", "    command: ['sleep', '120']", ""].join("\n");
      const msg = deployMsg(project, randomUUID(), compose, {}, {});
      msg.options = { pullImages: false, forceRecreate: false, adoptExisting: true };
      const { result, log } = await runAction(msg);
      expect(result.status, result.error ?? log).toBe("succeeded");
      expect(log).toContain("Reprise du projet existant");
      const running = dockerOut("ps", "--format", "{{.Label \"com.docker.compose.service\"}}", "--filter", `label=com.docker.compose.project=${project}`)
        .split(/\s+/)
        .filter(Boolean)
        .sort();
      // Le service d'origine, absent du Compose fourni, n'est pas supprimé.
      expect(running).toEqual(["ancien", "nouveau"]);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  }, 240_000);

  it("refuse de prendre le contrôle d'un projet Compose existant non géré", async () => {
    const project = "it-" + randomBytes(4).toString("hex");
    projects.push(project);
    // Projet créé hors de la console, dans un autre dossier.
    const foreign = mkdtempSync(join(tmpdir(), "infra-foreign-"));
    execFileSync("sh", ["-c", `printf "services:\\n  x:\\n    image: alpine:3.20\\n    command: ['sleep','120']\\n" > ${foreign}/compose.yaml`]);
    dockerOut("compose", "--project-name", project, "--project-directory", foreign, "-f", `${foreign}/compose.yaml`, "up", "-d");
    try {
      const { result } = await runAction(deployMsg(project, randomUUID(), "services:\n  y:\n    image: alpine:3.20\n", {}, {}));
      expect(result.status).toBe("failed");
      expect(result.error).toContain("n'est pas géré");
      expect(dockerOut("ps", "-q", "--filter", `label=com.docker.compose.project=${project}`).trim()).not.toBe("");
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  }, 240_000);

  it("nettoie l'hôte en ne supprimant que l'inutilisé : conteneur arrêté, volume, réseau — jamais ce qui tourne", async () => {
    const tag = randomBytes(3).toString("hex");
    const stopped = `infra-prune-stopped-${tag}`;
    const running = `infra-prune-running-${tag}`;
    const freeVolume = `infra-prune-free-${tag}`;
    const busyVolume = `infra-prune-busy-${tag}`;
    const network = `infra-prune-net-${tag}`;
    const cleanup = (): void => {
      for (const args of [["rm", "-f", stopped, running], ["volume", "rm", "-f", freeVolume, busyVolume], ["network", "rm", network]]) {
        try {
          dockerOut(...args);
        } catch {
          /* déjà supprimé */
        }
      }
    };
    try {
      dockerOut("create", "--name", stopped, "alpine:3.20", "true");
      dockerOut("volume", "create", freeVolume);
      dockerOut("volume", "create", busyVolume);
      dockerOut("network", "create", network);
      dockerOut("run", "-d", "--name", running, "-v", `${busyVolume}:/data`, "alpine:3.20", "sleep", "120");

      const collect = () => collectDiskUsage({ socket, protectedAmong: async () => new Set(), protectedImageRefs: [] });
      const before = await collect();
      const ids = {
        stopped: before.candidates.containers.find((c) => c.name === stopped)?.id,
        network: before.candidates.networks.find((n) => n.name === network)?.id,
      };
      expect(ids.stopped).toBeDefined();
      expect(ids.network).toBeDefined();
      expect(before.candidates.volumes.map((v) => v.name)).toContain(freeVolume);
      expect(before.candidates.volumes.map((v) => v.name)).not.toContain(busyVolume); // utilisé par un conteneur en marche
      expect(before.candidates.containers.map((c) => c.name)).not.toContain(running);

      const progress: string[] = [];
      const result = await new Pruner({ socket, collect }).run(
        {
          type: "prune",
          operationId: randomUUID(),
          // On désigne aussi, volontairement, ce qui est utilisé : l'agent doit le refuser.
          targets: { containers: [ids.stopped as string], images: [], networks: [ids.network as string], volumes: [freeVolume, busyVolume] },
        },
        (p) => progress.push(`${p.phase}:${p.current ?? "fin"}`),
      );
      // L'avancement nomme l'élément en cours avant sa suppression.
      expect(progress).toEqual(expect.arrayContaining([`containers:${stopped}`, `networks:${network}`, `volumes:${freeVolume}`]));
      expect(result.status).toBe("succeeded");
      expect(result.removed).toMatchObject({ containers: 1, networks: 1, volumes: 1 });
      expect(result.skipped.join(" ")).toContain(busyVolume);

      const containers = dockerOut("ps", "-a", "--format", "{{.Names}}");
      expect(containers).not.toContain(stopped);
      expect(containers).toContain(running); // le conteneur en marche n'a pas été touché
      const volumes = dockerOut("volume", "ls", "--format", "{{.Name}}");
      expect(volumes).not.toContain(freeVolume);
      expect(volumes).toContain(busyVolume);
      expect(dockerOut("network", "ls", "--format", "{{.Name}}")).not.toContain(network);
    } finally {
      cleanup();
    }
  }, 120_000);
});
