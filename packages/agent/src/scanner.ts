import {
  MAX_SCAN_VULNERABILITIES,
  SEVERITIES,
  type ScanMessage,
  type ScanResult,
  type Severity,
  type SeverityCounts,
  type Vulnerability,
} from "@infra/shared";
import { mkdir, readFile, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { dockerGet } from "./docker.js";
import { dockerEnv, runCommand } from "./exec.js";

export interface ScannerConfig {
  /** Espace de travail de l'agent, monté au même chemin sur l'hôte : le conteneur Trivy y lit l'archive de l'image. */
  workspaceDir: string;
  dockerSocket: string;
  /** Image de Trivy (version épinglée). */
  trivyImage: string;
  /** Volume nommé qui conserve la base de vulnérabilités entre les scans. */
  cacheVolume: string;
  /** Limite mémoire du conteneur Trivy (syntaxe Docker : 2g). */
  memory: string;
  /** Taille maximale d'image acceptée (octets). */
  maxImageBytes: number;
  /** Délai maximal d'un scan complet (téléchargements inclus). */
  timeoutMs: number;
}

const RANK: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };
const MAX_REPORT_BYTES = 200 * 1024 * 1024;

export function trivyProxyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const proxy: NodeJS.ProcessEnv = {};
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
    if (env[name] !== undefined) proxy[name] = env[name];
  }
  return proxy;
}

function proxyArgs(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(trivyProxyEnv(env)).flatMap((name) => ["-e", name]);
}

