/**
 * Remédiation des images : règles pures partagées par la console et les tests (éligibilité, nommage, verdict).
 * Le verdict vient toujours d'un nouveau scan de l'image produite, à options identiques : jamais du résumé du moteur
 * (voir docs/adr/0002-remediation-images.md).
 */
import type { PatchScan, PatchVulnerability, Severity } from "./protocol.js";

/** Distributions que le moteur sait corriger (testées au spike). */
export const PATCHABLE_FAMILIES = ["alpine", "debian"] as const;

/** Libellés que le moteur ajoute légitimement à l'image corrigée. */
export const ALLOWED_ADDED_LABELS = ["BaseImage"] as const;

export type RemediationVerdict = "validated" | "partial" | "rejected";

export interface Eligibility {
  eligible: boolean;
  /** Code stable pour l'interface : ok, no_scan, unsupported_os, eol, nothing_fixable, app_only. */
  reason: "ok" | "no_scan" | "unsupported_os" | "eol" | "nothing_fixable" | "app_only";
  message: string;
  /** CVE uniques corrigeables dans les paquets du système (celles que le moteur peut traiter). */
  fixableOs: number;
  /** CVE uniques corrigeables dans des dépendances applicatives (hors périmètre de cette version). */
  fixableApp: number;
  /** CVE uniques sans correctif publié. */
  unfixable: number;
}

const ids = (vs: PatchVulnerability[]): Set<string> => new Set(vs.map((v) => v.id));

/** Éligibilité d'une image d'après son dernier scan réussi. Décidée par la console, avant de lancer le moteur. */
export function patchEligibility(scan: { os?: { family: string; name: string; eosl?: boolean | null } | null; vulnerabilities: PatchVulnerability[]; truncated?: boolean } | null): Eligibility {
  const none = { fixableOs: 0, fixableApp: 0, unfixable: 0 };
  if (!scan) return { eligible: false, reason: "no_scan", message: "Aucun scan réussi : scannez d'abord l'image.", ...none };
  const fixed = scan.vulnerabilities.filter((v) => v.fixed);
  // Un ancien scan ne distingue pas les paquets du système des dépendances : on suppose le système (le correctif réel tranchera).
  const isApp = (v: PatchVulnerability): boolean => v.kind === "lang";
  const fixableOs = ids(fixed.filter((v) => !isApp(v))).size;
  const fixableApp = ids(fixed.filter(isApp)).size;
  const unfixable = [...ids(scan.vulnerabilities)].filter((id) => !fixed.some((v) => v.id === id)).length;
  const counts = { fixableOs, fixableApp, unfixable };
  const family = scan.os?.family?.toLowerCase() ?? "";
  if (!(PATCHABLE_FAMILIES as readonly string[]).includes(family)) {
    return { eligible: false, reason: "unsupported_os", message: family ? `Distribution « ${scan.os?.family} » non prise en charge (Alpine et Debian seulement).` : "Aucun système d'exploitation reconnu dans l'image.", ...counts };
  }
  if (scan.os?.eosl) {
    return { eligible: false, reason: "eol", message: `${scan.os.family} ${scan.os.name} n'est plus maintenue : les correctifs ne sont pas fiables. Migrez vers une version supportée.`, ...counts };
  }
  if (fixableOs === 0) {
    return fixableApp > 0
      ? { eligible: false, reason: "app_only", message: "Les seules vulnérabilités corrigeables sont dans des dépendances applicatives : correction manuelle ou expérimentale, hors périmètre automatique.", ...counts }
      : { eligible: false, reason: "nothing_fixable", message: "Aucune vulnérabilité des paquets du système n'a de correctif publié.", ...counts };
  }
  return { eligible: true, reason: "ok", message: `${fixableOs} CVE des paquets du système ont un correctif publié.`, ...counts };
}

// --- Nommage -----------------------------------------------------------------------------------------

