import { evaluateRemediation, type PatchMessage, type PatchResult } from "@infra/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_BUILDKIT_IMAGE, DEFAULT_BUILDKIT_PRIVILEGED_IMAGE } from "./config.js";
import { dockerGet } from "./docker.js";
import { dockerEnv, runCommand } from "./exec.js";
import { ImagePatcher } from "./patcher.js";

/**
 * Parcours complet sur Docker réel : copie dans un registre local, scan, correctif Copa + BuildKit rootless, rescan par
 * digest, vérification de la configuration. Désactivé par défaut (réseau, images, une à deux minutes) :
 *   PATCH_E2E=1 PATCHER_IMAGE=infrastructure-patcher:e2e npx vitest run packages/agent/src/patcher.e2e.test.ts
 * `PATCH_E2E_PRIVILEGED=1` : BuildKit privilégié (hôte sans espaces de noms utilisateur). `PATCH_E2E_PORT` : port local du registre de test (15055 par défaut). `PATCH_E2E_WORKSPACE` : dossier monté au même chemin dans le conteneur d'exécution et sur l'hôte Docker.
 * L'image de test `alpine:3.22.0` est volontairement ancienne : ne dépend d'aucune CVE précise, seulement qu'il y en ait.
 */
const enabled = process.env.PATCH_E2E === "1";
const SOURCE = "alpine:3.22.0";
const PORT = Number(process.env.PATCH_E2E_PORT ?? 15055);

