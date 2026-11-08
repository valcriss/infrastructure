import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CandidateRow, CandidateScans } from "./candidates.js";
import { HttpError } from "./http-error.js";
import type { ImageWatcher } from "./image-watch.js";
import { parseImageRef } from "./image-ref.js";
import { loadUsedImages } from "./images.js";
import type { RegistryClient } from "./registry.js";
import type { ScanRow, ScanService } from "./scans.js";
import { pickCandidates, type UpdatePolicy } from "./image-tags.js";
import { getSecuritySettings, isReported, reportedCounts, type SecuritySettings } from "./settings.js";
import { compareVersions, repoKey, summarizeVulns } from "./vuln-summary.js";
import { composeServiceImage, serviceBaseImage } from "@infra/shared";
import { deployedBase } from "./built-base.js";
import { getRevision } from "./stacks.js";
import type { Pool } from "./db.js";

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const StackParams = z.object({ id: z.uuid() });
const ServiceParams = StackParams.extend({ service: z.string().min(1).max(128) });
export const CandidateBody = z.object({ tag: z.string().trim().min(1).max(128) });

const LIGHT = /alpine|slim|distroless/i;
const UNSTABLE = /(^|[-_.])(rc|beta|alpha|dev|nightly|edge|snapshot|latest|test|preview)([-_.\d]|$)/i;

/** Segments numériques au début d'une étiquette (« 5.130.2-alpine » → [5, 130, 2]). */
const numericPrefix = (tag: string): number[] => (/^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1] ?? "").split(".").filter(Boolean).map(Number);

/**
 * Version d'une étiquette : ses segments numériques de tête (« 5.130.2-alpine »), sinon le premier numéro de version
 * pointé qu'elle contient (« develop-alpine-3.0.6.1429-ls1 » → [3, 0, 6, 1429]). Vide si elle n'en a pas.
 */
const versionOf = (tag: string): number[] => {
  const lead = numericPrefix(tag);
  if (lead.length > 0) return lead;
  return (/(?:^|[-_.])v?(\d+(?:\.\d+)+)/.exec(tag)?.[1] ?? "").split(".").filter(Boolean).map(Number);
};

/** Vrai si `tag` est plus ancienne que `current` ; la comparaison porte sur les segments communs (`5-alpine` n'est pas plus ancienne que `5.130.2`). */
function olderThan(tag: number[], current: number[]): boolean {
  for (let i = 0; i < Math.min(tag.length, current.length); i++) {
    const d = (tag[i] as number) - (current[i] as number);
    if (d !== 0) return d < 0;
  }
  return false;
}

/**
 * Versions plus récentes à comparer, tirées de la liste de tags du registre selon la règle de suivi du service.
 * Sans règle (ou « même tag »), toute version plus récente est proposée. Les versions ignorées sont écartées.
 */
export function suggestNewer(current: string, tags: string[], rule: { policy: UpdatePolicy; pattern: string | null } | undefined, ignored: string[]): string[] {
  const policy: UpdatePolicy = !rule || rule.policy === "same_tag" ? "major" : rule.policy;
  const hidden = new Set(ignored);
  return pickCandidates(current, tags, policy, rule?.pattern ?? null).candidates.filter((t) => !hidden.has(t));
}

/**
 * Variantes plus légères du même dépôt (alpine, slim…), celles qui ressemblent le plus à la version actuelle d'abord.
 * Une variante d'une version plus ancienne que l'actuelle n'est jamais proposée (ce serait un retour en arrière).
 */
export function suggestVariants(current: string, tags: string[]): string[] {
  if (LIGHT.test(current)) return [];
  const cur = numericPrefix(current);
  const curVersion = versionOf(current);
  // Nombre de segments de version communs avec l'étiquette actuelle : « 5.130.2-alpine » avant « 5-alpine ».
  const common = (t: string): number => {
    const p = numericPrefix(t);
    let n = 0;
    while (n < p.length && n < cur.length && p[n] === cur[n]) n++;
    return n;
  };
  return tags
    .filter((t) => LIGHT.test(t) && !UNSTABLE.test(t) && t !== current && !olderThan(versionOf(t), curVersion))
    .sort((x, y) => {
      const cx = common(x);
      const cy = common(y);
      if (cx !== cy) return cy - cx;
      const nx = numericPrefix(x);
      const ny = numericPrefix(y);
      if ((nx.length > 0) !== (ny.length > 0)) return nx.length > 0 ? -1 : 1;
      return compareVersions(ny.join("."), nx.join("."));
    })
    .slice(0, 8);
}

