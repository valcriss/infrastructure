import {
  MAX_PATCH_PACKAGES,
  type PatchMessage,
  type PatchPackageChange,
  type PatchProgress,
  type PatchResult,
  type PatchScan,
  type RegistryAuth,
} from "@infra/shared";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { authKey, prepareDockerAuth } from "./docker-auth.js";
import { dockerGet } from "./docker.js";
import { dockerEnv, runCommand } from "./exec.js";
import { normalizeReport, parseTrivyVersion, trivyProxyEnv } from "./scanner.js";

/**
 * Correctif d'une image locale (ADR 0002) : l'image source n'est jamais modifiée. Elle est copiée dans le registre cible,
 * scannée, corrigée par Copa pilotant un BuildKit rootless distinct (aucun socket Docker dans le runner), puis l'image
 * produite est de nouveau scannée PAR SON DIGEST, avec les mêmes options. Les arguments des conteneurs sont construits
 * ici à partir de champs validés par le protocole ; aucune option du moteur ne vient de la console.
 */

export interface PatcherConfig {
  workspaceDir: string;
  dockerSocket: string;
  /** Image du runner Copa (construite par la CI de ce dépôt). */
  patcherImage: string;
  /** Image officielle de BuildKit, variante rootless (version épinglée). */
  buildkitImage: string;
  /**
   * Repli explicite pour les hôtes qui interdisent les espaces de noms utilisateur (Ubuntu 24.04+ par défaut) : BuildKit
   * classique en mode privilégié, c'est-à-dire un accès équivalent à root sur l'hôte. Jamais activé automatiquement.
   */
  buildkitPrivileged?: boolean;
  buildkitPrivilegedImage?: string;
  trivyImage: string;
  trivyCacheVolume: string;
  /** Mémoire du conteneur BuildKit (syntaxe Docker : 2g). */
  buildkitMemory: string;
  trivyMemory: string;
  maxImageBytes: number;
  /**
   * Réservés aux tests : arguments ajoutés au conteneur BuildKit (ex. publication de port) et traitement exécuté
   * dès qu'il tourne (ex. registre local dans son espace réseau).
   */
  buildkitExtraArgs?: string[];
  afterBuildkit?: (container: string) => Promise<() => Promise<void>>;
}

type Emit = (message: PatchProgress | PatchResult) => void;

const BUILDKIT_PORT = 1234;
/** Plafond de taille du rapport Trivy complet lu par l'agent. */
const MAX_REPORT_BYTES = 200 * 1024 * 1024;

// --- Fonctions pures (testées sans Docker) --------------------------------------------------------------

/** `localhost` et les adresses de boucle parlent HTTP (comportement de Docker, Trivy et BuildKit) ; le reste HTTPS. */
export function registryScheme(registry: string): "http" | "https" {
  return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(registry) ? "http" : "https";
}

export const registryRef = (t: PatchMessage["target"], suffix: { tag: string } | { digest: string }): string =>
  "tag" in suffix ? `${t.registry}/${t.repository}:${suffix.tag}` : `${t.registry}/${t.repository}@${suffix.digest}`;

/** Digest annoncé par `docker push` ("<tag>: digest: sha256:… size: N"). */
export function parsePushDigest(output: string): string | null {
  const all = [...output.matchAll(/digest: (sha256:[0-9a-f]{64})/g)];
  return all.length > 0 ? (all[all.length - 1]?.[1] ?? null) : null;
}

/** Image de BuildKit effectivement utilisée (rootless par défaut). */
export const buildkitImageOf = (cfg: Pick<PatcherConfig, "buildkitImage" | "buildkitPrivileged" | "buildkitPrivilegedImage">): string =>
  cfg.buildkitPrivileged && cfg.buildkitPrivilegedImage ? cfg.buildkitPrivilegedImage : cfg.buildkitImage;

/**
 * Explication d'un échec de démarrage de BuildKit rootless quand l'hôte interdit les espaces de noms utilisateur non
 * privilégiés (AppArmor sur Ubuntu 23.10+, ou noyau sans la fonction) ; null pour toute autre cause.
 */
