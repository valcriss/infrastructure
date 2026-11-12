import { ComposeEditError, RESERVED_STACK_NAMES, composeServiceImage, editServiceImageRef, editServiceImageVariable, effectiveImageValue, serviceImageVariable } from "@infra/shared";
import { audit, type Pool } from "./db.js";
import { HttpError } from "./http-error.js";
import { loadUsedImages } from "./images.js";
import { getRegistrySettings } from "./registry-app-routes.js";
import { INFRASTRUCTURE_TARGET_REASON, infrastructureStacks } from "./remediation-infra.js";
import type { JobView, RemediationService } from "./remediation.js";
import { changeStack, getRevision } from "./stacks.js";

/** Service d'une application qui utilise exactement l'image corrigée par ce job. */
export interface StackTarget {
  stackId: string;
  stackName: string;
  service: string;
  hostId: string;
  hostName: string;
  currentRevision: number;
  deployedRevision: number | null;
  /** Image écrite dans le Compose de la révision courante (peut être une variable : `${NOM:-défaut}`). */
  currentImage: string | null;
  /**
   * « image » : l'image est écrite en clair, le Compose change ; « variable » : l'image est portée par une variable de la
   * stack, seule cette variable change (le Compose reste identique).
   */
  mode: "image" | "variable";
  /** Nom de la variable qui porte l'image (mode « variable »). */
  variable: string | null;
  /** Image réellement utilisée après interpolation (variable ou défaut), si elle est connue. */
  effectiveImage: string | null;
  canApply: boolean;
  /** Pourquoi l'image corrigée ne peut pas être proposée à ce service (null si elle le peut). */
  reason: string | null;
  /** Ce service utilise déjà l'image corrigée dans sa révision courante. */
  alreadyApplied: boolean;
}

export interface ApplyRequest {
  stackId: string;
  service: string;
  expectedRevision: number;
  /** Confirmation explicite quand des vulnérabilités corrigeables subsistent (verdict « partiel »). */
  acceptPartial?: boolean | undefined;
  message?: string | undefined;
}

export interface Preview {
  /** Texte avant / après : le Compose (mode « image ») ou les variables de la stack (mode « variable »). */
  before: string;
  after: string;
  from: string;
  to: string;
  mode: "image" | "variable";
  /** Ce que montre le texte avant / après. */
  subject: "compose" | "variables";
  variable: string | null;
}

/** Variables de la stack en `NOM=valeur` (les valeurs sensibles sont masquées), pour l'aperçu. */
export function renderVariables(vars: Record<string, { value: string; sensitive: boolean }>): string {
  return Object.keys(vars).sort().map((k) => `${k}=${vars[k]!.sensitive ? "••••••••" : vars[k]!.value}`).join("\n") + "\n";
}

/**
 * Proposition de l'image corrigée à une application gérée : une NOUVELLE révision qui ne modifie que la référence
 * d'image du service. La révision n'est jamais déployée ici ; protections, verrous et déploiement restent ceux du flux
 * existant. Seuls les services dont l'image en cours est exactement celle qui a été corrigée sont concernés.
 */
export class RemediationApply {
  constructor(
    private readonly pool: Pool,
    private readonly remediation: Pick<RemediationService, "get">,
  ) {}

  private async usable(id: string): Promise<JobView & { patchedRef: string }> {
    const job = await this.remediation.get(id);
    if (!job) throw new HttpError(404, "remediation_not_found", "Correctif introuvable.");
    if (job.status !== "validated" && job.status !== "partial") {
      throw new HttpError(409, "remediation_not_usable", job.active ? "Ce correctif n'est pas terminé." : `Ce correctif est « ${job.status} » : son image ne peut pas être utilisée.`);
    }
    if (job.imageDeleted) throw new HttpError(409, "remediation_not_usable", "L'image corrigée a été supprimée du registre : relancez un correctif.");
    if (!job.patchedRef) throw new HttpError(409, "remediation_not_usable", "Ce correctif n'a pas produit d'image.");
    return job as JobView & { patchedRef: string };
  }

  async targets(id: string): Promise<{ patchedRef: string; verdict: JobView["status"]; targets: StackTarget[]; registryReady: boolean }> {
    const job = await this.usable(id);
    const settings = await getRegistrySettings(this.pool);
    const registryReady = settings?.host === job.registry;
    const img = (await loadUsedImages(this.pool)).find((i) => i.imageId === job.imageId && i.platform === job.platform);
    const infra = await infrastructureStacks(this.pool);
    const seen = new Set<string>();
    const targets: StackTarget[] = [];
    for (const u of img?.usedBy ?? []) {
      if (!u.stackId || !u.stackName || !u.service) continue;
      const key = `${u.stackId}/${u.service}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const stack = await this.pool.query<{ current_revision: number; deployed_revision: number | null; managed_by: string | null }>(
        "SELECT current_revision, deployed_revision, managed_by FROM stacks WHERE id = $1",
        [u.stackId],
      );
      const s = stack.rows[0];
      if (!s) continue;
      const rev = await getRevision(this.pool, u.stackId, s.current_revision);
      const currentImage = rev ? composeServiceImage(rev.compose, u.service) : null;
      const imageVar = rev ? serviceImageVariable(rev.compose, u.service) : null;
      const effectiveImage = imageVar && rev ? effectiveImageValue(imageVar, rev.variables) : currentImage;
      const alreadyApplied = effectiveImage === job.patchedRef;
      let reason: string | null = null;
      if (RESERVED_STACK_NAMES.includes(u.stackName)) reason = "La console et son agent ne sont pas modifiés depuis leur propre interface.";
      else if (infra.has(u.stackId)) reason = INFRASTRUCTURE_TARGET_REASON;
      else if (s.managed_by) reason = `Application générée et entretenue par la console (${s.managed_by}) : son contenu n'est pas modifiable à la main.`;
      else if (!registryReady) reason = "Le registre privé qui héberge cette image n'est plus configuré : le déploiement ne pourrait pas la télécharger.";
      else if (!rev) reason = "Révision courante introuvable.";
      else if (alreadyApplied) reason = "Ce service utilise déjà cette image corrigée.";
      else {
        try {
          if (imageVar) editServiceImageVariable(rev.compose, u.service, job.patchedRef, rev.variables);
          else editServiceImageRef(rev.compose, u.service, job.patchedRef);
        } catch (err) {
          if (!(err instanceof ComposeEditError)) throw err;
          reason = err.message;
        }
      }
      targets.push({
        stackId: u.stackId, stackName: u.stackName, service: u.service, hostId: u.hostId, hostName: u.hostName,
        currentRevision: s.current_revision, deployedRevision: s.deployed_revision, currentImage,
        mode: imageVar ? "variable" : "image", variable: imageVar?.name ?? null, effectiveImage,
        canApply: reason === null, reason, alreadyApplied,
      });
    }
    return { patchedRef: job.patchedRef, verdict: job.status, targets, registryReady };
  }

