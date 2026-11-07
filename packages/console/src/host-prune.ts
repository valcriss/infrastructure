import type { ConsoleMessage, DiskCandidates, DiskUsageMessage, PruneMessage, PruneResult } from "@infra/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";

const DAY = 86_400;
/** Un relevé plus ancien est refusé : l'aperçu doit refléter l'état actuel de l'hôte. */
const MAX_AGE_MS = 5 * 60_000;
const PRUNE_TTL_MS = 10 * 60_000;

export const PruneOptionsSchema = z.object({
  /** Conteneurs arrêtés ; l'ancienneté porte sur la date de CRÉATION (c'est ce que filtre Docker). */
  containers: z.object({ enabled: z.boolean(), olderThanDays: z.number().int().min(1).max(3650).optional() }).default({ enabled: false }),
  /** « dangling » : images sans nom ; « unused » : toutes celles qu'aucun conteneur n'utilise. */
  images: z.object({ mode: z.enum(["off", "dangling", "unused"]), olderThanDays: z.number().int().min(1).max(3650).optional() }).default({ mode: "off" }),
  networks: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  /** « anonymous » : volumes créés sans nom ; « all » : tous les volumes inutilisés (données définitivement perdues). */
  volumes: z.object({ mode: z.enum(["off", "anonymous", "all"]) }).default({ mode: "off" }),
  /** Cache de build : l'ancienneté porte sur la dernière UTILISATION. */
  buildCache: z.object({ mode: z.enum(["off", "all", "older"]), olderThanDays: z.number().int().min(1).max(3650).optional(), keepGB: z.number().min(0).max(100_000).optional() }).default({ mode: "off" }),
});
export type PruneOptions = z.infer<typeof PruneOptionsSchema>;

export type WarningLevel = "info" | "warning" | "danger";

export interface PrunePlan {
  observedAt: string;
  items: {
    containers: DiskCandidates["containers"];
    images: DiskCandidates["images"];
    networks: DiskCandidates["networks"];
    volumes: DiskCandidates["volumes"];
    buildCache: { mode: "off" | "all" | "older"; count: number; sizeBytes: number; olderThanDays: number | null; keepGB: number | null; sample: DiskCandidates["buildCache"] };
  };
  totals: { items: number; reclaimableBytes: number };
  warnings: { level: WarningLevel; text: string }[];
  /** Vrai quand des volumes sont supprimés : le nom de l'hôte doit être saisi pour confirmer. */
  requiresHostConfirmation: boolean;
  truncated: boolean;
}