export function buildkitStartHint(logs: string): string | null {
  if (!/apparmor_restrict_unprivileged_userns|rootlesskit|user ?namespace/i.test(logs)) return null;
  return "BuildKit rootless ne peut pas démarrer : l'hôte interdit les espaces de noms utilisateur non privilégiés (Ubuntu 23.10 et plus récent, via AppArmor). Autorisez-les avec « sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 » (à rendre permanent dans /etc/sysctl.d), ou acceptez explicitement un BuildKit privilégié (équivalent à root sur l'hôte) avec BUILDKIT_PRIVILEGED=1 sur l'agent.";
}

export function buildkitRunArgs(cfg: Pick<PatcherConfig, "buildkitImage" | "buildkitPrivileged" | "buildkitPrivilegedImage" | "buildkitMemory" | "buildkitExtraArgs">, container: string): string[] {
  if (cfg.buildkitPrivileged) {
    return [
      "run", "-d", "--name", container, "--privileged",
      "--memory", cfg.buildkitMemory, "--pids-limit", "2048",
      ...(cfg.buildkitExtraArgs ?? []),
      buildkitImageOf(cfg),
      "--addr", `tcp://0.0.0.0:${BUILDKIT_PORT}`,
    ];
  }
  return [
    "run", "-d", "--name", container,
    // BuildKit rootless : pas de --privileged. seccomp/apparmor « unconfined » et l'absence de sandbox de processus sont
    // exigés par ses espaces de noms utilisateur ; le conteneur est éphémère, plafonné et seul dans son réseau.
    "--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined",
    "-e", "BUILDKITD_FLAGS=--oci-worker-no-process-sandbox",
    "--memory", cfg.buildkitMemory, "--pids-limit", "2048",
    ...(cfg.buildkitExtraArgs ?? []),
    buildkitImageOf(cfg),
    "--addr", `tcp://0.0.0.0:${BUILDKIT_PORT}`,
  ];
}

/** Arguments communs des conteneurs d'outils : réseau de BuildKit, sans capacités, système de fichiers en lecture seule. */
function toolArgs(name: string, bk: string, memory: string): string[] {
  return [
    "run", "--rm", "--name", name, "--network", `container:${bk}`,
    "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges",
    "--read-only", "--tmpfs", "/tmp:rw,size=512m", "--memory", memory, "--pids-limit", "512",
  ];
}

/**
 * Scan Trivy distant de l'image, par digest ou par tag. Les identifiants passent par l'environnement du processus
 * (`-e NOM` sans valeur) et non par la ligne de commande. Options identiques avant et après : pas de comparaison faussée.
 */
export function trivyRemoteArgs(cfg: Pick<PatcherConfig, "trivyImage" | "trivyCacheVolume" | "trivyMemory">, name: string, bk: string, dir: string, ref: string, output: string, withAuth: boolean): string[] {
  return [
    ...toolArgs(name, bk, cfg.trivyMemory),
    "-e", "TMPDIR=/work/tmp",
    ...(withAuth ? ["-e", "TRIVY_USERNAME", "-e", "TRIVY_PASSWORD"] : []),
    ...Object.keys(trivyProxyEnv()).flatMap((n) => ["-e", n]),
    "-v", `${dir}:/work`, "-v", `${cfg.trivyCacheVolume}:/cache`,
    cfg.trivyImage, "image",
    "--image-src", "remote", "--pkg-types", "os", "--scanners", "vuln", "--list-all-pkgs",
    "--format", "json", "--output", `/work/${output}`, "--quiet", "--no-progress", "--cache-dir", "/cache", ref,
  ];
}

