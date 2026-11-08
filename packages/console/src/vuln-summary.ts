import type { Vulnerability } from "@infra/shared";
import { parseImageRef } from "./image-ref.js";

type Severity = Vulnerability["severity"];

const RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

/** Dépôt d'une image, sans étiquette ni digest (`docker.io/library/ghost`) : portée d'un risque accepté. */
export function repoKey(ref: string): string {
  const parsed = parseImageRef(ref);
  return parsed ? `${parsed.registry}/${parsed.repository}` : ref.split("@")[0]?.replace(/:[^/:]*$/, "").toLowerCase() ?? ref;
}

/** Comparaison de versions tolérante (1.2.10 > 1.2.9, 2.0.0-r1…) : segments numériques comparés comme nombres. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): (string | number)[] => v.split(/[.+~:_-]/).filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

export interface PackageSummary {
  pkg: string;
  installed: string;
  /** Nombre de vulnérabilités de ce paquet qu'une mise à jour corrigerait. */
  fixableCount: number;
  worst: Severity;
  /** Version qui corrige toutes celles-ci (la plus haute indiquée). */
  fixedIn: string;
}

export interface VulnSummary {
  total: number;
  fixable: number;
  /** Sans correctif connu (inclut « ne sera pas corrigée »). */
  unfixable: number;
  willNotFix: number;
  /** Paquets à mettre à jour, les plus graves d'abord. */
  packages: PackageSummary[];
  packagesTruncated: boolean;
}

const MAX_PACKAGES = 25;

/** Corrigeables ou non, et paquets à mettre à jour : de quoi décider « mise à jour » ou « accepter / attendre ». */
export function summarizeVulns(vulns: Pick<Vulnerability, "pkg" | "installed" | "fixed" | "severity" | "status">[]): VulnSummary {
  let fixable = 0;
  let willNotFix = 0;
  const byPkg = new Map<string, PackageSummary>();
  for (const v of vulns) {
    if (!v.fixed) {
      if (v.status === "will_not_fix") willNotFix++;
      continue;
    }
    fixable++;
    const key = `${v.pkg}|${v.installed}`;
    const best = v.fixed.split(",").map((s) => s.trim()).filter(Boolean).sort(compareVersions).pop() ?? v.fixed;
    const cur = byPkg.get(key);
    if (!cur) byPkg.set(key, { pkg: v.pkg, installed: v.installed, fixableCount: 1, worst: v.severity, fixedIn: best });
    else {
      cur.fixableCount++;
      if (RANK[v.severity] > RANK[cur.worst]) cur.worst = v.severity;
      if (compareVersions(best, cur.fixedIn) > 0) cur.fixedIn = best;
    }
  }
  const packages = [...byPkg.values()].sort((a, b) => RANK[b.worst] - RANK[a.worst] || b.fixableCount - a.fixableCount || a.pkg.localeCompare(b.pkg));
  return {
    total: vulns.length,
    fixable,
    unfixable: vulns.length - fixable,
    willNotFix,
    packages: packages.slice(0, MAX_PACKAGES),
    packagesTruncated: packages.length > MAX_PACKAGES,
  };
}