export interface PruneRunRow {
  id: string;
  hostId: string;
  requestedBy: string;
  status: "running" | "succeeded" | "failed" | "unknown";
  options: PruneOptions;
  result: PruneResult | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface PruneTransport {
  isOnline(hostId: string): boolean;
  send(hostId: string, message: ConsoleMessage): boolean;
}

interface DbRun {
  id: string;
  host_id: string;
  requested_by: string;
  status: PruneRunRow["status"];
  options: PruneOptions;
  result: PruneResult | null;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

const toRun = (r: DbRun): PruneRunRow => ({
  id: r.id,
  hostId: r.host_id,
  requestedBy: r.requested_by,
  status: r.status,
  options: r.options,
  result: r.result,
  error: r.error,
  createdAt: r.created_at.toISOString(),
  finishedAt: r.finished_at?.toISOString() ?? null,
});

const fmtGB = (b: number): string => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} Go` : `${Math.round(b / 1e6)} Mo`);

/**
 * Sélection de ce qui serait supprimé, calculée à partir du dernier relevé de l'agent (équivalent de `docker system df`).
 * Fonction pure : testée sans Docker. `managedProjects` = projets Compose pilotés par la console, pour des
 * avertissements précis.
 */
export function buildPlan(usage: DiskUsageMessage, options: PruneOptions, managedProjects: Set<string>, now = Date.now()): PrunePlan {
  const c = usage.candidates;
  const cut = (days?: number): number | null => (days ? Math.floor(now / 1000) - days * DAY : null);

  const cc = cut(options.containers.olderThanDays);
  const containers = options.containers.enabled ? c.containers.filter((x) => cc === null || x.created <= cc) : [];

  const ic = cut(options.images.olderThanDays);
  const images = options.images.mode === "off" ? [] : c.images.filter((x) => (options.images.mode === "unused" || x.dangling) && (ic === null || x.created <= ic));

  const networks = options.networks.enabled ? c.networks : [];
  const volumes = options.volumes.mode === "off" ? [] : c.volumes.filter((v) => options.volumes.mode === "all" || v.anonymous);

  const bc = options.buildCache;
  const bcCut = bc.mode === "older" && bc.olderThanDays ? now - bc.olderThanDays * DAY * 1000 : null;
  const cacheItems =
    bc.mode === "off" ? [] : c.buildCache.filter((x) => bcCut === null || (x.lastUsedAt !== null && Date.parse(x.lastUsedAt) <= bcCut));
  const cacheSize = cacheItems.reduce((s, x) => s + x.sizeBytes, 0);
  const keepBytes = bc.keepGB ? bc.keepGB * 1e9 : 0;

  const sum = (xs: { sizeBytes: number | null }[]): number => xs.reduce((s, x) => s + (x.sizeBytes ?? 0), 0);
  const reclaimable = sum(containers) + sum(images) + sum(volumes) + Math.max(0, cacheSize - keepBytes);

  const warnings: PrunePlan["warnings"] = [];
  const w = (level: WarningLevel, text: string): void => void warnings.push({ level, text });

  if (containers.length > 0) {
    const managed = [...new Set(containers.map((x) => x.project).filter((p): p is string => !!p && managedProjects.has(p)))];
    const observed = [...new Set(containers.map((x) => x.project).filter((p): p is string => !!p && !managedProjects.has(p)))];
    w("warning", `${containers.length} conteneur(s) arrêté(s) seront supprimés avec leurs logs et les données écrites dans leur système de fichiers. Leurs volumes sont conservés (sauf s'ils sont aussi sélectionnés).`);
    if (managed.length > 0) w("warning", `Parmi eux, des conteneurs d'applications gérées par la console : ${managed.join(", ")}. Si vous les avez seulement arrêtées, elles seront à redéployer ; leurs conteneurs seront recréés vides.`);
    if (observed.length > 0) w("warning", `Des conteneurs de projets non gérés par la console seront aussi supprimés : ${observed.join(", ")}. La console ne pourra pas les recréer (leur fichier Compose ne lui est pas connu).`);
    if (cc !== null) w("info", "L'ancienneté des conteneurs se mesure à leur date de création, pas à leur date d'arrêt.");
  }
  if (images.length > 0) {
    w("info", `${images.length} image(s) seront supprimées (${fmtGB(sum(images))}) ; elles seront retéléchargées ou reconstruites si besoin. Les images utilisées par un conteneur, même arrêté, ne sont pas concernées.`);
    if (options.images.mode === "unused") w("warning", "Le mode « toutes les images inutilisées » supprime aussi des images nommées (par exemple d'une application arrêtée ou d'une ancienne version) : leur retéléchargement peut être long ou impossible hors ligne.");
    if (ic !== null) w("info", "L'ancienneté des images se mesure à leur date de création, pas à leur dernière utilisation.");
  }
  if (networks.length > 0) w("info", `${networks.length} réseau(x) inutilisé(s) seront supprimés ; Docker les recrée au prochain démarrage d'une application.`);
  if (volumes.length > 0) {
    w("danger", `${volumes.length} volume(s) seront supprimés DÉFINITIVEMENT avec toutes leurs données (${fmtGB(sum(volumes))}). Cette action est irréversible et n'est pas sauvegardée.`);
    const named = volumes.filter((v) => !v.anonymous);
    if (named.length > 0) w("danger", `Dont ${named.length} volume(s) nommé(s) (bases de données, fichiers…) : ${named.slice(0, 5).map((v) => v.name).join(", ")}${named.length > 5 ? "…" : ""}. Un volume « inutilisé » n'est pas un volume inutile : il peut appartenir à une application arrêtée.`);
    const managed = [...new Set(volumes.map((v) => v.project).filter((p): p is string => !!p && managedProjects.has(p)))];
    if (managed.length > 0) w("danger", `Des volumes d'applications gérées par la console seront supprimés : ${managed.join(", ")}.`);
  }
  if (cacheItems.length > 0) {
    w("info", `${cacheItems.length} entrée(s) du cache de build seront supprimées (${fmtGB(cacheSize)}${keepBytes ? `, hors ${fmtGB(keepBytes)} conservés` : ""}) ; le prochain build sera plus long, sans autre conséquence.`);
    if (bc.mode === "older") w("info", "L'ancienneté du cache de build se mesure à sa dernière utilisation.");
  }
  if (usage.truncated) w("info", "Les listes sont tronquées aux éléments les plus volumineux : un second nettoyage pourra supprimer le reste.");

