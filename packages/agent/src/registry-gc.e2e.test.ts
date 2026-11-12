import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerEnv, runCommand } from "./exec.js";
import { runRegistryGc } from "./registry-gc.js";

/**
 * Ramasse-miettes du registre géré, sur Docker réel : un vrai registre (étiqueté comme celui de la console), une image
 * publiée puis supprimée par digest, puis la libération réelle de l'espace. Désactivé par défaut (réseau, images) :
 *   PATCH_E2E=1 npx vitest run packages/agent/src/registry-gc.e2e.test.ts
 * `PATCH_E2E_GC_PORT` : port local du registre de test (15056 par défaut).
 */
const enabled = process.env.PATCH_E2E === "1";
const PORT = Number(process.env.PATCH_E2E_GC_PORT ?? 15056);
const NAME = `e2e-registry-gc-${randomUUID().slice(0, 8)}`;
const IMPOSTOR = `e2e-registry-impostor-${randomUUID().slice(0, 8)}`;
const LABELS = ["--label", "com.docker.compose.project=registry", "--label", "com.docker.compose.service=registry"];

describe.skipIf(!enabled)("ramasse-miettes du registre (Docker réel)", () => {
  const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
  const env = dockerEnv(socket);
  const docker = (args: string[], timeoutMs = 300_000) => runCommand("docker", args, { env, timeoutMs });
  const ref = `localhost:${PORT}/patched/gc-test:1`;

  beforeAll(async () => {
    for (const image of ["registry:3.0.0", "alpine:3.22.0"]) {
      const r = await docker(["pull", "--quiet", image]);
      if (r.code !== 0) throw new Error(`pull ${image} : ${r.stderr}`);
    }
  }, 600_000);
  afterAll(async () => {
    await docker(["rm", "-f", NAME, IMPOSTOR], 60_000);
    await docker(["rmi", ref], 60_000);
  });

  it("refuse un conteneur « registry » qui n'utilise pas l'image officielle, et l'absence de conteneur", async () => {
    const absent = await runRegistryGc({ requestId: randomUUID(), dryRun: true }, socket);
    expect(absent).toMatchObject({ status: "failed" });
    expect(absent.error).toContain("pas en cours d'exécution");

    const started = await docker(["run", "-d", "--name", IMPOSTOR, ...LABELS, "alpine:3.22.0", "sleep", "300"], 60_000);
    expect(started.code).toBe(0);
    const refused = await runRegistryGc({ requestId: randomUUID(), dryRun: false }, socket);
    expect(refused).toMatchObject({ status: "failed" });
    expect(refused.error).toContain("image officielle");
    await docker(["rm", "-f", IMPOSTOR], 60_000);
  }, 120_000);

  it("simule puis libère réellement l'espace d'une image supprimée par digest", async () => {
    const run = await docker(["run", "-d", "--name", NAME, ...LABELS, "-p", `127.0.0.1:${PORT}:5000`, "-e", "REGISTRY_STORAGE_DELETE_ENABLED=true", "registry:3.0.0"], 120_000);
    expect(run.code).toBe(0);
    await new Promise((r) => setTimeout(r, 3000));
    expect((await docker(["tag", "alpine:3.22.0", ref], 30_000)).code).toBe(0);
    const push = await docker(["push", ref], 300_000);
    expect(push.code).toBe(0);

    const head = await fetch(`http://localhost:${PORT}/v2/patched/gc-test/manifests/1`, {
      method: "HEAD",
      headers: { accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json" },
    });
    const digest = head.headers.get("docker-content-digest");
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await fetch(`http://localhost:${PORT}/v2/patched/gc-test/manifests/${digest}`, { method: "DELETE" })).status).toBe(202);

    // Simulation : rien n'est supprimé.
    const dry = await runRegistryGc({ requestId: randomUUID(), dryRun: true }, socket);
    expect(dry).toMatchObject({ status: "succeeded", dryRun: true });
    expect(dry.usedBeforeKb).toBeGreaterThan(1000);
    expect(dry.usedAfterKb).toBe(dry.usedBeforeKb);

    // Passage réel : l'espace est rendu.
    const real = await runRegistryGc({ requestId: randomUUID(), dryRun: false }, socket);
    expect(real).toMatchObject({ status: "succeeded", dryRun: false });
    expect(real.usedAfterKb ?? Number.POSITIVE_INFINITY).toBeLessThan((real.usedBeforeKb ?? 0) / 2);
    expect(real.output).toBeTruthy();
  }, 600_000);
});