/** Copa : rapport filtré en entrée, BuildKit joint en TCP, publication directe, document VEX en sortie. */
export function copaPatchArgs(cfg: Pick<PatcherConfig, "patcherImage" | "trivyMemory">, name: string, bk: string, dir: string, ref: string, patchedTag: string, timeoutSec: number): string[] {
  return [
    ...toolArgs(name, bk, cfg.trivyMemory),
    "-e", "DOCKER_CONFIG=/dockercfg", "-v", `${dir}/dockercfg:/dockercfg:ro`, "-v", `${dir}:/work`,
    cfg.patcherImage, "patch",
    "--image", ref, "--report", "/work/copa-report.json", "--tag", patchedTag,
    "--addr", `tcp://localhost:${BUILDKIT_PORT}`, "--push", "--progress", "plain",
    "--format", "openvex", "--output", "/work/vex.json",
    "--timeout", `${Math.max(1, Math.floor(timeoutSec))}s`,
  ];
}

interface RawTrivyReport {
  Results?: { Class?: string; Vulnerabilities?: { FixedVersion?: unknown }[] | null; Packages?: { Name?: unknown; Version?: unknown }[] | null }[];
  [k: string]: unknown;
}

/**
 * Copie du rapport complet sans les vulnérabilités sans correctif : c'est l'entrée de Copa (équivalent d'un scan
 * `--ignore-unfixed`), sans refaire un scan. Renvoie aussi le nombre de constats corrigeables.
 */
export function fixableReport(report: RawTrivyReport): { report: RawTrivyReport; fixable: number } {
  let fixable = 0;
  const results = (report.Results ?? []).map((r) => {
    const kept = (r.Vulnerabilities ?? []).filter((v) => typeof v.FixedVersion === "string" && v.FixedVersion !== "");
    fixable += kept.length;
    return { ...r, Vulnerabilities: kept };
  });
  return { report: { ...report, Results: results }, fixable };
}

/** Paquets du système (nom → version) d'un rapport Trivy produit avec `--list-all-pkgs`. */
export function osPackages(report: RawTrivyReport): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of report.Results ?? []) {
    if (r.Class !== "os-pkgs") continue;
    for (const p of r.Packages ?? []) {
      if (typeof p.Name === "string" && typeof p.Version === "string") out.set(p.Name.slice(0, 200), p.Version.slice(0, 120));
    }
  }
  return out;
}

/** Paquets dont la version a changé (les paquets ajoutés ou retirés sont aussi signalés, avec "-" pour l'absence). */
export function packageChanges(before: Map<string, string>, after: Map<string, string>): { changes: PatchPackageChange[]; truncated: boolean } {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: PatchPackageChange[] = [];
  for (const name of names) {
    const from = before.get(name) ?? "-";
    const to = after.get(name) ?? "-";
    if (from !== to) changes.push({ name, from, to });
  }
  return { changes: changes.slice(0, MAX_PATCH_PACKAGES), truncated: changes.length > MAX_PATCH_PACKAGES };
}