describe.skipIf(!enabled)("correctif d'image (Docker réel)", () => {
  const socket = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
  const env = dockerEnv(socket);
  const patcherImage = process.env.PATCHER_IMAGE ?? "infrastructure-patcher:e2e";
  let workspace = "";
  // Repli privilégié (hôtes sans espaces de noms utilisateur) : PATCH_E2E_PRIVILEGED=1.
  const privileged = process.env.PATCH_E2E_PRIVILEGED === "1";

  const docker = (args: string[], timeoutMs = 300_000) => runCommand("docker", args, { env, timeoutMs });

  beforeAll(async () => {
    workspace = process.env.PATCH_E2E_WORKSPACE ?? (await mkdtemp(join(tmpdir(), "patch-e2e-")));
    for (const image of [SOURCE, "registry:3.0.0", privileged ? DEFAULT_BUILDKIT_PRIVILEGED_IMAGE : DEFAULT_BUILDKIT_IMAGE]) {
      const r = await docker(["pull", "--quiet", image]);
      if (r.code !== 0) throw new Error(`pull ${image} : ${r.stderr}`);
    }
  }, 600_000);
  afterAll(async () => {
    if (!process.env.PATCH_E2E_WORKSPACE) await rm(workspace, { recursive: true, force: true });
  });

  const newPatcher = (): ImagePatcher =>
    new ImagePatcher({
      workspaceDir: workspace,
      dockerSocket: socket,
      patcherImage,
      buildkitImage: DEFAULT_BUILDKIT_IMAGE,
      buildkitPrivileged: privileged,
      buildkitPrivilegedImage: DEFAULT_BUILDKIT_PRIVILEGED_IMAGE,
      trivyImage: "ghcr.io/aquasecurity/trivy:0.76.1",
      trivyCacheVolume: "console-docker-trivy-cache-e2e",
      buildkitMemory: "3g",
      trivyMemory: "2g",
      maxImageBytes: 2 * 1024 ** 3,
      // Le registre local partage l'espace réseau de BuildKit : « localhost:55000 » désigne le même registre pour
      // l'hôte (port publié), BuildKit, Copa et Trivy.
      buildkitExtraArgs: ["-p", `127.0.0.1:${PORT}:${PORT}`],
      afterBuildkit: async (bk) => {
        const name = `e2e-registry-${randomUUID().slice(0, 8)}`;
        const r = await docker(["run", "-d", "--name", name, "--network", `container:${bk}`, "-e", `REGISTRY_HTTP_ADDR=0.0.0.0:${PORT}`, "registry:3.0.0"], 60_000);
        if (r.code !== 0) throw new Error(`registre de test : ${r.stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return async () => void (await docker(["rm", "-f", name], 30_000));
      },
    });

  const message = (image: { Id: string; Os: string; Architecture: string }, patchedTag: string): PatchMessage => ({
    type: "patch",
    jobId: randomUUID(),
    imageId: image.Id,
    imageRef: SOURCE,
    platform: `${image.Os}/${image.Architecture}` as PatchMessage["platform"],
    target: { registry: `localhost:${PORT}`, repository: "patched/docker-io-library-alpine", sourceTag: "src-e2e", patchedTag },
    timeoutSec: 900,
  });

  it("corrige une image Alpine vulnérable, vérifie le résultat par digest et valide le verdict", async () => {
    const image = (await dockerGet(socket, `/images/${encodeURIComponent(SOURCE)}/json`)) as { Id: string; Os: string; Architecture: string };
    const stages: string[] = [];
    const patcher = newPatcher();
    const msg = message(image, "3.22.0-patch.1");

    const result: PatchResult = await patcher.patch(msg, (m) => {
      if (m.type === "patch_progress") stages.push(m.stage);
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(stages).toEqual(expect.arrayContaining(["preparing", "scanning_before", "patching", "scanning_after", "verifying"]));
    expect(result.patched?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.source?.digest).not.toBe(result.patched?.digest);
    expect(result.tools).toMatchObject({ copa: expect.stringMatching(/^\d+\.\d+\.\d+$/), buildkit: expect.stringMatching(/^v\d+/) });

    // L'image source n'a pas bougé et la configuration est préservée (hors libellé BaseImage).
    const after = (await dockerGet(socket, `/images/${encodeURIComponent(SOURCE)}/json`)) as { Id: string };
    expect(after.Id).toBe(image.Id);
    expect(result.configChanges).toEqual([]);
    expect(result.labelsAdded).toEqual(["BaseImage"]);

    // Le correctif a réellement modifié des paquets et résolu des vulnérabilités, sans en introduire de graves.
    expect(result.packageChanges?.length ?? 0).toBeGreaterThan(0);
    expect(result.before?.vulnerabilities.some((v) => v.fixed)).toBe(true);
    const bilan = evaluateRemediation({ before: result.before!, after: result.after!, configChanges: result.configChanges ?? [], labelsAdded: result.labelsAdded ?? [] });
    expect(bilan.cves.resolved).toBeGreaterThan(0);
    expect(bilan.cves.newHighOrCritical).toBe(0);
    expect(bilan.verdict).toBe("validated");
  }, 900_000);

  it("annule un correctif en cours : processus arrêté, conteneurs éphémères supprimés, aucun résultat de succès", async () => {
    const image = (await dockerGet(socket, `/images/${encodeURIComponent(SOURCE)}/json`)) as { Id: string; Os: string; Architecture: string };
    const patcher = newPatcher();
    const msg = message(image, "3.22.0-patch.cancelled");
    const stages: string[] = [];
    const result: PatchResult = await patcher.patch(msg, (m) => {
      if (m.type !== "patch_progress") return;
      stages.push(m.stage);
      // Annulation en plein scan : un processus Docker est en cours, BuildKit et le registre de test tournent.
      if (m.stage === "scanning_before") setTimeout(() => patcher.cancel(msg.jobId), 1500);
    });

    expect(result.status).toBe("cancelled");
    expect(result.patched).toBeUndefined();
    expect(stages).toContain("scanning_before");
    // Rien ne reste : ni BuildKit, ni Trivy, ni registre de test, ni dossier de travail du job.
    const left = await docker(["ps", "-a", "--filter", `name=${msg.jobId.slice(0, 8)}`, "--format", "{{.Names}}"], 30_000);
    expect(left.stdout.trim()).toBe("");
    // Annuler un correctif terminé ou inconnu est sans effet.
    expect(patcher.cancel(msg.jobId)).toBe(false);
  }, 900_000);

  it("annule un correctif encore en file d'attente sans rien démarrer", async () => {
    const image = (await dockerGet(socket, `/images/${encodeURIComponent(SOURCE)}/json`)) as { Id: string; Os: string; Architecture: string };
    const patcher = newPatcher();
    const msg = message(image, "3.22.0-patch.queued");
    const pending = patcher.patch(msg, () => undefined);
    // Annulé avant même que la file ne l'atteigne.
    expect(patcher.cancel(msg.jobId)).toBe(true);
    expect((await pending).status).toBe("cancelled");
  }, 60_000);
});