  const count = containers.length + images.length + networks.length + volumes.length + cacheItems.length;
  return {
    observedAt: usage.observedAt,
    items: {
      containers,
      images,
      networks,
      volumes,
      buildCache: { mode: bc.mode, count: cacheItems.length, sizeBytes: cacheSize, olderThanDays: bc.mode === "older" ? (bc.olderThanDays ?? null) : null, keepGB: bc.keepGB ?? null, sample: cacheItems.slice(0, 30) },
    },
    totals: { items: count, reclaimableBytes: reclaimable },
    warnings,
    requiresHostConfirmation: volumes.length > 0,
    truncated: usage.truncated,
  };
}

/** Relevé `docker system df`, aperçu et exécution des nettoyages d'un hôte. Un nettoyage à la fois par hôte. */
export class PruneService {
  constructor(
    private readonly pool: Pool,
    private readonly transport: PruneTransport,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Au démarrage de la console, un nettoyage « en cours » a un résultat inconnu : l'agent l'a peut-être terminé. */
  async markInterrupted(): Promise<void> {
    await this.pool.query("UPDATE prune_runs SET status = 'unknown', finished_at = now(), error = 'Console redémarrée pendant le nettoyage : vérifiez l''état de l''hôte.' WHERE status = 'running'");
  }

  async onDisconnect(hostId: string): Promise<void> {
    await this.pool.query(
      "UPDATE prune_runs SET status = 'unknown', finished_at = now(), error = 'Connexion à l''agent perdue pendant le nettoyage : vérifiez l''état de l''hôte.' WHERE host_id = $1 AND status = 'running'",
      [hostId],
    );
  }

  private async host(hostId: string): Promise<{ name: string; usage: DiskUsageMessage | null; usageAt: Date | null }> {
    const { rows } = await this.pool.query<{ name: string; disk_usage: DiskUsageMessage | null; disk_usage_at: Date | null }>(
      "SELECT name, disk_usage, disk_usage_at FROM hosts WHERE id = $1 AND revoked_at IS NULL",
      [hostId],
    );
    const r = rows[0];
    if (!r) throw new HttpError(404, "host_not_found", "Hôte introuvable");
    return { name: r.name, usage: r.disk_usage, usageAt: r.disk_usage_at };
  }

  async latest(hostId: string): Promise<{ observedAt: string | null; summary: DiskUsageMessage["summary"] | null; truncated: boolean }> {
    const h = await this.host(hostId);
    return { observedAt: h.usage?.observedAt ?? null, summary: h.usage?.summary ?? null, truncated: h.usage?.truncated ?? false };
  }

  /** Demande un nouveau relevé à l'agent et attend son arrivée (30 s au plus). */
  async refresh(hostId: string, waitMs = 30_000): Promise<void> {
    if (!this.transport.isOnline(hostId)) throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne.");
    const before = (await this.host(hostId)).usageAt?.getTime() ?? 0;
    if (!this.transport.send(hostId, { type: "request_disk_usage" })) throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne.");
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      await this.sleep(300);
      const at = (await this.host(hostId)).usageAt?.getTime() ?? 0;
      if (at > before) return;
    }
    throw new HttpError(504, "disk_usage_timeout", "L'agent n'a pas répondu à temps (relevé de l'espace disque en cours ou trop long) : réessayez dans un instant.");
  }

  private async managedProjects(hostId: string): Promise<Set<string>> {
    const { rows } = await this.pool.query<{ name: string }>("SELECT name FROM stacks WHERE host_id = $1", [hostId]);
    return new Set(rows.map((r) => r.name));
  }

