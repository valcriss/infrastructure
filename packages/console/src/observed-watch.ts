import type { Container } from "@infra/shared";
import { audit, type Pool } from "./db.js";
import { hiddenProjects } from "./display.js";
import { HttpError } from "./http-error.js";
import { loadUsedImages } from "./images.js";
import { POLICIES, validatePattern, type UpdatePolicy } from "./image-tags.js";
import { evaluateImage, type CheckDetail, type CheckKind, type PolicyRow, type RegistryLike } from "./image-watch.js";
import { RegistryError } from "./registry.js";
import { getSecuritySettings } from "./settings.js";

export interface ObservedCheckRow {
  service: string;
  checkedAt: Date;
  status: "ok" | "error";
  kind: CheckKind | null;
  detail: CheckDetail | null;
  error: string | null;
  lastSuccessAt: Date | null;
}

export interface IgnoredTag {
  tag: string;
  reason: string | null;
  createdBy: string;
  createdAt: Date;
}

const key = (hostId: string, project: string): string => `${hostId}|${project}`;

/**
 * Suivi des versions d'image des projets Compose non gérés : mêmes règles et même évaluation que pour les stacks
 * (`evaluateImage`), avec les résultats rangés par (hôte, projet, service). Ne télécharge ni ne déploie rien.
 */