interface RawVuln {
  VulnerabilityID?: unknown;
  PkgName?: unknown;
  InstalledVersion?: unknown;
  FixedVersion?: unknown;
  Severity?: unknown;
  Title?: unknown;
  PrimaryURL?: unknown;
  Status?: unknown;
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * Normalise la sortie JSON de Trivy : compteurs exacts, liste détaillée bornée
 * et triée par gravité. La sortie brute n'est jamais transmise.
 */
export function normalizeReport(report: unknown): {
  os?: { family: string; name: string; eosl?: boolean };
  counts: SeverityCounts;
  total: number;
  vulnerabilities: Vulnerability[];
  truncated: boolean;
} {
  const r = (report ?? {}) as { Metadata?: { OS?: { Family?: unknown; Name?: unknown; EOSL?: unknown } }; Results?: { Class?: unknown; Vulnerabilities?: RawVuln[] | null }[] };
  const seen = new Set<string>();
  const all: Vulnerability[] = [];
  for (const res of r.Results ?? []) {
    const kind = res.Class === "os-pkgs" ? ("os" as const) : res.Class === "lang-pkgs" ? ("lang" as const) : undefined;
    for (const v of res.Vulnerabilities ?? []) {
      const id = text(v.VulnerabilityID, 80);
      if (!id) continue;
      const sev = (SEVERITIES as readonly string[]).includes(text(v.Severity, 20)) ? (text(v.Severity, 20) as Severity) : "UNKNOWN";
      const key = `${id}|${text(v.PkgName, 200)}|${text(v.InstalledVersion, 120)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        id,
        pkg: text(v.PkgName, 200),
        installed: text(v.InstalledVersion, 120),
        fixed: text(v.FixedVersion, 300) || null,
        severity: sev,
        title: text(v.Title, 300),
        url: text(v.PrimaryURL, 300) || null,
        ...(text(v.Status, 40) ? { status: text(v.Status, 40) } : {}),
        ...(kind ? { kind } : {}),
      });
    }
  }
  all.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.id.localeCompare(b.id) || a.pkg.localeCompare(b.pkg));
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const v of all) counts[v.severity.toLowerCase() as keyof SeverityCounts]++;
  const os = r.Metadata?.OS;
  return {
    ...(os?.Family ? { os: { family: text(os.Family, 40), name: text(os.Name, 80), ...(typeof os.EOSL === "boolean" ? { eosl: os.EOSL } : {}) } } : {}),
    counts,
    total: all.length,
    vulnerabilities: all.slice(0, MAX_SCAN_VULNERABILITIES),
    truncated: all.length > MAX_SCAN_VULNERABILITIES,
  };
}

/** Informations de version et de base de Trivy (`trivy version --format json`). */
export function parseTrivyVersion(raw: unknown): NonNullable<ScanResult["trivy"]> {
  const o = (raw ?? {}) as { Version?: unknown; VulnerabilityDB?: { Version?: unknown; UpdatedAt?: unknown; DownloadedAt?: unknown } };
  const db = o.VulnerabilityDB;
  return {
    version: text(o.Version, 40) || "inconnue",
    ...(typeof db?.Version === "number" ? { dbVersion: Math.trunc(db.Version) } : {}),
    ...(text(db?.UpdatedAt, 40) ? { dbUpdatedAt: text(db?.UpdatedAt, 40) } : {}),
    ...(text(db?.DownloadedAt, 40) ? { dbDownloadedAt: text(db?.DownloadedAt, 40) } : {}),
  };
}

/**
 * Arguments `docker run` du conteneur Trivy éphémère : sans socket Docker, sans capacités (sauf lecture du dossier
 * privé), système de fichiers en lecture seule, mémoire et processus bornés. Les fichiers temporaires volumineux sont
 * dirigés vers le dossier du scan (sur disque) et non vers /tmp (mémoire).
 */
export function trivyRunArgs(cfg: Pick<ScannerConfig, "trivyImage" | "cacheVolume" | "memory">, dir: string, container: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    "run", "--rm", "--name", container,
    // Seule capacité conservée : lire/écrire le dossier privé (0700) d'un agent qui n'est pas root.
    "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges",
    "--read-only", "--tmpfs", "/tmp:rw,size=512m",
    "-e", "TMPDIR=/scan/tmp",
    ...proxyArgs(env),
    "--memory", cfg.memory, "--pids-limit", "512",
    "-v", `${dir}:/scan`,
    "-v", `${cfg.cacheVolume}:/cache`,
    cfg.trivyImage,
  ];
}

/** Marge pour les fichiers temporaires de Trivy (base de vulnérabilités, base Java) en plus de l'archive de l'image. */
const SCAN_HEADROOM_BYTES = 2.5 * 1024 ** 3;

const gb = (n: number): string => (n / 1024 ** 3).toFixed(1).replace(".", ",");

/**
 * Refuse un scan avant de commencer s'il dépasse la taille maximale configurée, ou si la partition de l'espace de
 * travail n'a pas la place d'exporter l'image : l'échec est alors immédiat et explicite plutôt qu'un « no space left
 * on device » au milieu d'un scan.
 */
export function scanSizeError(imageBytes: number, maxBytes: number, freeBytes: number | null): string | null {
  if (imageBytes > maxBytes) {
    return `Image trop volumineuse pour être scannée (${gb(imageBytes)} Gio > ${gb(maxBytes)} Gio). Relevez la limite avec la variable TRIVY_MAX_IMAGE_GB de l'agent (par exemple 20).`;
  }
  const needed = imageBytes + SCAN_HEADROOM_BYTES;
  if (freeBytes !== null && freeBytes < needed) {
    return `Espace disque insuffisant pour scanner cette image : ${gb(freeBytes)} Gio libres dans le répertoire de travail de l'agent, ${gb(needed)} Gio nécessaires (archive de l'image + fichiers temporaires de Trivy).`;
  }
  return null;
}

/** Efface les chemins et jetons éventuels d'un message d'erreur avant de le remonter. */
const brief = (msg: string): string => {
  const flat = msg.replace(/\s+/g, " ").trim();
  // La cause se trouve à la fin de la sortie de Docker : on garde le début (contexte) et la fin.
  return flat.length <= 600 ? flat : `${flat.slice(0, 120)} … ${flat.slice(-470)}`;
};

/**
 * Scans Trivy d'images locales. Un scan à la fois par agent. L'image est
 * exportée avec `docker save` dans l'espace de travail puis lue par un
 * conteneur Trivy éphémère SANS accès au socket Docker, sans capacités,
 * avec système de fichiers en lecture seule et mémoire bornée ; seul le
 * volume de cache de la base de vulnérabilités persiste.
 */
export class TrivyScanner {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: ScannerConfig) {}

  scan(msg: ScanMessage): Promise<ScanResult> {
    const run = this.queue.then(() => this.scanNow(msg));
    this.queue = run.catch(() => {});
    return run;
  }

  private async docker(args: string[], timeoutMs: number): Promise<{ stdout: string; code: number | null; timedOut: boolean; tail: string }> {
    let tail = "";
    const res = await runCommand("docker", args, {
      env: { ...dockerEnv(this.cfg.dockerSocket), ...trivyProxyEnv() },
      timeoutMs,
      onOutput: (chunk) => {
        tail = (tail + chunk).slice(-1500);
      },
    });
    return { ...res, tail };
  }

  private async scanNow(msg: ScanMessage): Promise<ScanResult> {
    const fail = (error: string): ScanResult => ({ type: "scan_result", scanId: msg.scanId, status: "failed", error: brief(error) });
    const dir = join(this.cfg.workspaceDir, `.scan-${msg.scanId}`);
    const container = `console-docker-scan-${msg.scanId.slice(0, 8)}`;
    const deadline = Date.now() + this.cfg.timeoutMs;
    const left = (): number => Math.max(10_000, deadline - Date.now());
    try {
      // 1. L'image existe-t-elle ici, et est-elle d'une taille raisonnable ?
      let size = 0;
      try {
        size = Number(((await dockerGet(this.cfg.dockerSocket, `/images/${encodeURIComponent(msg.imageId)}/json`)) as { Size?: number }).Size ?? 0);
      } catch {
        return fail("Image introuvable sur cet hôte (supprimée depuis l'inventaire ?).");
      }
      // Espace libre sur la partition de l'espace de travail (où l'image est exportée) ; indéterminé = on laisse faire.
      let free: number | null = null;
      try {
        const fs = await statfs(this.cfg.workspaceDir);
        free = fs.bavail * fs.bsize;
      } catch {
        /* dossier pas encore créé ou système de fichiers sans statfs */
      }
      const tooBig = scanSizeError(size, this.cfg.maxImageBytes, free);
      if (tooBig) return fail(tooBig);

      // 2. Export de l'image dans un dossier temporaire privé.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const saved = await this.docker(["save", "--output", join(dir, "image.tar"), msg.imageId], left());
      if (saved.timedOut) return fail("Délai dépassé lors de l'export de l'image.");
      if (saved.code !== 0) return fail(`Export de l'image impossible : ${saved.tail}`);

      // 3a. Image de Trivy présente localement (téléchargement séparé : sa sortie ne pollue pas l'erreur du scan).
      const have = await this.docker(["image", "inspect", "--format", "{{.Id}}", this.cfg.trivyImage], 30_000);
      if (have.code !== 0) {
        const pulled = await this.docker(["pull", "--quiet", this.cfg.trivyImage], left());
        if (pulled.timedOut) return fail("Délai dépassé lors du téléchargement de l'image Trivy.");
        if (pulled.code !== 0) return fail(`Téléchargement de l'image Trivy impossible : ${pulled.tail}`);
      }

      // 3b. Scan par un conteneur Trivy éphémère et restreint.
      // Les gros fichiers temporaires (téléchargement de la base Java, plusieurs centaines de Mo) vont sur disque dans
      // le dossier du scan, supprimé ensuite : la mémoire de /tmp (tmpfs) est trop petite pour eux.
      await mkdir(join(dir, "tmp"), { recursive: true, mode: 0o700 });
      const scanned = await this.docker(
        [
          ...trivyRunArgs(this.cfg, dir, container), "image",
          "--input", "/scan/image.tar", "--format", "json", "--output", "/scan/result.json",
          "--scanners", "vuln", "--quiet", "--no-progress", "--cache-dir", "/cache",
          "--timeout", `${Math.max(1, Math.floor(left() / 60_000))}m`,
        ],
        left(),
      );
      if (scanned.timedOut) return fail("Délai dépassé pendant l'analyse Trivy.");
      if (scanned.code !== 0) {
        const full = /no space left on device/i.test(scanned.tail);
        return fail(`Trivy a échoué (code ${scanned.code})${full ? " — espace disque insuffisant sur l'hôte (répertoire de travail ou volume de cache de Trivy)" : ""} : ${scanned.tail}`);
      }

      // 4. Lecture du rapport (borné) et normalisation.
      const report = join(dir, "result.json");
      if ((await stat(report)).size > MAX_REPORT_BYTES) return fail("Rapport Trivy trop volumineux.");
      const normalized = normalizeReport(JSON.parse(await readFile(report, "utf8")));

      // 5. Version de Trivy et fraîcheur de la base (le cache vient d'être mis à jour par le scan).
      let trivy: ScanResult["trivy"];
      try {
        const v = await this.docker(["run", "--rm", "--cap-drop", "ALL", "--read-only", ...proxyArgs(process.env), "-v", `${this.cfg.cacheVolume}:/cache`, this.cfg.trivyImage, "version", "--format", "json", "--cache-dir", "/cache"], 60_000);
        if (v.code === 0) trivy = parseTrivyVersion(JSON.parse(v.stdout));
      } catch {
        /* informations de base indisponibles : le scan reste valable */
      }

      return {
        type: "scan_result",
        scanId: msg.scanId,
        status: "succeeded",
        ...(trivy ? { trivy } : {}),
        ...(normalized.os ? { os: normalized.os } : {}),
        counts: normalized.counts,
        total: normalized.total,
        vulnerabilities: normalized.vulnerabilities,
        truncated: normalized.truncated,
      };
    } catch (err) {
      return fail((err as Error).message);
    } finally {
      // Arrêt du conteneur s'il tourne encore (délai dépassé) puis nettoyage de l'archive.
      // Le nettoyage ne doit jamais faire perdre le résultat (une exception ici l'empêcherait d'être envoyé et
      // laisserait le scan « en cours » côté console, donc toute la file bloquée).
      try {
        await this.docker(["rm", "-f", container], 20_000);
      } catch {
        /* conteneur déjà parti */
      }
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* archive laissée sur place ; elle sera réutilisable ou supprimée à la main */
      }
    }
  }
}