export interface ImageConfig {
  Entrypoint?: string[] | null;
  Cmd?: string[] | null;
  User?: string;
  WorkingDir?: string;
  Env?: string[] | null;
  ExposedPorts?: Record<string, unknown> | null;
  Volumes?: Record<string, unknown> | null;
  Healthcheck?: unknown;
  StopSignal?: string;
  Shell?: string[] | null;
  OnBuild?: string[] | null;
  Labels?: Record<string, string> | null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const norm = (v: string[] | null | undefined): string[] | null => (v && v.length > 0 ? v : null);
const keys = (o: Record<string, unknown> | null | undefined): string[] => Object.keys(o ?? {}).sort();

/**
 * Compare les configurations source et corrigée. Rend les NOMS des champs modifiés (jamais leurs valeurs : les
 * variables d'environnement peuvent contenir des secrets) et les libellés ajoutés. Un libellé existant modifié ou
 * retiré compte comme un changement de configuration.
 */
export function configDiff(source: ImageConfig, patched: ImageConfig): { configChanges: string[]; labelsAdded: string[] } {
  const changes: string[] = [];
  if (!same(norm(source.Entrypoint), norm(patched.Entrypoint))) changes.push("Entrypoint");
  if (!same(norm(source.Cmd), norm(patched.Cmd))) changes.push("Cmd");
  if ((source.User ?? "") !== (patched.User ?? "")) changes.push("User");
  if ((source.WorkingDir ?? "") !== (patched.WorkingDir ?? "")) changes.push("WorkingDir");
  if (!same([...(source.Env ?? [])].sort(), [...(patched.Env ?? [])].sort())) changes.push("Env");
  if (!same(keys(source.ExposedPorts), keys(patched.ExposedPorts))) changes.push("ExposedPorts");
  if (!same(keys(source.Volumes), keys(patched.Volumes))) changes.push("Volumes");
  if (!same(source.Healthcheck, patched.Healthcheck)) changes.push("Healthcheck");
  if ((source.StopSignal ?? "") !== (patched.StopSignal ?? "")) changes.push("StopSignal");
  if (!same(norm(source.Shell), norm(patched.Shell))) changes.push("Shell");
  if (!same(norm(source.OnBuild), norm(patched.OnBuild))) changes.push("OnBuild");
  const s = source.Labels ?? {};
  const p = patched.Labels ?? {};
  if (Object.entries(s).some(([k, v]) => p[k] !== v)) changes.push("Labels");
  return { configChanges: changes, labelsAdded: Object.keys(p).filter((k) => !(k in s)).sort().slice(0, 30) };
}

const brief = (msg: string): string => {
  const flat = msg.replace(/\s+/g, " ").trim();
  return flat.length <= 700 ? flat : `${flat.slice(0, 150)} … ${flat.slice(-540)}`;
};

class PatchError extends Error {}

// --- Exécution ----------------------------------------------------------------------------------------

/** Un correctif à la fois par agent. */
export class ImagePatcher {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: PatcherConfig) {}

  patch(msg: PatchMessage, emit: Emit): Promise<PatchResult> {
    const run = this.queue.then(() => this.patchNow(msg, emit));
    this.queue = run.catch(() => {});
    return run;
  }