  async plan(hostId: string, options: PruneOptions, now = Date.now()): Promise<PrunePlan> {
    const h = await this.host(hostId);
    if (!h.usage || !h.usageAt) throw new HttpError(409, "disk_usage_unknown", "Aucun relevé de l'espace disque pour cet hôte : actualisez-le d'abord.");
    if (now - h.usageAt.getTime() > MAX_AGE_MS) throw new HttpError(409, "disk_usage_stale", "Le relevé de l'espace disque a plus de 5 minutes : actualisez-le avant de continuer.");
    return buildPlan(h.usage, options, await this.managedProjects(hostId), now);
  }

  async history(hostId: string, limit = 20): Promise<PruneRunRow[]> {
    const { rows } = await this.pool.query<DbRun>("SELECT * FROM prune_runs WHERE host_id = $1 ORDER BY created_at DESC LIMIT $2", [hostId, limit]);
    return rows.map(toRun);
  }

  async get(runId: string): Promise<PruneRunRow | null> {
    const { rows } = await this.pool.query<DbRun>("SELECT * FROM prune_runs WHERE id = $1", [runId]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  /** Lance le nettoyage. La sélection est recalculée ici : les listes envoyées par le navigateur ne sont jamais crues. */
  async run(hostId: string, options: PruneOptions, actor: string, confirmHostName?: string): Promise<PruneRunRow> {
    const h = await this.host(hostId);
    if (!this.transport.isOnline(hostId)) throw new HttpError(409, "host_offline", "L'agent de l'hôte est hors ligne : rien n'a été supprimé.");
    const plan = await this.plan(hostId, options);
    if (plan.totals.items === 0) throw new HttpError(400, "nothing_to_prune", "Rien à supprimer avec ces options.");
    if (plan.requiresHostConfirmation && confirmHostName !== h.name) {
      throw new HttpError(400, "confirmation_required", "La suppression de volumes exige de saisir le nom de l'hôte pour confirmer.");
    }
    const busy = await this.pool.query(
      "SELECT 1 FROM operations o JOIN stacks s ON s.id = o.stack_id WHERE s.host_id = $1 AND o.status IN ('pending', 'running') LIMIT 1",
      [hostId],
    );
    if ((busy.rowCount ?? 0) > 0) throw new HttpError(409, "operation_in_progress", "Un déploiement est en cours sur cet hôte : attendez sa fin avant de nettoyer.");

    const id = randomUUID();
    const targets: PruneMessage["targets"] = {
      containers: plan.items.containers.map((x) => x.id),
      images: plan.items.images.map((x) => x.id),
      networks: plan.items.networks.map((x) => x.id),
      volumes: plan.items.volumes.map((x) => x.name),
      ...(options.buildCache.mode !== "off" && plan.items.buildCache.count > 0
        ? {
            buildCache: {
              mode: options.buildCache.mode,
              ...(options.buildCache.mode === "older" && options.buildCache.olderThanDays ? { olderThanHours: options.buildCache.olderThanDays * 24 } : {}),
              ...(options.buildCache.keepGB ? { keepBytes: options.buildCache.keepGB * 1e9 } : {}),
            },
          }
        : {}),
    };
    try {
      await this.pool.query(
        "INSERT INTO prune_runs (id, host_id, requested_by, status, options, targets) VALUES ($1, $2, $3, 'running', $4, $5)",
        [id, hostId, actor, JSON.stringify(options), JSON.stringify(targets)],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new HttpError(409, "prune_in_progress", "Un nettoyage est déjà en cours sur cet hôte.");
      throw err;
    }
    await audit(this.pool, actor, "host.prune", `${hostId}/${id}`, "success");
    const sent = this.transport.send(hostId, { type: "prune", operationId: id, expiresAt: new Date(Date.now() + PRUNE_TTL_MS).toISOString(), targets });
    if (!sent) {
      await this.pool.query("UPDATE prune_runs SET status = 'failed', finished_at = now(), error = 'Agent hors ligne : rien n''a été supprimé.' WHERE id = $1", [id]);
    }
    return (await this.get(id)) as PruneRunRow;
  }

  async onResult(hostId: string, msg: PruneResult): Promise<void> {
    await this.pool.query(
      "UPDATE prune_runs SET status = $3, result = $4, error = $5, finished_at = now() WHERE id = $1 AND host_id = $2 AND status = 'running'",
      [msg.operationId, hostId, msg.status, JSON.stringify(msg), msg.error ?? null],
    );
  }
}