  /** Cible valide pour la demande, ou une HttpError qui dit pourquoi pas. */
  private async resolve(id: string, req: ApplyRequest): Promise<{ job: JobView & { patchedRef: string }; target: StackTarget }> {
    const job = await this.usable(id);
    const { targets } = await this.targets(id);
    const target = targets.find((t) => t.stackId === req.stackId && t.service === req.service);
    if (!target) throw new HttpError(409, "not_a_target", "Ce service n'utilise pas l'image qui a été corrigée.");
    if (!target.canApply) throw new HttpError(409, "target_not_applicable", target.reason ?? "L'image corrigée ne peut pas être proposée à ce service.");
    if (job.status === "partial" && !req.acceptPartial) {
      throw new HttpError(409, "partial_requires_confirmation", "Des vulnérabilités corrigeables subsistent dans cette image : confirmez explicitement pour l'utiliser.");
    }
    return { job, target };
  }

  async preview(id: string, req: ApplyRequest): Promise<Preview> {
    const { job } = await this.resolve(id, req);
    const stack = await this.pool.query<{ current_revision: number }>("SELECT current_revision FROM stacks WHERE id = $1", [req.stackId]);
    if (stack.rows[0]?.current_revision !== req.expectedRevision) throw new HttpError(409, "revision_conflict", "La stack a une révision plus récente : rechargez la page.");
    const rev = await getRevision(this.pool, req.stackId, req.expectedRevision);
    if (!rev) throw new Error("révision courante introuvable");
    if (serviceImageVariable(rev.compose, req.service)) {
      const out = this.editVariable(rev.compose, req.service, job.patchedRef, rev.variables);
      return { before: renderVariables(rev.variables), after: renderVariables(out.variables), from: out.from ?? "(aucune valeur)", to: out.to, mode: "variable", subject: "variables", variable: out.name };
    }
    const out = this.edit(rev.compose, req.service, job.patchedRef);
    return { before: rev.compose, after: out.compose, from: out.from, to: out.to, mode: "image", subject: "compose", variable: null };
  }

  async apply(id: string, req: ApplyRequest, actor: string): Promise<{ revision: number; changed: boolean; stackId: string }> {
    const { job, target } = await this.resolve(id, req);
    const result = await changeStack(
      this.pool,
      req.stackId,
      req.expectedRevision,
      actor,
      req.message ?? (target.mode === "variable" ? `Variable ${target.variable} (service ${req.service}) : image corrigée (${job.patchedTag})` : `Image du service ${req.service} : image corrigée (${job.patchedTag})`),
      // Le mode est recalculé sur le contenu courant de la transaction : jamais d'après un état périmé.
      (c) =>
        serviceImageVariable(c.compose, req.service)
          ? { ...c, variables: this.editVariable(c.compose, req.service, job.patchedRef, c.variables).variables }
          : { ...c, compose: this.edit(c.compose, req.service, job.patchedRef).compose },
    );
    await this.pool.query("UPDATE remediation_jobs SET applied = applied || $2::jsonb WHERE id = $1", [
      id,
      JSON.stringify([{ stackId: req.stackId, stackName: target.stackName, service: req.service, revision: result.revision, by: actor, at: new Date().toISOString() }]),
    ]);
    await audit(this.pool, actor, "remediation.apply", `${id} ${target.stackName}/${req.service}@${result.revision}`, "success");
    return { ...result, stackId: req.stackId };
  }

  private editVariable(compose: string, service: string, ref: string, variables: Record<string, { value: string; sensitive: boolean }>): ReturnType<typeof editServiceImageVariable> {
    try {
      return editServiceImageVariable(compose, service, ref, variables);
    } catch (err) {
      if (err instanceof ComposeEditError) {
        throw new HttpError(err.code === "service_not_found" ? 404 : 422, err.code === "service_not_found" ? "service_not_found" : "unsupported_compose_structure", err.message);
      }
      throw err;
    }
  }

  private edit(compose: string, service: string, ref: string): { compose: string; from: string; to: string } {
    try {
      return editServiceImageRef(compose, service, ref);
    } catch (err) {
      if (err instanceof ComposeEditError) {
        throw new HttpError(err.code === "service_not_found" ? 404 : 422, err.code === "service_not_found" ? "service_not_found" : "unsupported_compose_structure", err.message);
      }
      throw err;
    }
  }
}