  private async patchNow(msg: PatchMessage, emit: Emit): Promise<PatchResult> {
    const { cfg } = this;
    const id8 = msg.jobId.slice(0, 8);
    const dir = join(cfg.workspaceDir, `.patch-${msg.jobId}`);
    const bk = `console-docker-bk-${id8}`;
    const deadline = Date.now() + msg.timeoutSec * 1000;
    const left = (): number => Math.max(10_000, deadline - Date.now());
    const progress = (stage: PatchProgress["stage"], message?: string): void => emit({ type: "patch_progress", jobId: msg.jobId, stage, ...(message ? { message } : {}) });

    const auth = await prepareDockerAuth(dockerEnv(cfg.dockerSocket), msg.registryAuths);
    const secrets = auth.secrets;
    const mask = (s: string): string => secrets.reduce((acc, x) => (x ? acc.split(x).join("***") : acc), s);
    const fail = (error: string): PatchResult => ({ type: "patch_result", jobId: msg.jobId, status: "failed", error: brief(mask(error)) });
    const tags: string[] = [];
    let stopSidecar: (() => Promise<void>) | undefined;

    const docker = async (args: string[], timeoutMs: number, env: NodeJS.ProcessEnv = auth.env): Promise<{ stdout: string; code: number | null; timedOut: boolean; tail: string }> => {
      let tail = "";
      const res = await runCommand("docker", args, { env, timeoutMs, onOutput: (c) => (tail = (tail + c).slice(-2000)) });
      return { ...res, tail: mask(tail) };
    };

    const target = msg.target;
    const sourceRef = registryRef(target, { tag: target.sourceTag });
    const registryAuth: RegistryAuth | undefined = msg.registryAuths?.find((a) => a.registry === target.registry);
    // Environnement des conteneurs Trivy : identifiants du registre cible, jamais sur la ligne de commande.
    const trivyEnv: NodeJS.ProcessEnv = { ...dockerEnv(cfg.dockerSocket), ...trivyProxyEnv(), ...(registryAuth ? { TRIVY_USERNAME: registryAuth.username, TRIVY_PASSWORD: registryAuth.password } : {}) };

    try {
      progress("preparing", "Vérification de l'image locale");
      // 1. L'image existe ici et correspond bien à l'identité demandée (plateforme, taille).
      let inspect: { Id?: string; Size?: number; Os?: string; Architecture?: string; Config?: ImageConfig };
      try {
        inspect = (await dockerGet(cfg.dockerSocket, `/images/${encodeURIComponent(msg.imageId)}/json`)) as typeof inspect;
      } catch {
        return fail("Image introuvable sur cet hôte (supprimée depuis l'inventaire ?).");
      }
      const platform = `${inspect.Os ?? "?"}/${inspect.Architecture ?? "?"}`;
      if (platform !== msg.platform) return fail(`Plateforme de l'image (${platform}) différente de celle demandée (${msg.platform}).`);
      if ((inspect.Size ?? 0) > cfg.maxImageBytes) return fail("Image trop volumineuse pour être corrigée (limite TRIVY_MAX_IMAGE_GB de l'agent).");

      await mkdir(join(dir, "tmp"), { recursive: true, mode: 0o700 });
      await mkdir(join(dir, "dockercfg"), { recursive: true, mode: 0o700 });
      // Configuration d'authentification montée dans le runner (le dossier de travail est le seul chemin partagé avec l'hôte).
      if (msg.registryAuths?.length) {
        const entries: Record<string, { auth: string }> = {};
        for (const a of msg.registryAuths) entries[authKey(a.registry)] = { auth: Buffer.from(`${a.username}:${a.password}`).toString("base64") };
        await writeFile(join(dir, "dockercfg", "config.json"), JSON.stringify({ auths: entries }), { mode: 0o600 });
      }

      // 2. Images des outils, puis BuildKit éphémère (il porte l'espace réseau des autres conteneurs).
      for (const image of [cfg.patcherImage, buildkitImageOf(cfg), cfg.trivyImage]) {
        if ((await docker(["image", "inspect", "--format", "{{.Id}}", image], 30_000, dockerEnv(cfg.dockerSocket))).code !== 0) {
          const pulled = await docker(["pull", "--quiet", image], left(), dockerEnv(cfg.dockerSocket));
          if (pulled.code !== 0) return fail(`Téléchargement de l'image ${image} impossible : ${pulled.tail}`);
        }
      }
      const started = await docker(buildkitRunArgs(cfg, bk), 60_000, dockerEnv(cfg.dockerSocket));
      if (started.code !== 0) return fail(`BuildKit n'a pas démarré : ${started.tail}`);
      const ready = Date.now() + 60_000;
      for (;;) {
        const logs = await docker(["logs", bk], 15_000, dockerEnv(cfg.dockerSocket));
        if (/running server/.test(logs.tail)) break;
        if (Date.now() > ready) return fail(buildkitStartHint(logs.tail) ?? `BuildKit n'est pas prêt : ${logs.tail}`);
        // Un arrêt immédiat (espaces de noms interdits, etc.) ne se rattrape pas en attendant.
        const state = await docker(["inspect", "--format", "{{.State.Running}}", bk], 15_000, dockerEnv(cfg.dockerSocket));
        if (state.stdout.trim() === "false") return fail(buildkitStartHint(logs.tail) ?? `BuildKit s'est arrêté au démarrage : ${logs.tail}`);
        await new Promise((r) => setTimeout(r, 500));
      }
      if (cfg.afterBuildkit) stopSidecar = await cfg.afterBuildkit(bk);

      // 3. Copie de l'image source dans le registre cible (la source locale reste intacte).
      progress("preparing", "Copie de l'image dans le registre");
      tags.push(sourceRef);
      const tagged = await docker(["tag", msg.imageId, sourceRef], 30_000, dockerEnv(cfg.dockerSocket));
      if (tagged.code !== 0) return fail(`Marquage de l'image impossible : ${tagged.tail}`);
      const pushed = await docker(["push", sourceRef], left());
      if (pushed.timedOut) return fail("Délai dépassé lors de la copie de l'image dans le registre.");
      if (pushed.code !== 0) return fail(`Copie de l'image dans le registre impossible : ${pushed.tail}`);
      const sourceDigest = parsePushDigest(pushed.tail);
      if (!sourceDigest) return fail("Digest de la copie introuvable dans la sortie de Docker.");
      const sourceByDigest = registryRef(target, { digest: sourceDigest });

      // 4. Scan de référence de la copie, par digest.
      const trivyCount = { n: 0 };
      const scan = async (ref: string, output: string): Promise<{ raw: RawTrivyReport; normalized: PatchScan }> => {
        const name = `console-docker-patch-trivy-${id8}-${trivyCount.n++}`;
        const res = await docker(trivyRemoteArgs(cfg, name, bk, dir, ref, output, Boolean(registryAuth)), left(), trivyEnv);
        await docker(["rm", "-f", name], 20_000, dockerEnv(cfg.dockerSocket)).catch(() => undefined);
        if (res.timedOut) throw new PatchError("Délai dépassé pendant le scan Trivy.");
        if (res.code !== 0) throw new PatchError(`Le scan Trivy a échoué (code ${res.code}) : ${res.tail}`);
        const file = join(dir, output);
        if ((await stat(file)).size > MAX_REPORT_BYTES) throw new PatchError("Rapport Trivy trop volumineux.");
        const raw = JSON.parse(await readFile(file, "utf8")) as RawTrivyReport;
        const n = normalizeReport(raw);
        return { raw, normalized: { ...(n.os ? { os: n.os } : {}), counts: n.counts, total: n.total, vulnerabilities: n.vulnerabilities.map(({ id, pkg, installed, fixed, severity, kind }) => ({ id, pkg, installed, fixed, severity, ...(kind ? { kind } : {}) })), truncated: n.truncated } };
      };
      progress("scanning_before", "Scan de l'image avant correctif");
      const before = await scan(sourceByDigest, "before.json");
      const { report: copaReport, fixable } = fixableReport(before.raw);
      if (fixable === 0) return fail("Aucune vulnérabilité corrigeable dans les paquets du système : rien à corriger.");
      await writeFile(join(dir, "copa-report.json"), JSON.stringify(copaReport), { mode: 0o600 });

      // 5. Correctif : Copa pilote BuildKit et publie l'image corrigée sous son tag immuable.
      progress("patching", `${fixable} constats corrigeables`);
      // L'entrée de Copa est désignée par son tag : on vérifie qu'il pointe bien sur le contenu qui vient d'être scanné.
      if ((await this.manifestDigest(target, registryAuth, target.sourceTag)) !== sourceDigest) return fail("Le tag de la copie ne correspond plus au contenu scanné : relancez le correctif.");
      const existing = await this.manifestDigest(target, registryAuth, target.patchedTag);
      if (existing) return fail(`Le tag ${target.patchedTag} existe déjà dans le registre : un tag de correctif est immuable.`);
      const copaName = `console-docker-patch-copa-${id8}`;
      const patched = await docker(copaPatchArgs(cfg, copaName, bk, dir, sourceByDigest.replace(/@.*$/, `:${target.sourceTag}`), target.patchedTag, msg.timeoutSec), left());
      await docker(["rm", "-f", copaName], 20_000, dockerEnv(cfg.dockerSocket)).catch(() => undefined);
      if (patched.timedOut) return fail("Délai dépassé pendant le correctif.");
      if (patched.code !== 0) return fail(`Le moteur de correctifs a échoué (code ${patched.code}) : ${patched.tail}`);
      const patchedDigest = await this.manifestDigest(target, registryAuth, target.patchedTag);
      if (!patchedDigest) return fail("L'image corrigée est introuvable dans le registre après le correctif.");
      const patchedByDigest = registryRef(target, { digest: patchedDigest });

      // 6. Nouveau scan de l'image produite, lue par son digest dans le registre, avec les mêmes options.
      progress("scanning_after", "Scan de l'image corrigée");
      const after = await scan(patchedByDigest, "after.json");

      // 7. Vérifications : configuration inchangée, paquets modifiés, pull réel de l'image corrigée sur l'hôte.
      progress("verifying", "Comparaison de la configuration");
      tags.push(patchedByDigest);
      const pulled = await docker(["pull", "--quiet", patchedByDigest], left());
      if (pulled.code !== 0) return fail(`L'image corrigée ne peut pas être téléchargée depuis le registre : ${pulled.tail}`);
      const patchedInspect = (await dockerGet(cfg.dockerSocket, `/images/${encodeURIComponent(patchedByDigest)}/json`)) as { Config?: ImageConfig };
      const diff = configDiff(inspect.Config ?? {}, patchedInspect.Config ?? {});
      const pkgs = packageChanges(osPackages(before.raw), osPackages(after.raw));
      let vexStatements = 0;
      try {
        vexStatements = ((JSON.parse(await readFile(join(dir, "vex.json"), "utf8")) as { statements?: unknown[] }).statements ?? []).length;
      } catch {
        /* document VEX absent : sans conséquence pour le verdict */
      }

      return {
        type: "patch_result",
        jobId: msg.jobId,
        status: "succeeded",
        tools: await this.toolVersions(bk, docker),
        source: { ref: sourceRef, digest: sourceDigest },
        patched: { ref: registryRef(target, { tag: target.patchedTag }), digest: patchedDigest },
        before: before.normalized,
        after: after.normalized,
        packageChanges: pkgs.changes,
        configChanges: diff.configChanges,
        labelsAdded: diff.labelsAdded,
        vexStatements,
      };
    } catch (err) {
      return fail(err instanceof PatchError ? err.message : `Erreur inattendue de l'agent : ${(err as Error).message}`);
    } finally {
      // Le nettoyage ne doit jamais faire perdre le résultat.
      const quiet = dockerEnv(cfg.dockerSocket);
      for (const name of [`console-docker-patch-copa-${id8}`, ...Array.from({ length: 3 }, (_, i) => `console-docker-patch-trivy-${id8}-${i}`), bk]) {
        await docker(["rm", "-f", name], 20_000, quiet).catch(() => undefined);
      }
      try {
        await stopSidecar?.();
      } catch {
        /* sans conséquence */
      }
      for (const t of tags) await docker(["rmi", t], 30_000, quiet).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await auth.cleanup().catch(() => undefined);
    }
  }

