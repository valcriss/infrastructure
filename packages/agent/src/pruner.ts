import type { DiskUsageMessage, PruneMessage, PrunePhase, PruneProgress, PruneResult } from "@infra/shared";
import { dockerGet, dockerRequest, type DockerResponse } from "./docker.js";

const MAX_NOTES = 100;
/** Intervalle minimal entre deux messages d'avancement (hors changements de phase et fin). */
const PROGRESS_INTERVAL_MS = 400;
/** La suppression du cache de build est un seul appel Docker, parfois très long (des centaines de Go) : 1 h au plus. */
const BUILD_PRUNE_TIMEOUT_MS = 60 * 60_000;

export interface PrunerDeps {
  socket: string;
  /** Candidats actuels (déjà épurés des éléments protégés) : l'agent ne supprime que ce qui l'est encore. */
  collect: () => Promise<DiskUsageMessage>;
  /** Remplaçables dans les tests. */
  request?: (method: "DELETE" | "POST", path: string, timeoutMs?: number) => Promise<DockerResponse>;
  get?: (path: string) => Promise<unknown>;
  now?: () => number;
}

const message = (r: DockerResponse): string => {
  const m = (r.body as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m.replace(/\s+/g, " ").slice(0, 200) : `HTTP ${r.status}`;
};

const sameId = (candidate: string, wanted: string): boolean => {
  const a = candidate.replace("sha256:", "");
  const b = wanted.replace("sha256:", "");
  return a === b || a.startsWith(b) || b.startsWith(a);
};

/**
 * Supprime les éléments désignés par la console, sans jamais forcer : Docker refuse ce qui est utilisé (conteneur en
 * marche, image d'un conteneur, volume ou réseau en service). L'agent ne supprime que ce qui est encore candidat au moment
 * de l'exécution (inutilisé et non protégé) ; le reste est signalé comme « ignoré ». Les volumes d'un conteneur supprimé
 * ne sont jamais supprimés avec lui : ils ne partent que s'ils sont eux-mêmes désignés.
 * L'avancement (phase, élément en cours, compteurs) est rapporté à intervalles réguliers via `onProgress`.
 */
export class Pruner {
  private readonly request: NonNullable<PrunerDeps["request"]>;
  private readonly get: NonNullable<PrunerDeps["get"]>;
  private readonly now: () => number;

  constructor(private readonly deps: PrunerDeps) {
    this.request = deps.request ?? ((method, path, timeoutMs) => dockerRequest(deps.socket, method, path, timeoutMs));
    this.get = deps.get ?? ((path) => dockerGet(deps.socket, path));
    this.now = deps.now ?? Date.now;
  }

  async run(msg: PruneMessage, onProgress: (p: PruneProgress) => void = () => {}): Promise<PruneResult> {
    const skipped: string[] = [];
    const errors: string[] = [];
    const note = (list: string[], text: string): void => {
      if (list.length < MAX_NOTES) list.push(text.slice(0, 300));
    };
    const removed = { containers: 0, images: 0, networks: 0, volumes: 0, buildCache: 0 };
    let reclaimed = 0;

    try {
      const now = await this.deps.collect();
      const c = now.candidates;
      const t = msg.targets;

      // Éléments réellement concernés (encore candidats) : base de l'avancement.
      const containers = t.containers.map((id) => ({ id, found: c.containers.find((x) => sameId(x.id, id)) }));
      const networks = t.networks.map((id) => ({ id, found: c.networks.find((x) => sameId(x.id, id)) }));
      const images = t.images.map((id) => ({ id, found: c.images.find((x) => sameId(x.id, id)) }));
      const volumes = t.volumes.map((name) => ({ name, found: c.volumes.find((x) => x.name === name) }));
      const count = (xs: { found?: unknown }[]): number => xs.filter((x) => x.found).length;
      const totals: Record<PrunePhase, number> = {
        containers: count(containers),
        networks: count(networks),
        images: count(images),
        volumes: count(volumes),
        buildCache: t.buildCache ? 1 : 0,
      };
      const overallTotal = Object.values(totals).reduce((a, b) => a + b, 0);
      const buildBytes = t.buildCache ? now.candidates.buildCache.reduce((s, b) => s + b.sizeBytes, 0) : undefined;

      let overallDone = 0;
      let lastSent = 0;
      let lastPhase: PrunePhase | null = null;
      const report = (phase: PrunePhase, done: number, current?: string, force = false): void => {
        const at = this.now();
        if (!force && phase === lastPhase && at - lastSent < PROGRESS_INTERVAL_MS) return;
        lastSent = at;
        lastPhase = phase;
        onProgress({
          type: "prune_progress",
          operationId: msg.operationId,
          phase,
          done,
          total: totals[phase],
          ...(current ? { current: current.slice(0, 200) } : {}),
          overall: { done: overallDone, total: overallTotal },
          removed: { ...removed },
          reclaimedBytes: reclaimed,
          ...(phase === "buildCache" && buildBytes !== undefined ? { buildCacheBytes: buildBytes } : {}),
        });
      };
      /** Passe en revue une phase : annonce chaque élément AVANT sa suppression, puis le compte à jour. */
      const step = (phase: PrunePhase, done: number, current: string): void => report(phase, done, current, done === 0);

      let done = 0;
      for (const { id, found } of containers) {
        if (!found) {
          note(skipped, `conteneur ${id.slice(0, 12)} : plus candidat (en marche, protégé ou déjà supprimé)`);
          continue;
        }
        step("containers", done, found.name);
        // v=0 : les volumes du conteneur sont conservés.
        const r = await this.request("DELETE", `/containers/${encodeURIComponent(found.id)}?v=0&force=0`);
        if (r.status === 204) {
          removed.containers++;
          reclaimed += found.sizeBytes ?? 0;
        } else if (r.status === 404) note(skipped, `conteneur ${found.name} : déjà supprimé`);
        else note(errors, `conteneur ${found.name} : ${message(r)}`);
        done++;
        overallDone++;
      }
      if (totals.containers) report("containers", done, undefined, true);

      done = 0;
      for (const { id, found } of networks) {
        if (!found) {
          note(skipped, `réseau ${id.slice(0, 12)} : plus candidat (utilisé, protégé ou déjà supprimé)`);
          continue;
        }
        step("networks", done, found.name);
        const r = await this.request("DELETE", `/networks/${encodeURIComponent(found.id)}`);
        if (r.status === 204) removed.networks++;
        else if (r.status === 404) note(skipped, `réseau ${found.name} : déjà supprimé`);
        else note(errors, `réseau ${found.name} : ${message(r)}`);
        done++;
        overallDone++;
      }
      if (totals.networks) report("networks", done, undefined, true);

      done = 0;
      for (const { id, found } of images) {
        if (!found) {
          note(skipped, `image ${id.replace("sha256:", "").slice(0, 12)} : plus candidate (utilisée, protégée ou déjà supprimée)`);
          continue;
        }
        step("images", done, found.ref);
        let r = await this.request("DELETE", `/images/${encodeURIComponent(found.id)}?force=0&noprune=0`);
        if (r.status === 409) {
          // Plusieurs étiquettes pour la même image : on retire chacune ; la dernière supprime l'image.
          const info = (await this.get(`/images/${encodeURIComponent(found.id)}/json`).catch(() => null)) as { RepoTags?: string[] } | null;
          const tags = info?.RepoTags ?? [];
          if (tags.length > 1) {
            let ok = true;
            for (const tag of tags) {
              const rt = await this.request("DELETE", `/images/${encodeURIComponent(tag)}?force=0&noprune=0`);
              if (rt.status !== 200) {
                ok = false;
                r = rt;
              }
            }
            if (ok) r = { status: 200, body: null };
          }
        }
        if (r.status === 200) {
          removed.images++;
          reclaimed += found.sizeBytes;
        } else if (r.status === 404) note(skipped, `image ${found.ref} : déjà supprimée`);
        else note(errors, `image ${found.ref} : ${message(r)}`);
        done++;
        overallDone++;
      }
      if (totals.images) report("images", done, undefined, true);

      done = 0;
      for (const { name, found } of volumes) {
        if (!found) {
          note(skipped, `volume ${name.slice(0, 40)} : plus candidat (utilisé, protégé ou déjà supprimé)`);
          continue;
        }
        step("volumes", done, found.anonymous ? `${found.name.slice(0, 12)}… (anonyme)` : found.name);
        const r = await this.request("DELETE", `/volumes/${encodeURIComponent(found.name)}?force=0`);
        if (r.status === 204) {
          removed.volumes++;
          reclaimed += found.sizeBytes ?? 0;
        } else if (r.status === 404) note(skipped, `volume ${found.name.slice(0, 40)} : déjà supprimé`);
        else note(errors, `volume ${found.name.slice(0, 40)} : ${message(r)}`);
        done++;
        overallDone++;
      }
      if (totals.volumes) report("volumes", done, undefined, true);

      if (t.buildCache) {
        // Un seul appel Docker, sans détail intermédiaire : la phase est annoncée avant, et peut durer longtemps.
        report("buildCache", 0, "cache de build", true);
        const filters: Record<string, string[]> = t.buildCache.mode === "older" && t.buildCache.olderThanHours ? { until: [`${t.buildCache.olderThanHours}h`] } : {};
        const q = new URLSearchParams({ all: "true", filters: JSON.stringify(filters), ...(t.buildCache.keepBytes ? { "keep-storage": String(Math.round(t.buildCache.keepBytes)) } : {}) });
        const r = await this.request("POST", `/build/prune?${q}`, BUILD_PRUNE_TIMEOUT_MS);
        if (r.status === 200) {
          const body = r.body as { CachesDeleted?: unknown[]; SpaceReclaimed?: number } | null;
          removed.buildCache = body?.CachesDeleted?.length ?? 0;
          reclaimed += typeof body?.SpaceReclaimed === "number" ? body.SpaceReclaimed : 0;
        } else note(errors, `cache de build : ${message(r)}`);
        overallDone++;
        report("buildCache", 1, undefined, true);
      }
    } catch (err) {
      return { type: "prune_result", operationId: msg.operationId, status: "failed", error: (err as Error).message.slice(0, 500), removed, reclaimedBytes: reclaimed, skipped, errors };
    }
    return { type: "prune_result", operationId: msg.operationId, status: "succeeded", removed, reclaimedBytes: reclaimed, skipped, errors };
  }
}