const tagOf = (ref: string): string => parseImageRef(ref)?.tag ?? "";

export function registerCandidateRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; auth: Guard; candidates: CandidateScans; scans: ScanService; watcher: ImageWatcher; registryClient: RegistryClient },
): void {
  const { pool, auth, candidates, scans, watcher, registryClient } = deps;

  /** Vulnérabilités signalées et non acceptées d'un scan, avec le nombre de corrigeables. */
  const describe = async (scan: ScanRow | null, settings: SecuritySettings) => {
    if (!scan || scan.status !== "succeeded") return null;
    const acceptances = await scans.activeAcceptances();
    const repo = repoKey(scan.imageRef);
    const vulns = (await scans.vulnerabilities(scan.id)).filter(
      (v) => isReported(v.severity, settings) && !acceptances.some((a) => a.cve.toUpperCase() === v.id.toUpperCase() && (a.repository === null || a.repository === repo)),
    );
    const reported = reportedCounts(scan.counts, settings);
    const sum = summarizeVulns(vulns);
    return {
      counts: reported?.counts ?? scan.counts,
      total: reported?.total ?? scan.total ?? 0,
      fixable: sum.fixable,
      unfixable: sum.unfixable,
      os: scan.os,
      finishedAt: scan.finishedAt?.toISOString() ?? null,
    };
  };

  const view = async (c: CandidateRow, current: Map<string, Awaited<ReturnType<typeof describe>>>, settings: SecuritySettings, adopted: boolean) => ({
    id: c.id,
    service: c.service,
    ref: c.ref,
    tag: tagOf(c.ref),
    status: c.status,
    error: c.error,
    createdAt: c.createdAt.toISOString(),
    finishedAt: c.finishedAt?.toISOString() ?? null,
    result: c.status === "succeeded" && c.scanId ? await describe(await scans.get(c.scanId), settings) : null,
    current: current.get(c.service) ?? null,
    /** Cette version est déjà dans la révision enregistrée (pas encore déployée) : plus rien à proposer. */
    adopted,
  });

  /** Image actuellement déployée de chaque service : base de la comparaison. */
  const currentByService = async (stackId: string, settings: SecuritySettings) => {
    const out = new Map<string, Awaited<ReturnType<typeof describe>>>();
    for (const img of await loadUsedImages(pool, { stackId })) {
      const scan = await scans.latestSucceeded(img.imageId, img.platform);
      const desc = await describe(scan, settings);
      for (const u of img.usedBy) if (u.service && !out.has(u.service)) out.set(u.service, desc);
    }
    return out;
  };

  // Télécharge une autre version de l'image sur l'hôte, la scanne puis la retire : rien n'est déployé.
  app.post("/api/v1/stacks/:id/services/:service/candidate-scans", { preHandler: auth }, async (request, reply) => {
    const { id, service } = ServiceParams.parse(request.params);
    const { tag } = CandidateBody.parse(request.body);
    const { row, created } = await candidates.begin({ stackId: id, service, tag, actor: request.actor });
    return reply.code(created ? 202 : 200).send({ id: row.id, status: row.status, created });
  });

  // Fermer une comparaison (ou toutes celles d'un service) : elle n'est plus proposée.
  app.post("/api/v1/stacks/:id/candidate-scans/:scanId/dismiss", { preHandler: auth }, async (request) => {
    const { id, scanId } = StackParams.extend({ scanId: z.uuid() }).parse(request.params);
    return { dismissed: await candidates.dismiss({ stackId: id, scanId, actor: request.actor }) };
  });
  app.post("/api/v1/stacks/:id/services/:service/candidate-scans/dismiss", { preHandler: auth }, async (request) => {
    const { id, service } = ServiceParams.parse(request.params);
    return { dismissed: await candidates.dismiss({ stackId: id, service, actor: request.actor }) };
  });

  app.get("/api/v1/stacks/:id/candidate-scans", { preHandler: auth }, async (request) => {
    const { id } = StackParams.parse(request.params);
    const settings = await getSecuritySettings(pool);
    const current = await currentByService(id, settings);
    // Une comparaison n'est plus utile quand sa version est déjà celle qui tourne, ou après une semaine.
    const deployed = new Map<string, string>();
    for (const img of await loadUsedImages(pool, { stackId: id })) for (const u of img.usedBy) if (u.service && !deployed.has(u.service)) deployed.set(u.service, u.ref);
    // Service construit : la version « déployée » est celle de l'image de base (FROM), pas de l'image locale qui tourne.
    for (const service of [...deployed.keys()]) {
      const base = await deployedBase(pool, id, service);
      if (base && !("error" in base)) deployed.set(service, base.ref);
    }
    const stack = await pool.query<{ current_revision: number }>("SELECT current_revision FROM stacks WHERE id = $1", [id]);
    const rev = stack.rows[0] ? await getRevision(pool, id, stack.rows[0].current_revision) : null;
    const currentRef = (service: string): string | null => {
      if (!rev) return null;
      const b = serviceBaseImage(rev.compose, rev.files, service);
      return b && !("error" in b) ? b.ref : composeServiceImage(rev.compose, service);
    };
    const weekAgo = Date.now() - 7 * 24 * 3600_000;
    const list = (await candidates.list(id)).filter((c) => c.ref !== deployed.get(c.service) && c.createdAt.getTime() > weekAgo);
    return { candidates: await Promise.all(list.map((c) => view(c, current, settings, currentRef(c.service) === c.ref))) };
  });

  // Versions à comparer : plus récentes (suivi des versions) et variantes plus légères du même dépôt.
  app.get("/api/v1/stacks/:id/services/:service/tag-suggestions", { preHandler: auth }, async (request) => {
    const { id, service } = ServiceParams.parse(request.params);
    const img = (await loadUsedImages(pool, { stackId: id })).flatMap((i) => i.usedBy).find((u) => u.service === service);
    if (!img) throw new HttpError(404, "service_not_found", "Service introuvable ou jamais déployé.");
    // Service construit : suggestions pour son image de base (FROM).
    const base = await deployedBase(pool, id, service);
    if (base && "error" in base) return { current: null, newer: [], variants: [], note: base.error };
    const parsed = parseImageRef(base?.ref ?? img.ref);
    if (!parsed || !parsed.tag) return { current: null, newer: [], variants: [], note: "Image épinglée ou sans étiquette : indiquez la version à comparer." };
    // Repli : candidats de la dernière vérification, si la liste du registre est indisponible.
    const check = (await watcher.checks(id)).find((c) => c.service === service);
    let newer = check?.detail?.candidates?.slice(0, 8) ?? [];
    let variants: string[] = [];
    let truncated = false;
    let note: string | null = null;
    try {
      const listed = await registryClient.listTags(parsed);
      truncated = listed.truncated;
      // Calculées à la demande : une vérification préalable n'est pas nécessaire.
      const rule = (await watcher.policies(id))[service];
      const ignored = ((await watcher.ignoredTags(id))[service] ?? []).map((i) => i.tag);
      newer = suggestNewer(parsed.tag, listed.tags, rule, ignored).slice(0, 8);
      variants = suggestVariants(parsed.tag, listed.tags);
      if (truncated) note = "Liste des versions du registre incomplète : les plus récentes peuvent manquer. Saisissez l'étiquette à comparer si vous la connaissez.";
    } catch {
      note = "Liste des versions du registre indisponible : saisissez l'étiquette à comparer.";
    }
    return { current: parsed.tag, newer, variants, truncated, note };
  });
}