  /** Digest d'un tag du registre cible (HEAD sur le manifeste), ou null s'il n'existe pas. */
  private async manifestDigest(target: PatchMessage["target"], auth: RegistryAuth | undefined, tag: string): Promise<string | null> {
    const url = `${registryScheme(target.registry)}://${target.registry}/v2/${target.repository}/manifests/${tag}`;
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json",
        ...(auth ? { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` } : {}),
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new PatchError(`Le registre répond ${res.status} pour ${tag}.`);
    const digest = res.headers.get("docker-content-digest") ?? "";
    return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
  }

  private async toolVersions(bk: string, docker: (args: string[], t: number, env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; code: number | null; tail: string }>): Promise<NonNullable<PatchResult["tools"]>> {
    const env = dockerEnv(this.cfg.dockerSocket);
    const copa = await docker(["run", "--rm", "--entrypoint", "/usr/local/bin/copa", this.cfg.patcherImage, "--version"], 30_000, env);
    const buildkit = await docker(["exec", bk, "buildkitd", "--version"], 30_000, env);
    const trivy = await docker(["run", "--rm", "--cap-drop", "ALL", "--read-only", "-v", `${this.cfg.trivyCacheVolume}:/cache`, this.cfg.trivyImage, "version", "--format", "json", "--cache-dir", "/cache"], 60_000, env);
    let trivyVersion = "inconnue";
    try {
      trivyVersion = parseTrivyVersion(JSON.parse(trivy.stdout)).version;
    } catch {
      /* version indisponible */
    }
    return {
      copa: (/(\d+\.\d+\.\d+)/.exec(copa.stdout)?.[1] ?? "inconnue").slice(0, 60),
      buildkit: (/(v\d+\.\d+\.\d+)/.exec(buildkit.stdout)?.[1] ?? "inconnue").slice(0, 60),
      trivy: trivyVersion.slice(0, 60),
    };
  }
}
