import { describe, expect, it } from "vitest";
import type { PatchScan, PatchVulnerability as Vulnerability } from "./protocol.js";
import { evaluateRemediation, patchedTagFor, patchEligibility, patchRepository, sourceCopyTag } from "./remediation.js";

const vuln = (id: string, severity: Vulnerability["severity"], fixed: string | null, pkg = "libssl3", extra: Partial<Vulnerability> = {}): Vulnerability => ({
  id, pkg, installed: "1.0", fixed, severity, ...extra,
});
const scan = (vulnerabilities: Vulnerability[], truncated = false): PatchScan => {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const v of vulnerabilities) counts[v.severity.toLowerCase() as keyof typeof counts]++;
  return { counts, total: vulnerabilities.length, vulnerabilities, truncated };
};
const input = (before: Vulnerability[], after: Vulnerability[], over: Partial<Parameters<typeof evaluateRemediation>[0]> = {}) => ({
  before: scan(before), after: scan(after), configChanges: [], labelsAdded: ["BaseImage"], ...over,
});

describe("evaluateRemediation", () => {
  it("valide quand tout ce qui est corrigeable est résolu, sans régression", () => {
    const b = evaluateRemediation(input(
      [vuln("CVE-1", "CRITICAL", "2"), vuln("CVE-1", "CRITICAL", "2", "libcrypto3"), vuln("CVE-2", "LOW", "2"), vuln("CVE-3", "HIGH", null)],
      [vuln("CVE-3", "HIGH", null)],
    ));
    expect(b.verdict).toBe("validated");
    expect(b.reasons).toEqual([]);
    // 2 CVE uniques corrigées (3 constats au total avant), 1 restante non corrigeable.
    expect(b.cves).toMatchObject({ before: 3, after: 1, fixableBefore: 2, resolved: 2, remainingFixable: 0, unfixable: 1, new: 0 });
    expect(b.findings).toEqual({ before: 4, after: 1 });
    expect(b.resolved.map((v) => v.id)).toEqual(["CVE-1", "CVE-2"]);
  });

  it("est partiel quand des vulnérabilités corrigeables subsistent", () => {
    const b = evaluateRemediation(input([vuln("CVE-1", "HIGH", "2"), vuln("CVE-2", "LOW", "2")], [vuln("CVE-2", "LOW", "2")]));
    expect(b.verdict).toBe("partial");
    expect(b.cves).toMatchObject({ resolved: 1, remainingFixable: 1 });
    expect(b.reasons[0]).toContain("subsistent");
  });

  it("est partiel (jamais validé) si un rapport est tronqué", () => {
    const b = evaluateRemediation({ ...input([vuln("CVE-1", "HIGH", "2")], []), after: scan([], true) });
    expect(b.verdict).toBe("partial");
    expect(b.reasons.join(" ")).toContain("tronqué");
  });

  it("refuse une nouvelle vulnérabilité élevée ou critique, mais tolère une nouvelle vulnérabilité faible en la signalant", () => {
    const severe = evaluateRemediation(input([vuln("CVE-1", "HIGH", "2")], [vuln("CVE-9", "CRITICAL", "3")]));
    expect(severe.verdict).toBe("rejected");
    expect(severe.cves).toMatchObject({ new: 1, newHighOrCritical: 1 });
    const mild = evaluateRemediation(input([vuln("CVE-1", "HIGH", "2")], [vuln("CVE-9", "LOW", null)]));
    expect(mild.verdict).toBe("validated");
    expect(mild.added.map((v) => v.id)).toEqual(["CVE-9"]);
  });

  it("refuse tout changement de configuration ou libellé inattendu", () => {
    const base: [Vulnerability[], Vulnerability[]] = [[vuln("CVE-1", "HIGH", "2")], []];
    expect(evaluateRemediation(input(...base, { configChanges: ["Entrypoint", "Env"] })).verdict).toBe("rejected");
    expect(evaluateRemediation(input(...base, { labelsAdded: ["BaseImage", "x.y"] })).verdict).toBe("rejected");
    expect(evaluateRemediation(input(...base, { labelsAdded: ["BaseImage"] })).verdict).toBe("validated");
  });

  it("refuse un correctif sans aucune amélioration, sauf si l'amélioration n'est pas exigée", () => {
    const same: [Vulnerability[], Vulnerability[]] = [[vuln("CVE-1", "HIGH", "2")], [vuln("CVE-1", "HIGH", "2")]];
    const b = evaluateRemediation(input(...same));
    expect(b.verdict).toBe("rejected");
    expect(b.reasons[0]).toContain("aucune amélioration");
    expect(evaluateRemediation(input(...same, { requireNetDecrease: false })).verdict).toBe("partial");
  });

  it("garde la gravité la plus élevée d'une CVE présente dans plusieurs paquets", () => {
    const b = evaluateRemediation(input([vuln("CVE-1", "LOW", "2", "a"), vuln("CVE-1", "HIGH", "2", "b")], []));
    expect(b.resolved).toEqual([expect.objectContaining({ id: "CVE-1", severity: "HIGH", pkg: "b" })]);
  });
});