export class ObservedWatcher {
  private timer: NodeJS.Timeout | undefined;
  private readonly checking = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly client: RegistryLike,
    private readonly log: { error(obj: unknown, msg?: string): void } = { error: () => {} },
  ) {}

  start(tickMs = 5 * 60_000): void {
    this.timer = setInterval(() => void this.scheduledPass().catch((e: unknown) => this.log.error(e, "vérification des images observées")), tickMs);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  isChecking(hostId: string, project: string): boolean {
    return this.checking.has(key(hostId, project));
  }

  async policies(hostId: string, project: string): Promise<Record<string, PolicyRow>> {
    const { rows } = await this.pool.query<{ service: string; policy: UpdatePolicy; pattern: string | null }>(
      "SELECT service, policy, pattern FROM observed_image_policies WHERE host_id = $1 AND project = $2",
      [hostId, project],
    );
    return Object.fromEntries(rows.map((r) => [r.service, { policy: r.policy, pattern: r.pattern }]));
  }

  async ignoredTags(hostId: string, project: string): Promise<Record<string, IgnoredTag[]>> {
    const { rows } = await this.pool.query<{ service: string; tag: string; reason: string | null; created_by: string; created_at: Date }>(
      "SELECT service, tag, reason, created_by, created_at FROM observed_image_ignored_tags WHERE host_id = $1 AND project = $2 ORDER BY created_at",
      [hostId, project],
    );
    const out: Record<string, IgnoredTag[]> = {};
    for (const r of rows) (out[r.service] ??= []).push({ tag: r.tag, reason: r.reason, createdBy: r.created_by, createdAt: r.created_at });
    return out;
  }

  async checks(hostId: string, project: string): Promise<ObservedCheckRow[]> {
    const { rows } = await this.pool.query<{
      service: string; checked_at: Date; status: "ok" | "error"; kind: CheckKind | null; detail: CheckDetail | null; error: string | null; last_success_at: Date | null;
    }>("SELECT service, checked_at, status, kind, detail, error, last_success_at FROM observed_image_checks WHERE host_id = $1 AND project = $2", [hostId, project]);
    return rows.map((r) => ({ service: r.service, checkedAt: r.checked_at, status: r.status, kind: r.kind, detail: r.detail, error: r.error, lastSuccessAt: r.last_success_at }));
  }

  /** Dernières vérifications de tous les projets observés (tableau de bord et alertes). */
  async allChecks(): Promise<(ObservedCheckRow & { hostId: string; project: string })[]> {
    const { rows } = await this.pool.query<{
      host_id: string; project: string; service: string; checked_at: Date; status: "ok" | "error"; kind: CheckKind | null; detail: CheckDetail | null; error: string | null; last_success_at: Date | null;
    }>("SELECT host_id, project, service, checked_at, status, kind, detail, error, last_success_at FROM observed_image_checks");
    return rows.map((r) => ({ hostId: r.host_id, project: r.project, service: r.service, checkedAt: r.checked_at, status: r.status, kind: r.kind, detail: r.detail, error: r.error, lastSuccessAt: r.last_success_at }));
  }

  async setPolicy(hostId: string, project: string, service: string, policy: UpdatePolicy, pattern: string | null, actor: string): Promise<void> {
    if (!POLICIES.includes(policy)) throw new HttpError(400, "invalid_policy", "Politique inconnue.");
    if (policy === "pattern") {
      const err = validatePattern(pattern ?? "");
      if (err) throw new HttpError(400, "invalid_pattern", err);
    }
    await this.assertObserved(hostId, project, service);
    await this.pool.query(
      `INSERT INTO observed_image_policies (host_id, project, service, policy, pattern) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (host_id, project, service) DO UPDATE SET policy = $4, pattern = $5, updated_at = now()`,
      [hostId, project, service, policy, policy === "pattern" ? pattern : null],
    );
    await audit(this.pool, actor, "observed-image-policy.set", `${hostId}/${project}/${service}`, "success");
  }

  /** Ne plus proposer cette version : le dernier résultat est corrigé tout de suite, sans interroger le registre. */
  async ignoreTag(hostId: string, project: string, service: string, tag: string, reason: string | null, actor: string): Promise<void> {
    await this.assertObserved(hostId, project, service);
    await this.pool.query(
      `INSERT INTO observed_image_ignored_tags (host_id, project, service, tag, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (host_id, project, service, tag) DO UPDATE SET reason = $5`,
      [hostId, project, service, tag, reason, actor],
    );
    const row = await this.pool.query<{ kind: CheckKind | null; detail: CheckDetail | null }>(
      "SELECT kind, detail FROM observed_image_checks WHERE host_id = $1 AND project = $2 AND service = $3",
      [hostId, project, service],
    );
    const found = row.rows[0];
    if (found?.detail && found.detail.candidates.includes(tag)) {
      const detail: CheckDetail = { ...found.detail, candidates: found.detail.candidates.filter((t) => t !== tag), ignored: [...new Set([...(found.detail.ignored ?? []), tag])] };
      const kind: CheckKind = found.kind === "update_available" && detail.contentChanged !== true && detail.candidates.length === 0 ? "up_to_date" : (found.kind ?? "up_to_date");
      await this.pool.query("UPDATE observed_image_checks SET kind = $4, detail = $5 WHERE host_id = $1 AND project = $2 AND service = $3", [hostId, project, service, kind, JSON.stringify(detail)]);
    }
    await audit(this.pool, actor, "observed-image-tag.ignore", `${hostId}/${project}/${service}@${tag}`, "success");
  }

  async unignoreTag(hostId: string, project: string, service: string, tag: string, actor: string): Promise<void> {
    const r = await this.pool.query("DELETE FROM observed_image_ignored_tags WHERE host_id = $1 AND project = $2 AND service = $3 AND tag = $4", [hostId, project, service, tag]);
    if (r.rowCount === 0) throw new HttpError(404, "ignored_tag_not_found", "Cette version n'est pas ignorée.");
    await audit(this.pool, actor, "observed-image-tag.unignore", `${hostId}/${project}/${service}@${tag}`, "success");
    void this.checkProject(hostId, project).catch(() => {});
  }

  /** Le projet (et le service, s'il est donné) doit exister dans l'inventaire de l'hôte. */
  async assertObserved(hostId: string, project: string, service?: string): Promise<Container[]> {
    const host = await this.pool.query<{ inventory: Container[] | null }>("SELECT inventory FROM hosts WHERE id = $1 AND revoked_at IS NULL", [hostId]);
    if (!host.rows[0]) throw new HttpError(404, "host_not_found", "Hôte introuvable");
    const containers = (host.rows[0].inventory ?? []).filter((c) => c.composeProject === project);
    if (containers.length === 0) throw new HttpError(404, "project_not_found", "Projet introuvable sur cet hôte");
    if (service && !containers.some((c) => c.composeService === service)) throw new HttpError(404, "service_not_found", "Service introuvable dans ce projet");
    return containers;
  }

  /** Vérifie chaque service du projet. Un échec de registre conserve la dernière observation. */
  async checkProject(hostId: string, project: string): Promise<void> {
    const k = key(hostId, project);
    if (this.checking.has(k)) return;
    this.checking.add(k);
    try {
      const [policies, ignored, images] = await Promise.all([
        this.policies(hostId, project),
        this.ignoredTags(hostId, project),
        loadUsedImages(this.pool, { hostId, project }),
      ]);
      const done = new Set<string>();
      for (const img of images) {
        for (const user of img.usedBy) {
          if (!user.service || done.has(user.service)) continue;
          done.add(user.service);
          const policy = policies[user.service] ?? { policy: "same_tag" as const, pattern: null };
          try {
            const out = await evaluateImage(
              { ref: user.ref, imageId: img.imageId, image: img.info, policy: policy.policy, pattern: policy.pattern, ignored: (ignored[user.service] ?? []).map((i) => i.tag) },
              this.client,
            );
            await this.pool.query(
              `INSERT INTO observed_image_checks (host_id, project, service, checked_at, status, kind, detail, error, last_success_at)
               VALUES ($1, $2, $3, now(), 'ok', $4, $5, NULL, now())
               ON CONFLICT (host_id, project, service) DO UPDATE SET checked_at = now(), status = 'ok', kind = $4, detail = $5, error = NULL, last_success_at = now()`,
              [hostId, project, user.service, out.kind, JSON.stringify(out.detail)],
            );
          } catch (err) {
            const message = err instanceof RegistryError ? err.message : "Erreur inattendue lors de la vérification.";
            if (!(err instanceof RegistryError)) this.log.error(err, "vérification d'image observée");
            await this.pool.query(
              `INSERT INTO observed_image_checks (host_id, project, service, checked_at, status, error) VALUES ($1, $2, $3, now(), 'error', $4)
               ON CONFLICT (host_id, project, service) DO UPDATE SET checked_at = now(), status = 'error', error = $4`,
              [hostId, project, user.service, message.slice(0, 500)],
            );
          }
        }
      }
      // Un service qui n'existe plus ne doit pas laisser d'alerte ou de résultat périmé.
      if (done.size > 0) {
        await this.pool.query("DELETE FROM observed_image_checks WHERE host_id = $1 AND project = $2 AND service <> ALL($3::text[])", [hostId, project, [...done]]);
      }
    } finally {
      this.checking.delete(k);
    }
  }

  /** Projets observés (sans stack, hors console) dont la dernière vérification est trop ancienne ou absente. */
  async scheduledPass(now = Date.now()): Promise<number> {
    const { imageCheckIntervalHours } = await getSecuritySettings(this.pool);
    if (imageCheckIntervalHours === 0) return 0;
    const hidden = new Set(await hiddenProjects(this.pool));
    const [hosts, stacks, last] = await Promise.all([
      this.pool.query<{ id: string; inventory: Container[] | null }>("SELECT id, inventory FROM hosts WHERE revoked_at IS NULL"),
      this.pool.query<{ host_id: string; name: string }>("SELECT host_id, name FROM stacks"),
      this.pool.query<{ host_id: string; project: string; last: Date }>("SELECT host_id, project, min(checked_at) AS last FROM observed_image_checks GROUP BY host_id, project"),
    ]);
    const managed = new Set(stacks.rows.map((s) => key(s.host_id, s.name)));
    const lastOf = new Map(last.rows.map((r) => [key(r.host_id, r.project), r.last]));
    let n = 0;
    for (const h of hosts.rows) {
      const projects = new Set((h.inventory ?? []).map((c) => c.composeProject).filter((p): p is string => Boolean(p)));
      for (const project of projects) {
        if (hidden.has(project) || managed.has(key(h.id, project))) continue;
        const l = lastOf.get(key(h.id, project));
        if (l && now - l.getTime() < imageCheckIntervalHours * 3600_000) continue;
        await this.checkProject(h.id, project);
        n++;
      }
    }
    return n;
  }
}
