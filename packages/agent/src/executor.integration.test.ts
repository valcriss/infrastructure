import type { AgentMessage, RunMessage } from "@infra/shared";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Executor } from "./executor.js";

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
});
