import type { DiskUsageMessage, PruneMessage, PruneResult } from "@infra/shared";
import { dockerGet, dockerRequest, type DockerResponse } from "./docker.js";

const MAX_NOTES = 100;

export interface PrunerDeps {
  socket: string;
  /** Candidats actuels (déjà épurés des éléments protégés) : l'agent ne supprime que ce qui l'est encore. */
  collect: () => Promise<DiskUsageMessage>;
  /** Remplaçables dans les tests. */
  request?: (method: "DELETE" | "POST", path: string, timeoutMs?: number) => Promise<DockerResponse>;
  get?: (path: string) => Promise<unknown>;
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
 */
export class Pruner {
  private readonly request: NonNullable<PrunerDeps["request"]>;
  private readonly get: NonNullable<PrunerDeps["get"]>;

  constructor(private readonly deps: PrunerDeps) {
    this.request = deps.request ?? ((method, path, timeoutMs) => dockerRequest(deps.socket, method, path, timeoutMs));
    this.get = deps.get ?? ((path) => dockerGet(deps.socket, path));
  }

  async run(msg: PruneMessage): Promise<PruneResult> {
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

      for (const id of t.containers) {
        const found = c.containers.find((x) => sameId(x.id, id));
        if (!found) {
          note(skipped, `conteneur ${id.slice(0, 12)} : plus candidat (en marche, protégé ou déjà supprimé)`);
          continue;
        }
        // v=0 : les volumes du conteneur sont conservés.
        const r = await this.request("DELETE", `/containers/${encodeURIComponent(found.id)}?v=0&force=0`);
        if (r.status === 204) {
          removed.containers++;
          reclaimed += found.sizeBytes ?? 0;
        } else if (r.status === 404) note(skipped, `conteneur ${found.name} : déjà supprimé`);
        else note(errors, `conteneur ${found.name} : ${message(r)}`);
      }

      for (const id of t.networks) {
        const found = c.networks.find((x) => sameId(x.id, id));
        if (!found) {
          note(skipped, `réseau ${id.slice(0, 12)} : plus candidat (utilisé, protégé ou déjà supprimé)`);
          continue;
        }
        const r = await this.request("DELETE", `/networks/${encodeURIComponent(found.id)}`);
        if (r.status === 204) removed.networks++;
        else if (r.status === 404) note(skipped, `réseau ${found.name} : déjà supprimé`);
        else note(errors, `réseau ${found.name} : ${message(r)}`);
      }

      for (const id of t.images) {
        const found = c.images.find((x) => sameId(x.id, id));
        if (!found) {
          note(skipped, `image ${id.replace("sha256:", "").slice(0, 12)} : plus candidate (utilisée, protégée ou déjà supprimée)`);
          continue;
        }
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
      }

      for (const name of t.volumes) {
        const found = c.volumes.find((x) => x.name === name);
        if (!found) {
          note(skipped, `volume ${name.slice(0, 40)} : plus candidat (utilisé, protégé ou déjà supprimé)`);
          continue;
        }
        const r = await this.request("DELETE", `/volumes/${encodeURIComponent(found.name)}?force=0`);
        if (r.status === 204) {
          removed.volumes++;
          reclaimed += found.sizeBytes ?? 0;
        } else if (r.status === 404) note(skipped, `volume ${found.name.slice(0, 40)} : déjà supprimé`);
        else note(errors, `volume ${found.name.slice(0, 40)} : ${message(r)}`);
      }

      if (t.buildCache) {
        const filters: Record<string, string[]> = t.buildCache.mode === "older" && t.buildCache.olderThanHours ? { until: [`${t.buildCache.olderThanHours}h`] } : {};
        const q = new URLSearchParams({ all: "true", filters: JSON.stringify(filters), ...(t.buildCache.keepBytes ? { "keep-storage": String(Math.round(t.buildCache.keepBytes)) } : {}) });
        const r = await this.request("POST", `/build/prune?${q}`, 10 * 60_000);
        if (r.status === 200) {
          const body = r.body as { CachesDeleted?: unknown[]; SpaceReclaimed?: number } | null;
          removed.buildCache = body?.CachesDeleted?.length ?? 0;
          reclaimed += typeof body?.SpaceReclaimed === "number" ? body.SpaceReclaimed : 0;
        } else note(errors, `cache de build : ${message(r)}`);
      }
    } catch (err) {
      return { type: "prune_result", operationId: msg.operationId, status: "failed", error: (err as Error).message.slice(0, 500), removed, reclaimedBytes: reclaimed, skipped, errors };
    }
    return { type: "prune_result", operationId: msg.operationId, status: "succeeded", removed, reclaimedBytes: reclaimed, skipped, errors };
  }
}
