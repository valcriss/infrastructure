import type { VerifyCheck } from "@infra/shared";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerEnv, runCommand } from "./exec.js";
import { runVerify, type VerifyExec } from "./verify.js";

/**
 * Vérification de démarrage sur Docker réel : l'isolation est contrôlée par ce que le conteneur peut réellement faire.
 * Désactivé par défaut : PATCH_E2E=1 npx vitest run packages/agent/src/verify.e2e.test.ts (PATCH_E2E_NATIVE_DOCKER=1 sous Windows)
 */
const enabled = process.env.PATCH_E2E === "1";
const IMAGE = "alpine:3.22.0";

describe.skipIf(!enabled)("vérification de démarrage (Docker réel)", () => {
  const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
  // PATCH_E2E_NATIVE_DOCKER=1 : CLI Docker de l'environnement (Docker Desktop sous Windows) au lieu d'un socket Unix.
  const env = process.env.PATCH_E2E_NATIVE_DOCKER === "1" ? { ...process.env } : dockerEnv(socket);
  const exec: VerifyExec = async (args, timeoutMs) => {
    const r = await runCommand("docker", args, { env, timeoutMs });
    return { code: r.code, timedOut: r.timedOut, stdout: r.stdout, tail: r.stderr };
  };
  const ids: string[] = [];
  const run = (command: string[], over: Partial<VerifyCheck> = {}, timeoutMs?: number) => {
    const name = `e2e-verify-${randomUUID().slice(0, 8)}`;
    ids.push(name);
    return runVerify(exec, name, IMAGE, { command, expectExit: 0, outputContains: null, ...over }, timeoutMs);
  };

  beforeAll(async () => {
    const r = await runCommand("docker", ["pull", "--quiet", IMAGE], { env, timeoutMs: 300_000 });
    if (r.code !== 0) throw new Error(`pull ${IMAGE} : ${r.stderr}`);
  }, 600_000);
  afterAll(async () => {
    await runCommand("docker", ["rm", "-f", ...ids], { env, timeoutMs: 60_000 });
  });

  it("réussit sur le code et le texte attendus, échoue sinon", async () => {
    expect(await run(["echo", "bonjour"], { outputContains: "bonjour" })).toEqual({ ok: true, exitCode: 0, timedOut: false, outputMatched: true });
    expect(await run(["echo", "bonjour"], { outputContains: "absent" })).toMatchObject({ ok: false, exitCode: 0, outputMatched: false });
    expect(await run(["sh", "-c", "exit 3"], { expectExit: 3 })).toMatchObject({ ok: true, exitCode: 3 });
    expect(await run(["sh", "-c", "exit 3"])).toMatchObject({ ok: false, exitCode: 3 });
    // Commande introuvable : jamais confondue avec une réussite.
    expect((await run(["commande-inexistante"])).ok).toBe(false);
  }, 120_000);

  it("est réellement isolée : pas de réseau, pas d'écriture, pas d'environnement hérité", async () => {
    // Aucun réseau (seul « lo » existe) : une connexion sortante échoue.
    expect((await run(["wget", "-q", "-T", "3", "-O", "-", "http://1.1.1.1/"])).ok).toBe(false);
    expect(await run(["sh", "-c", "ls /sys/class/net | grep -vx lo | wc -l"], { outputContains: "0" })).toMatchObject({ ok: true });
    // Système de fichiers en lecture seule, sauf /tmp.
    expect((await run(["touch", "/ecriture-interdite"])).ok).toBe(false);
    expect((await run(["sh", "-c", "touch /tmp/ok"])).ok).toBe(true);
    // Toutes les capacités retirées : changer de propriétaire est refusé.
    expect((await run(["sh", "-c", "chown 1234 /tmp"])).ok).toBe(false);
    // Aucune variable de l'application ni de l'hôte.
    expect((await run(["sh", "-c", "env | grep -c -E 'DATABASE_URL|PASSWORD|TOKEN'"], { expectExit: 1 })).ok).toBe(true);
  }, 120_000);

  it("tue une commande trop longue et supprime le conteneur", async () => {
    const started = Date.now();
    const r = await run(["sleep", "60"], {}, 3000);
    expect(r).toMatchObject({ ok: false, timedOut: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(30_000);
    const left = await runCommand("docker", ["ps", "-a", "--filter", "name=e2e-verify-", "--format", "{{.Names}} {{.Status}}"], { env, timeoutMs: 30_000 });
    expect(left.stdout).not.toMatch(/Up /);
  }, 120_000);
});