/** Dépôt cible d'une image source (déterministe, sans collision entre registres) : `patched/docker-io-library-alpine`. */
export function patchRepository(registry: string, repository: string): string {
  const slug = `${registry}/${repository}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 150);
  return `patched/${slug || "image"}`;
}

/** Tag de la copie de l'image source dans le registre : identité du contenu local. */
export function sourceCopyTag(imageId: string): string {
  return `src-${imageId.replace(/^sha256:/, "").slice(0, 12)}`;
}

/** Tag immuable d'une image corrigée : `3.22.0-patch.2` (n compté par la console). */
export function patchedTagFor(sourceTag: string | null, n: number): string {
  const base = (sourceTag ?? "latest").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[-.]+/, "").slice(0, 100) || "latest";
  return `${base}-patch.${n}`;
}

// --- Verdict -----------------------------------------------------------------------------------------

export interface BilanVulnerability {
  id: string;
  severity: Severity;
  pkg: string;
  installed: string;
  fixed: string | null;
}

export interface Bilan {
  verdict: RemediationVerdict;
  /** Raisons lisibles du verdict (au moins une quand il n'est pas « validé »). */
  reasons: string[];
  cves: {
    before: number;
    after: number;
    fixableBefore: number;
    resolved: number;
    remainingFixable: number;
    /** Restantes sans correctif publié. */
    unfixable: number;
    new: number;
    newHighOrCritical: number;
  };
  findings: { before: number; after: number };
  resolved: BilanVulnerability[];
  remaining: BilanVulnerability[];
  added: BilanVulnerability[];
  /** Les listes ci-dessus sont plafonnées. */
  truncatedLists: boolean;
}

export interface VerdictInput {
  before: PatchScan;
  after: PatchScan;
  configChanges: string[];
  labelsAdded: string[];
  /** Exige au moins une CVE résolue (défaut). */
  requireNetDecrease?: boolean;
}

const LIST_CAP = 300;
const SEV_RANK: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 };

/** Une entrée par CVE (la plus grave), triée par gravité. */
function byCve(vs: PatchVulnerability[]): Map<string, BilanVulnerability & { anyFixed: boolean }> {
  const out = new Map<string, BilanVulnerability & { anyFixed: boolean }>();
  for (const v of vs) {
    const cur = out.get(v.id);
    const entry = { id: v.id, severity: v.severity, pkg: v.pkg, installed: v.installed, fixed: v.fixed, anyFixed: Boolean(v.fixed) };
    if (!cur) out.set(v.id, entry);
    else {
      cur.anyFixed ||= Boolean(v.fixed);
      if (SEV_RANK[v.severity] < SEV_RANK[cur.severity]) Object.assign(cur, { severity: v.severity, pkg: v.pkg, installed: v.installed, fixed: v.fixed });
    }
  }
  return out;
}

const sorted = (xs: BilanVulnerability[]): BilanVulnerability[] =>
  [...xs].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.id.localeCompare(b.id)).map(({ id, severity, pkg, installed, fixed }) => ({ id, severity, pkg, installed, fixed }));

/**
 * Verdict d'un correctif d'après deux scans comparables.
 *  - refusé : configuration modifiée, libellé inattendu, nouvelle vulnérabilité élevée ou critique, ou aucune amélioration ;
 *  - partiel : des vulnérabilités corrigeables subsistent, ou un rapport est tronqué (comparaison incomplète) ;
 *  - validé : toutes les vulnérabilités corrigeables sont résolues, sans régression.
 */
export function evaluateRemediation(input: VerdictInput): Bilan {
  const before = byCve(input.before.vulnerabilities);
  const after = byCve(input.after.vulnerabilities);
  const fixableBefore = [...before.values()].filter((v) => v.anyFixed);
  const resolved = [...before.values()].filter((v) => !after.has(v.id));
  const remainingFixable = [...after.values()].filter((v) => v.anyFixed);
  const unfixable = [...after.values()].filter((v) => !v.anyFixed);
  const added = [...after.values()].filter((v) => !before.has(v.id));
  const addedSevere = added.filter((v) => v.severity === "CRITICAL" || v.severity === "HIGH");
  const unexpectedLabels = input.labelsAdded.filter((l) => !(ALLOWED_ADDED_LABELS as readonly string[]).includes(l));
  const truncated = Boolean(input.before.truncated || input.after.truncated);

  const reasons: string[] = [];
  let verdict = "validated" as RemediationVerdict;
  const reject = (r: string): void => {
    verdict = "rejected";
    reasons.push(r);
  };
  if (input.configChanges.length > 0) reject(`La configuration de l'image a changé (${input.configChanges.join(", ")}) : refusé par sécurité.`);
  if (unexpectedLabels.length > 0) reject(`Libellés inattendus ajoutés à l'image : ${unexpectedLabels.join(", ")}.`);
  if (addedSevere.length > 0) reject(`${addedSevere.length} nouvelle(s) vulnérabilité(s) élevée(s) ou critique(s) apparue(s) : ${addedSevere.slice(0, 5).map((v) => v.id).join(", ")}${addedSevere.length > 5 ? "…" : ""}.`);
  if ((input.requireNetDecrease ?? true) && resolved.length === 0) reject("Aucune vulnérabilité résolue : le correctif n'apporte aucune amélioration.");
  if (verdict !== "rejected") {
    if (remainingFixable.length > 0) {
      verdict = "partial";
      reasons.push(`${remainingFixable.length} vulnérabilité(s) corrigeable(s) subsistent après le correctif.`);
    }
    if (truncated) {
      verdict = "partial";
      reasons.push("Un des rapports de scan est tronqué : la comparaison est incomplète.");
    }
  }

  return {
    verdict,
    reasons,
    cves: {
      before: before.size,
      after: after.size,
      fixableBefore: fixableBefore.length,
      resolved: resolved.length,
      remainingFixable: remainingFixable.length,
      unfixable: unfixable.length,
      new: added.length,
      newHighOrCritical: addedSevere.length,
    },
    findings: { before: input.before.total, after: input.after.total },
    resolved: sorted(resolved).slice(0, LIST_CAP),
    remaining: sorted([...remainingFixable, ...unfixable]).slice(0, LIST_CAP),
    added: sorted(added).slice(0, LIST_CAP),
    truncatedLists: resolved.length > LIST_CAP || remainingFixable.length + unfixable.length > LIST_CAP || added.length > LIST_CAP,
  };
}