describe("patchEligibility", () => {
  const os = { family: "alpine", name: "3.22.0", eosl: false };
  it("est éligible pour une Alpine ou Debian supportée avec des correctifs OS", () => {
    const e = patchEligibility({ os, vulnerabilities: [vuln("CVE-1", "HIGH", "2"), vuln("CVE-2", "LOW", null)] });
    expect(e).toMatchObject({ eligible: true, reason: "ok", fixableOs: 1, fixableApp: 0, unfixable: 1 });
    expect(patchEligibility({ os: { family: "debian", name: "12.4" }, vulnerabilities: [vuln("CVE-1", "HIGH", "2")] }).eligible).toBe(true);
  });
  it("refuse sans scan, distribution non prise en charge, fin de vie ou rien de corrigeable", () => {
    expect(patchEligibility(null).reason).toBe("no_scan");
    expect(patchEligibility({ os: { family: "ubuntu", name: "24.04" }, vulnerabilities: [vuln("CVE-1", "HIGH", "2")] }).reason).toBe("unsupported_os");
    expect(patchEligibility({ os: null, vulnerabilities: [vuln("CVE-1", "HIGH", "2")] }).reason).toBe("unsupported_os");
    expect(patchEligibility({ os: { ...os, eosl: true }, vulnerabilities: [vuln("CVE-1", "HIGH", "2")] }).reason).toBe("eol");
    expect(patchEligibility({ os, vulnerabilities: [vuln("CVE-1", "HIGH", null)] }).reason).toBe("nothing_fixable");
  });
  it("distingue les dépendances applicatives : hors périmètre automatique", () => {
    const e = patchEligibility({ os, vulnerabilities: [vuln("GHSA-1", "HIGH", "2", "lodash", { kind: "lang" })] });
    expect(e).toMatchObject({ eligible: false, reason: "app_only", fixableOs: 0, fixableApp: 1 });
    expect(patchEligibility({ os, vulnerabilities: [vuln("GHSA-1", "HIGH", "2", "lodash", { kind: "lang" }), vuln("CVE-1", "HIGH", "2", "x", { kind: "os" })] }).eligible).toBe(true);
  });
});

describe("nommage", () => {
  it("encode de façon déterministe le dépôt d'origine, sans collision entre registres", () => {
    expect(patchRepository("docker.io", "library/alpine")).toBe("patched/docker-io-library-alpine");
    expect(patchRepository("ghcr.io", "acme/app")).toBe("patched/ghcr-io-acme-app");
    expect(patchRepository("registry.exemple.fr:5000", "a/b")).not.toBe(patchRepository("registry.exemple.fr", "5000/a/b").replace("5000-", "x"));
  });
  it("produit des tags valides pour le registre", () => {
    expect(sourceCopyTag("sha256:8a1f59ffb675680d47db6337b49d22281a139e9d")).toBe("src-8a1f59ffb675");
    expect(patchedTagFor("3.22.0", 2)).toBe("3.22.0-patch.2");
    expect(patchedTagFor(null, 1)).toBe("latest-patch.1");
    expect(patchedTagFor("v1/rc 2", 1)).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
  });
});

describe("évaluation avec vérification de démarrage", () => {
  const check = { command: ["nginx", "-t"], expectExit: 0, outputContains: null };
  const run = (ok: boolean, exitCode: number | null = ok ? 0 : 1) => ({ ok, exitCode, timedOut: false, outputMatched: null });
  const base = (verification: Parameters<typeof evaluateRemediation>[0]["verification"]) =>
    evaluateRemediation(input([vuln("CVE-1", "HIGH", "2")], [], { verification }));

  it("sans vérification configurée : aucune mention, verdict inchangé", () => {
    const b = base(undefined);
    expect(b.verification).toBeNull();
    expect(b.verdict).toBe("validated");
  });

  it("réussie sur les deux images : mention positive, verdict inchangé", () => {
    const b = base({ check, source: run(true), patched: run(true) });
    expect(b.verification).toMatchObject({ state: "passed", check });
    expect(b.verdict).toBe("validated");
  });

  it("régression (réussit avant, échoue après) : correctif refusé, avec le code de sortie", () => {
    const b = base({ check, source: run(true), patched: run(false, 127) });
    expect(b.verification?.state).toBe("regression");
    expect(b.verdict).toBe("rejected");
    expect(b.reasons.join(" ")).toContain("Régression détectée");
    expect(b.reasons.join(" ")).toContain("code de sortie 127, attendu 0");
    // Un délai dépassé est signalé comme tel.
    expect(base({ check, source: run(true), patched: { ok: false, exitCode: null, timedOut: true, outputMatched: null } }).reasons.join(" ")).toContain("délai dépassé");
  });

  it("échec sur l'image d'origine : non concluante, sans effet sur le verdict (même si l'image corrigée échoue aussi)", () => {
    for (const patched of [run(true), run(false)]) {
      const b = base({ check, source: run(false), patched });
      expect(b.verification?.state).toBe("inconclusive");
      expect(b.verdict).toBe("validated");
    }
  });

  it("agent ancien (résultats absents) : non effectuée, sans effet sur le verdict", () => {
    const b = base({ check, source: null, patched: null });
    expect(b.verification?.state).toBe("skipped");
    expect(b.verdict).toBe("validated");
  });

  it("la régression s'ajoute aux autres raisons de refus", () => {
    const b = evaluateRemediation(input([vuln("CVE-1", "HIGH", "2")], [], { configChanges: ["Entrypoint"], verification: { check, source: run(true), patched: run(false) } }));
    expect(b.verdict).toBe("rejected");
    expect(b.reasons).toHaveLength(2);
  });
});
