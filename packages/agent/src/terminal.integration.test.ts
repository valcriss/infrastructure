import type { AgentMessage } from "@infra/shared";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TerminalManager } from "./terminal.js";

/** Test d'intégration avec un vrai démon Docker (Linux uniquement) : DOCKER_INTEGRATION=1 npm test -w @infra/agent */
const enabled = process.env.DOCKER_INTEGRATION === "1" && process.platform === "linux";

describe.skipIf(!enabled)("terminal interactif avec un vrai Docker", () => {
  const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
  const name = `infra-term-${randomUUID().slice(0, 8)}`;
  let containerId = "";
  let protectedId = "";
  const protectedName = `infra-term-prot-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    containerId = execFileSync("docker", ["run", "-d", "--name", name, "alpine:3", "sleep", "120"], { encoding: "utf8" }).trim();
    protectedId = execFileSync("docker", ["run", "-d", "--name", protectedName, "--label", "com.docker.compose.project=console-projet", "alpine:3", "sleep", "120"], { encoding: "utf8" }).trim();
  });
  afterAll(() => {
    execFileSync("docker", ["rm", "-f", name, protectedName], { stdio: "ignore" });
  });

  const collect = () => {
    const messages: AgentMessage[] = [];
    let text = "";
    return {
      emit: (m: AgentMessage) => {
        messages.push(m);
        if (m.type === "terminal_data") text += Buffer.from(m.data, "base64").toString("utf8");
      },
      messages,
      text: () => text,
    };
  };
  const waitFor = async (cond: () => boolean, ms = 8000) => {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error("délai dépassé");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("ouvre un shell, relaie l'entrée et la sortie, redimensionne et se termine avec son code de sortie", async () => {
    const manager = new TerminalManager(socket, async (p) => p === "console-projet");
    const out = collect();
    const sessionId = randomUUID();
    await manager.open({ type: "terminal_open", sessionId, containerId: containerId.slice(0, 12), cols: 100, rows: 30 }, out.emit);
    expect(manager.count).toBe(1);

    manager.input(sessionId, Buffer.from("echo bonjour-$((6*7))\n").toString("base64"));
    await waitFor(() => out.text().includes("bonjour-42"));

    manager.resize(sessionId, 120, 40);
    manager.input(sessionId, Buffer.from("stty size\n").toString("base64"));
    await waitFor(() => out.text().includes("40 120"));

    manager.input(sessionId, Buffer.from("exit 3\n").toString("base64"));
    await waitFor(() => out.messages.some((m) => m.type === "terminal_end"));
    const end = out.messages.find((m) => m.type === "terminal_end");
    expect(end).toMatchObject({ type: "terminal_end", sessionId, exitCode: 3 });
    expect(manager.count).toBe(0);
  });

  it("refuse un conteneur introuvable, arrêté ou protégé", async () => {
    const manager = new TerminalManager(socket, async (p) => p === "console-projet");
    for (const [id, expected] of [
      ["0".repeat(12), "introuvable"],
      [protectedId.slice(0, 12), "console ou son agent"],
    ] as const) {
      const out = collect();
      await manager.open({ type: "terminal_open", sessionId: randomUUID(), containerId: id, cols: 80, rows: 24 }, out.emit);
      expect(out.messages[0]).toMatchObject({ type: "terminal_end", reason: expect.stringContaining(expected) });
    }
    expect(manager.count).toBe(0);
  });

  it("ferme un terminal à la demande", async () => {
    const manager = new TerminalManager(socket, async () => false);
    const out = collect();
    const sessionId = randomUUID();
    await manager.open({ type: "terminal_open", sessionId, containerId: containerId.slice(0, 12), cols: 80, rows: 24 }, out.emit);
    manager.close(sessionId);
    await waitFor(() => out.messages.some((m) => m.type === "terminal_end"));
    expect(manager.count).toBe(0);
  });
});
