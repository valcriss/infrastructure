import { SEVERITIES, type Severity } from "@infra/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import type { ImageWatcher } from "./image-watch.js";
import { POLICIES } from "./image-tags.js";
import { briefOf, loadUsedImages, isScanStale, scanState, type UsedImage } from "./images.js";
import { normalizeRegistry } from "./image-ref.js";
import type { RegistryClient } from "./registry.js";
import { RegistryError } from "./registry.js";
import type { RegistryStore } from "./registries.js";
import type { ScanRow, ScanService } from "./scans.js";
import { MIN_SEVERITIES, getSecuritySettings, isReported, reportedCounts, setSecuritySettings, type SecuritySettings } from "./settings.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const ImageId = z.string().regex(/^(sha256:)?[0-9a-f]{12,64}$/);
export const ImageListQuery = z.object({ hostId: z.uuid().optional(), stackId: z.uuid().optional() });
export const ScanDetailQuery = z.object({
  /** Plateforme (os/arch) ; absente = n'importe laquelle. */
  platform: z.string().max(60).optional(),
  severity: z.enum(SEVERITIES).optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export const ManualScanBody = z.object({ hostId: z.uuid().optional(), platform: z.string().max(60).optional() }).default({});
export const PolicyBody = z.object({ policy: z.enum(POLICIES as [string, ...string[]]), pattern: z.string().max(100).nullable().optional() });
export const SecuritySettingsBody = z.object({
  scanIntervalHours: z.number().int().min(0).max(720),
  imageCheckIntervalHours: z.number().int().min(0).max(720),
  /** Gravité minimale signalée (les scans restent complets). */
  minSeverity: z.enum(MIN_SEVERITIES).default("LOW"),
  /** Signaler aussi les vulnérabilités de gravité « inconnue ». */
  includeUnknown: z.boolean().default(true),
});
/** Scan de plusieurs images : périmètre choisi dans la boîte de dialogue (`dryRun` : compter sans lancer). */
export const BatchScanBody = z.object({
  /** « never » : aucun scan réussi ; « outdated » : jamais scannées ou périmées ; « all » : toutes. */
  scope: z.enum(["never", "outdated", "all"]).default("never"),
  /** Seulement les images des applications gérées par la console. */
  managedOnly: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
export const RegistryBody = z.object({
  username: z.string().max(255).nullable().optional(),
  /** Absent = conserver le mot de passe actuel. */
  password: z.string().max(1024).nullable().optional(),
  /** Autorise HTTP (registre interne sans TLS). */
  insecure: z.boolean().default(false),
});

/** Résumé d'un scan : compteurs et total limités aux gravités signalées ; `hidden` = résultats masqués par le seuil. */
const scanSummary = (s: ScanRow | null, settings: SecuritySettings) => {
  const reported = s ? reportedCounts(s.counts, settings) : null;
  return s
    ? {
        id: s.id,
        status: s.status,
        trigger: s.trigger,
        createdAt: s.createdAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
        error: s.error,
        trivyVersion: s.trivyVersion,
        dbUpdatedAt: s.dbUpdatedAt?.toISOString() ?? null,
        dbDownloadedAt: s.dbDownloadedAt?.toISOString() ?? null,
        os: s.os,
        counts: reported ? reported.counts : s.counts,
        total: reported ? reported.total : s.total,
        hidden: reported ? reported.hidden : 0,
        truncated: s.truncated,
      }
    : null;
};

export function registerImageRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pool;
    session: Guard;
    apiAuth: Guard;
    scans: ScanService;
    watcher: ImageWatcher;
    registries: RegistryStore;
    registryClient: RegistryClient;
    isOnline: (hostId: string) => boolean;
  },
): void {
  const { pool, session, apiAuth, scans, watcher, registries, registryClient } = deps;

  /** Vue d'un contenu d'image : état du scan (jamais confondu avec « sain »), utilisateurs, dernier résultat réussi. */
  const view = async (img: UsedImage, queuePosition: number | null = null) => {
    const [attempt, ok, settings] = await Promise.all([scans.latest(img.imageId, img.platform), scans.latestSucceeded(img.imageId, img.platform), getSecuritySettings(pool)]);
    const state = scanState(attempt ? briefOf(attempt, settings) : null);
    return {
      imageId: img.imageId,
      platform: img.platform,
      refs: img.refs,
      repoDigests: img.info?.repoDigests ?? [],
      size: img.info?.size ?? null,
      managed: img.usedBy.some((u) => u.stackId !== null),
      usedBy: img.usedBy,
      scan: {
        state,
        /** Rang dans la file d'attente (1 = prochain), pour un scan en attente. */
        queuePosition,
        stale: isScanStale(ok, settings.scanIntervalHours),
        lastAttempt: scanSummary(attempt, settings),
        // Dernier résultat réussi : conservé et daté même si la dernière tentative a échoué.
        current: scanSummary(ok, settings),
      },
    };
  };

  app.get("/api/v1/images", { preHandler: apiAuth }, async (request) => {
    const q = ImageListQuery.parse(request.query);
    const images = await loadUsedImages(pool, q);
    const queue = await scans.queue();
    const position = new Map(queue.pending.map((p, i) => [`${p.imageId}|${p.platform}`, i + 1]));
    return {
      queue: { pending: queue.pending.length, running: queue.running, current: queue.current },
      images: await Promise.all(images.map((img) => view(img, position.get(`${img.imageId}|${img.platform}`) ?? null))),
    };
  });

  // Scan de plusieurs images : tous les hôtes partagent une seule file, un scan à la fois, dans l'ordre de la demande.
  app.post("/api/v1/images/scans", { preHandler: apiAuth }, async (request, reply) => {
    const body = BatchScanBody.parse(request.body ?? {});
    const settings = await getSecuritySettings(pool);
    const [images, latest] = await Promise.all([loadUsedImages(pool), scans.latestAll()]);
    const out = { dryRun: body.dryRun, total: 0, requested: 0, alreadyQueued: 0, skippedOffline: 0 };
    for (const img of images) {
      if (body.managedOnly && !img.usedBy.some((u) => u.stackId !== null)) continue;
      const entry = latest.get(`${img.imageId}|${img.platform}`);
      const never = !entry?.ok;
      // Intervalle désactivé (0) : « périmé » se juge sur 24 h pour ce choix explicite.
      const stale = !never && isScanStale(entry?.ok ?? null, settings.scanIntervalHours || 24);
      if (body.scope === "never" && !never) continue;
      if (body.scope === "outdated" && !(never || stale)) continue;
      out.total++;
      if (entry && (entry.attempt.status === "pending" || entry.attempt.status === "running")) {
        out.alreadyQueued++;
        continue;
      }
      if (!img.usedBy.some((u) => deps.isOnline(u.hostId))) {
        out.skippedOffline++;
        continue;
      }
      if (body.dryRun) {
        out.requested++;
        continue;
      }
      try {
        const { created } = await requestScan(img, undefined, request.actor);
        if (created) out.requested++;
        else out.alreadyQueued++;
      } catch {
        out.skippedOffline++; // l'agent s'est déconnecté entre-temps
      }
    }
    return reply.code(body.dryRun ? 200 : 202).send(out);
  });

  // Annule les scans qui attendent encore leur tour (celui en cours va à son terme).
  // `only=running` : débloque la file en déclarant perdu le scan en cours (agent muet, résultat jamais arrivé) sans toucher
  // aux scans en attente, qui reprennent ; `only=all` retire tout.
  app.delete("/api/v1/images/scans/queue", { preHandler: apiAuth }, async (request) => {
    const q = z.object({ only: z.enum(["pending", "running", "all"]).default("pending") }).parse(request.query);
    const out = await scans.cancelPending(request.actor, q.only);
    if (q.only !== "pending") await scans.pumpAny();
    return out;
  });

  app.get("/api/v1/images/:imageId/scan", { preHandler: apiAuth }, async (request) => {
    const { imageId } = z.object({ imageId: ImageId }).parse(request.params);
    const q = ScanDetailQuery.parse(request.query);
    const id = imageId.startsWith("sha256:") ? imageId : `sha256:${imageId}`;
    const scan = await scans.latestSucceeded(id, q.platform ?? null);
    if (!scan) throw new HttpError(404, "scan_not_found", "Aucun scan réussi pour cette image.");
    const sev = q.severity as Severity | undefined;
    const needle = q.q?.toLowerCase();
    const settings = await getSecuritySettings(pool);
    const all = (await scans.vulnerabilities(scan.id)).filter(
      (v) => isReported(v.severity, settings) && (!sev || v.severity === sev) && (!needle || v.id.toLowerCase().includes(needle) || v.pkg.toLowerCase().includes(needle)),
    );
    return { scan: scanSummary(scan, settings), total: all.length, vulnerabilities: all.slice(q.offset, q.offset + q.limit) };
  });

  const requestScan = async (img: UsedImage, hostId: string | undefined, actor: string) => {
    const hosts = [...new Set(img.usedBy.map((u) => u.hostId))];
    const target = hostId ?? hosts.find((h) => deps.isOnline(h));
    if (!target || !hosts.includes(target)) throw new HttpError(409, "host_offline", "Aucun hôte en ligne ne porte cette image.");
    const ref = img.usedBy.find((u) => u.hostId === target)?.ref ?? img.refs[0] ?? img.imageId;
    return scans.request({ imageId: img.imageId, platform: img.platform, hostId: target, imageRef: ref, trigger: "manual", requestedBy: actor });
  };

  app.post("/api/v1/images/:imageId/scans", { preHandler: apiAuth }, async (request, reply) => {
    const { imageId } = z.object({ imageId: ImageId }).parse(request.params);
    const body = ManualScanBody.parse(request.body ?? {});
    const id = imageId.startsWith("sha256:") ? imageId : `sha256:${imageId}`;
    const img = (await loadUsedImages(pool)).find((i) => i.imageId === id && (body.platform === undefined || i.platform === body.platform));
    if (!img) throw new HttpError(404, "image_not_found", "Image inconnue : elle n'est utilisée par aucun conteneur observé.");
    const { scan, created } = await requestScan(img, body.hostId, request.actor);
    return reply.code(created ? 202 : 200).send({ scanId: scan.id, status: scan.status, created });
  });

  app.get("/api/v1/scans/:id", { preHandler: apiAuth }, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const scan = await scans.get(id);
    if (!scan) throw new HttpError(404, "scan_not_found", "Scan introuvable.");
    return scanSummary(scan, await getSecuritySettings(pool));
  });

  // --- Par stack ---------------------------------------------------------------------------

  const stackOr404 = async (id: string) => {
    const { rows } = await pool.query<{ id: string; name: string }>("SELECT id, name FROM stacks WHERE id = $1", [id]);
    if (!rows[0]) throw new HttpError(404, "stack_not_found", "Stack introuvable");
    return rows[0];
  };

  app.post("/api/v1/stacks/:id/scans", { preHandler: apiAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await stackOr404(id);
    const images = await loadUsedImages(pool, { stackId: id });
    if (images.length === 0) throw new HttpError(409, "no_image", "Aucune image observée pour cette stack (jamais déployée ou hôte sans inventaire).");
    const results: { imageId: string; scanId: string | null; status: string; created: boolean; error?: string }[] = [];
    for (const img of images) {
      try {
        const { scan, created } = await requestScan(img, undefined, request.actor);
        results.push({ imageId: img.imageId, scanId: scan.id, status: scan.status, created });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        results.push({ imageId: img.imageId, scanId: null, status: "not_started", created: false, error: err.message });
      }
    }
    return reply.code(202).send({ scans: results });
  });

  app.get("/api/v1/stacks/:id/images", { preHandler: apiAuth }, async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await stackOr404(id);
    const [images, policies, checks] = await Promise.all([loadUsedImages(pool, { stackId: id }), watcher.policies(id), watcher.checks(id)]);
    const byService = new Map(checks.map((c) => [c.service, c]));
    const components: unknown[] = [];
    const seen = new Set<string>();
    for (const img of images) {
      const v = await view(img);
      for (const u of img.usedBy) {
        if (!u.service || seen.has(u.service)) continue;
        seen.add(u.service);
        // Un résultat obtenu pour une autre référence (tag modifié depuis) ne vaut plus : il est écarté.
        const found = byService.get(u.service);
        const c = found && (!found.detail?.ref || found.detail.ref === u.ref) ? found : undefined;
        components.push({
          service: u.service,
          ref: u.ref,
          image: v,
          policy: policies[u.service] ?? { policy: "same_tag", pattern: null },
          check: c
            ? {
                checkedAt: c.checkedAt.toISOString(),
                status: c.status,
                kind: c.kind,
                detail: c.detail,
                error: c.error,
                // Dernière observation réussie : conservée et datée quand le registre échoue.
                lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
              }
            : null,
        });
      }
    }
    return { checking: watcher.isChecking(id), components };
  });

  app.post("/api/v1/stacks/:id/image-checks", { preHandler: apiAuth }, async (request, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    await stackOr404(id);
    // Asynchrone : les registres peuvent être lents ; le résultat se lit avec GET /stacks/{id}/images.
    void watcher.checkStack(id).catch(() => {});
    return reply.code(202).send({ checking: true });
  });

  app.put("/api/v1/stacks/:id/services/:service/update-policy", { preHandler: apiAuth }, async (request) => {
    const { id, service } = z.object({ id: z.uuid(), service: z.string().min(1).max(128) }).parse(request.params);
    const body = PolicyBody.parse(request.body);
    await watcher.setPolicy(id, service, body.policy as never, body.pattern ?? null, request.actor);
    return { service, policy: body.policy, pattern: body.policy === "pattern" ? (body.pattern ?? null) : null };
  });

  // --- Paramètres et registres ------------------------------------------------------------------

  app.get("/api/v1/settings/security", { preHandler: apiAuth }, async () => getSecuritySettings(pool));
  app.put("/api/v1/settings/security", { preHandler: session }, async (request) => {
    const body = SecuritySettingsBody.parse(request.body);
    return setSecuritySettings(pool, body);
  });

  app.get("/api/v1/registries", { preHandler: session }, async () => ({ registries: await registries.list() }));

  app.put("/api/v1/registries/:registry", { preHandler: session }, async (request) => {
    const { registry } = z.object({ registry: z.string().min(1).max(260) }).parse(request.params);
    return registries.upsert(registry, RegistryBody.parse(request.body), request.actor);
  });

  app.delete("/api/v1/registries/:registry", { preHandler: session }, async (request, reply) => {
    const { registry } = z.object({ registry: z.string().min(1).max(260) }).parse(request.params);
    await registries.remove(registry, request.actor);
    return reply.code(204).send();
  });

  app.post("/api/v1/registries/:registry/test", { preHandler: session }, async (request) => {
    const { registry } = z.object({ registry: z.string().min(1).max(260) }).parse(request.params);
    const name = normalizeRegistry(registry);
    if (!name) throw new HttpError(400, "invalid_registry", "Nom de registre invalide.");
    try {
      await registryClient.testAccess(name);
      return { ok: true };
    } catch (err) {
      if (err instanceof RegistryError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  });
}
