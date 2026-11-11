import { MAX_STORAGE_BINDS, MAX_STORAGE_VOLUMES, type StorageUsageMessage } from "@infra/shared";
import { dockerGet } from "./docker.js";
import { dockerEnv, runCommand } from "./exec.js";

/** Chemins jamais parcourus : systèmes de fichiers virtuels, sockets, données du moteur Docker (immenses, sans intérêt ici). */
const SKIPPED = ["/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib/docker"];
const PER_PATH_TIMEOUT_MS = 5 * 60_000;

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});

/** Raison de ne pas mesurer ce chemin, ou null s'il peut l'être. */
export function skipReason(path: string): string | null {
  const p = path.replace(/\/+$/, "") || "/";
  if (!p.startsWith("/")) return "chemin non absolu";
  if (p === "/") return "racine de l'hôte : non mesurée";
  if (p.split("/").includes("..")) return "chemin non valide";
  if (SKIPPED.some((s) => p === s || p.startsWith(`${s}/`))) return "emplacement système : non mesuré";
  return null;
}

/** Arguments `docker run` du conteneur de mesure : sans réseau, système de fichiers en lecture seule, montage en lecture seule. */
export function measureArgs(image: string, path: string): string[] {
  return [
    "run", "--rm",
    // Seule capacité conservée : lire les dossiers d'autres utilisateurs (par exemple une base de données en 0700).
    "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH", "--security-opt", "no-new-privileges",
    "--network", "none", "--read-only", "--memory", "64m", "--pids-limit", "32",
    "--entrypoint", "du",
    "-v", `${path}:/m:ro`,
    image, "-sk", "/m",
  ];
}

/** Extrait la taille (en octets) de la sortie de `du -sk` ; null si illisible. */
export function parseDu(stdout: string): number | null {
  const kib = Number(/^\s*(\d+)/.exec(stdout)?.[1]);
  return Number.isFinite(kib) ? kib * 1024 : null;
}

export interface StorageDeps {
  socket: string;
  /** Conteneur de l'agent : son image sert de conteneur de mesure (elle contient `du` et est déjà présente). */
  selfContainer: string | undefined;
  /** Image de secours (Trivy) si celle de l'agent est introuvable. */
  fallbackImage: string;
}

/**
 * Taille sur le disque des montages demandés. Volumes : `/system/df` (une requête, plutôt lente sur un hôte chargé).
 * Binds : `du` dans un conteneur éphémère, un chemin à la fois, uniquement pour les sources de montages « bind »
 * des conteneurs existants (la console ne peut pas faire parcourir un dossier quelconque).
 */
export class StorageMeter {
  private busy = false;

  constructor(private readonly deps: StorageDeps) {}

  private async image(): Promise<string> {
    if (this.deps.selfContainer) {
      try {
        const id = obj(await dockerGet(this.deps.socket, `/containers/${encodeURIComponent(this.deps.selfContainer)}/json`)).Image;
        if (typeof id === "string" && id) return id;
      } catch {
        /* conteneur introuvable : image de secours */
      }
    }
    return this.deps.fallbackImage;
  }

  /** Sources des montages « bind » de tous les conteneurs de l'hôte. */
  private async knownBinds(): Promise<Set<string>> {
    const list = await dockerGet(this.deps.socket, "/containers/json?all=1");
    const out = new Set<string>();
    for (const c of Array.isArray(list) ? (list as Raw[]) : []) {
      for (const m of Array.isArray(c.Mounts) ? (c.Mounts as Raw[]) : []) {
        if (m.Type === "bind" && typeof m.Source === "string") out.add(m.Source);
      }
    }
    return out;
  }

  private async volumeSizes(names: string[]): Promise<StorageUsageMessage["volumes"]> {
    if (names.length === 0) return [];
    const sizes = new Map<string, number>();
    try {
      const df = obj(await dockerGet(this.deps.socket, "/system/df?type=volume", 120_000));
      const items = Array.isArray(df.Volumes) ? (df.Volumes as Raw[]) : Array.isArray(obj(df.VolumeUsage).Items) ? (obj(df.VolumeUsage).Items as Raw[]) : [];
      for (const v of items) {
        const size = obj(v.UsageData).Size;
        if (typeof v.Name === "string" && typeof size === "number" && size >= 0) sizes.set(v.Name, size);
      }
    } catch {
      /* relevé indisponible : tailles inconnues */
    }
    return names.slice(0, MAX_STORAGE_VOLUMES).map((name) => ({ name, sizeBytes: sizes.get(name) ?? null }));
  }

  private async bindSize(image: string, path: string): Promise<{ sizeBytes: number | null; note?: string }> {
    const skip = skipReason(path);
    if (skip) return { sizeBytes: null, note: skip };
    try {
      const res = await runCommand("docker", measureArgs(image, path), { env: dockerEnv(this.deps.socket), timeoutMs: PER_PATH_TIMEOUT_MS, maxStdoutBytes: 4096 });
      if (res.timedOut) return { sizeBytes: null, note: "mesure trop longue (délai dépassé)" };
      const size = parseDu(res.stdout);
      // `du` rend la main avec une erreur sur un fichier illisible mais a souvent compté le reste : on garde la taille si elle existe.
      if (size !== null) return { sizeBytes: size };
      return { sizeBytes: null, note: res.stderr.trim().split("\n").pop()?.slice(0, 150) || "mesure impossible" };
    } catch {
      return { sizeBytes: null, note: "mesure impossible" };
    }
  }

  /** Une mesure à la fois : un relevé en cours ferait double emploi et chargerait inutilement les disques. */
  async measure(requestId: string, volumes: string[], binds: string[]): Promise<StorageUsageMessage | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const known = await this.knownBinds();
      const image = binds.length > 0 ? await this.image() : "";
      const out: StorageUsageMessage["binds"] = [];
      for (const path of binds.slice(0, MAX_STORAGE_BINDS)) {
        if (!known.has(path)) out.push({ path, sizeBytes: null, note: "ce chemin n'est plus utilisé par un conteneur" });
        else out.push({ path, ...(await this.bindSize(image, path)) });
      }
      return { type: "storage_usage", requestId, observedAt: new Date().toISOString(), volumes: await this.volumeSizes(volumes), binds: out };
    } finally {
      this.busy = false;
    }
  }
}
