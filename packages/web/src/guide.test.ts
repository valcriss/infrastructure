import { describe, expect, it } from "vitest";
import type { RemediationEligibility, RemediationJob, RemediationTarget } from "./api";
import { currentStep, eligibilityHint, guideSteps, jobHint, registryNextStep, type GuideInput } from "./guide";

const elig = (over: Partial<RemediationEligibility> = {}): RemediationEligibility =>
  ({
    eligible: true, reason: "ok", message: "ok", fixableOs: 3, fixableApp: 0, unfixable: 0, imageId: "sha256:a", platform: "linux/amd64",
    hosts: [{ id: "h1", name: "hôte", online: true, capable: true }], registry: { ready: true, reason: null }, activeJob: null, canStart: true, ...over,
  }) as RemediationEligibility;

const job = (over: Partial<RemediationJob> = {}): RemediationJob =>
  ({ id: "j1", status: "validated", active: false, applied: [], automatic: false, reviewedAt: null, imageDeleted: false, cancelRequested: false, error: null, bilan: null, ...over }) as unknown as RemediationJob;

const target = (over: Partial<RemediationTarget> = {}): RemediationTarget => ({ stackId: "s1", stackName: "shop", service: "web", canApply: true, reason: null, alreadyApplied: false, ...over }) as RemediationTarget;

describe("guidage avant de lancer un correctif", () => {
  it("dit toujours quoi faire quand quelque chose manque, avec un lien quand il y en a un", () => {
    expect(eligibilityHint(elig({ eligible: false, reason: "no_scan" }), true)?.title).toContain("scannez");
    expect(eligibilityHint(elig({ eligible: false, reason: "eol" }), true)?.text).toContain("version supportée");
    expect(eligibilityHint(elig({ eligible: false, reason: "unsupported_os" }), true)?.text).toContain("Alpine et Debian");
    expect(eligibilityHint(elig({ eligible: false, reason: "nothing_fixable" }), true)?.tone).toBe("info");
    expect(eligibilityHint(elig({ eligible: false, reason: "app_only" }), true)?.text).toContain("application");
    const infra = eligibilityHint(elig({ eligible: false, reason: "infrastructure" }), true);
    expect(infra?.tone).toBe("info");
    expect(infra?.text).toContain("dépendance circulaire");
    expect(infra?.text).toContain("version officielle");
    const registry = eligibilityHint(elig({ registry: { ready: false, reason: "L'application registry n'est pas déployée." }, canStart: false }), true);
    expect(registry).toMatchObject({ tone: "warning", to: "/settings?tab=registry" });
    expect(registry?.text).toContain("pas déployée");
  });

  it("distingue un hôte hors ligne d'un agent trop ancien", () => {
    const off = eligibilityHint(elig({ hosts: [{ id: "h", name: "serveur", online: false, capable: true }], canStart: false }), true);
    expect(off?.text).toContain("hors ligne");
    const old = eligibilityHint(elig({ hosts: [{ id: "h", name: "serveur", online: true, capable: false }], canStart: false }), true);
    expect(old?.text).toContain("trop ancien");
    expect(old?.to).toBe("/hosts");
  });

  it("encourage à lancer quand tout est prêt, et explique la lecture seule", () => {
    expect(eligibilityHint(elig(), true)).toMatchObject({ tone: "success", title: expect.stringContaining("lancez") });
    expect(eligibilityHint(elig(), true)?.text).toContain("rien n'est déployé");
    expect(eligibilityHint(elig(), false)?.title).toBe("Lecture seule");
    // Déjà corrigée une fois : l'invite à lancer ne pousse pas, elle propose.
    expect(eligibilityHint(elig(), true, true)).toMatchObject({ tone: "info", title: "Un nouveau correctif est possible" });
    expect(eligibilityHint(elig(), false, true)?.title).toBe("Lecture seule");
    expect(eligibilityHint(null, true)).toBeNull();
    expect(eligibilityHint(elig({ activeJob: { id: "j", status: "patching" } as never }), true)?.title).toContain("déjà en cours");
  });
});

describe("guidage pendant et après le correctif", () => {
  it("rassure pendant l'exécution", () => {
    expect(jobHint(job({ status: "queued", active: true }), [])?.title).toBe("En attente");
    for (const status of ["preparing", "scanning_before", "patching", "scanning_after", "verifying"] as const) {
      expect(jobHint(job({ status, active: true }), [])?.text).toContain("fermer cette fenêtre");
    }
    expect(jobHint(job({ status: "patching", active: true, cancelRequested: true }), [])?.title).toBe("Arrêt demandé");
  });

  it("guide les échecs et les résultats indéterminés vers ce qui se vérifie", () => {
    const failed = jobHint(job({ status: "failed" }), []);
    expect(failed?.tone).toBe("error");
    expect(failed?.text).toContain("Aucun changement n'a été appliqué");
    expect(failed?.text).toContain("BuildKit");
    const unknown = jobHint(job({ status: "unknown", active: true }), []);
    expect(unknown).toMatchObject({ tone: "warning", to: "/settings?tab=registry" });
    expect(unknown?.text).toContain("Abandonner");
    expect(jobHint(job({ status: "cancelled" }), [])?.text).toContain("Images du registre");
  });

  it("explique un refus avec sa première raison, sans rien promettre", () => {
    const rejected = jobHint(job({ status: "rejected", bilan: { reasons: ["Régression détectée : …"] } as never }), []);
    expect(rejected?.tone).toBe("warning");
    expect(rejected?.text).toContain("Régression détectée");
    expect(rejected?.text).toContain("n'est pas modifiée");
  });

  it("propose l'étape suivante d'un correctif validé : utiliser l'image, puis déployer soi-même", () => {
    const use = jobHint(job(), [target()]);
    expect(use).toMatchObject({ tone: "success", title: expect.stringContaining("utiliser l'image corrigée") });
    expect(use?.text).toContain("sans la déployer");
    // Verdict partiel : confirmation explicite annoncée.
    expect(jobHint(job({ status: "partial" }), [target()])).toMatchObject({ tone: "warning" });
    expect(jobHint(job({ status: "partial" }), [target()])?.text).toContain("confirmer explicitement");
    // Une fois la révision créée : le déploiement reste manuel, lien vers l'application.
    const applied = jobHint(job({ applied: [{ stackId: "s1", stackName: "shop", service: "web", revision: 4, by: "x", at: "" }] }), [target({ alreadyApplied: true, canApply: false })]);
    expect(applied).toMatchObject({ title: expect.stringContaining("déployez"), to: "/stacks/s1" });
    expect(applied?.text).toContain("n'est pas déployée");
  });

  it("explique pourquoi aucune application ne peut utiliser l'image, ou qu'aucune ne l'utilise", () => {
    expect(jobHint(job(), [target({ canApply: false, reason: "variable partagée" })])?.title).toContain("pas utilisable");
    expect(jobHint(job(), [])?.title).toContain("aucune application ne l'utilise");
  });

  it("invite à relire un correctif préparé automatiquement", () => {
    expect(jobHint(job({ automatic: true }), [target()])?.text).toContain("préparé automatiquement");
    expect(jobHint(job({ automatic: true, reviewedAt: "2026-11-12T00:00:00Z" }), [target()])?.text).not.toContain("préparé automatiquement");
    expect(jobHint(job({ imageDeleted: true }), [])?.title).toContain("supprimée du registre");
    expect(jobHint(null, [])).toBeNull();
  });
});

describe("parcours d'ensemble", () => {
  const input = (over: Partial<GuideInput> = {}): GuideInput => ({ registry: null, scannedImages: 0, jobs: 0, toReview: 0, applied: 0, ...over });
  const ready = { traefik: { available: true, deployed: true }, application: { deployed: true }, separated: true };

  it("commence par la mise en place du registre, puis passe aux étapes d'usage", () => {
    expect(currentStep(guideSteps(input()))?.id).toBe("traefik");
    expect(currentStep(guideSteps(input({ registry: { traefik: { available: true, deployed: true }, application: null, separated: false } })))?.id).toBe("registry");
    expect(currentStep(guideSteps(input({ registry: ready })))?.id).toBe("scan");
    expect(currentStep(guideSteps(input({ registry: ready, scannedImages: 2 })))?.id).toBe("patch");
    expect(currentStep(guideSteps(input({ registry: ready, scannedImages: 2, jobs: 1, toReview: 1 })))?.id).toBe("review");
    expect(currentStep(guideSteps(input({ registry: ready, scannedImages: 2, jobs: 1 })))?.id).toBe("apply");
    expect(currentStep(guideSteps(input({ registry: ready, scannedImages: 2, jobs: 1, applied: 1 })))).toBeNull();
  });

  it("conseille de séparer les comptes, et rappelle que le déploiement reste manuel", () => {
    const steps = guideSteps(input({ registry: { ...ready, separated: false } }));
    expect(steps.find((s) => s.id === "registry")?.text).toContain("Séparer les comptes");
    expect(steps.find((s) => s.id === "deploy")?.text).toContain("action explicite");
  });
});

describe("prochaine étape de la page Registry", () => {
  const base = { traefik: { available: true, deployed: true, production: true }, hasApplication: true, deployed: true, separated: true, managed: true };
  const ok = { ok: true };
  const probe = (over: Record<string, unknown> = {}) => ({ ready: true, dns: ok, tls: ok, anonymous: ok, authenticated: ok, ...over }) as never;

  it("suit la mise en place dans l'ordre", () => {
    expect(registryNextStep({ ...base, traefik: { available: false } }, null).title).toContain("Étape 1");
    expect(registryNextStep({ ...base, hasApplication: false, deployed: false }, null).title).toContain("Étape 2");
    expect(registryNextStep({ ...base, deployed: false }, null).title).toContain("Étape 3");
    expect(registryNextStep(base, null).title).toContain("Étape 4");
    expect(registryNextStep({ ...base, separated: false }, probe()).title).toContain("Étape 5");
    expect(registryNextStep(base, probe())).toMatchObject({ tone: "success", to: "/images" });
  });

  it("dit comment corriger chaque échec du test d'accès", () => {
    expect(registryNextStep(base, probe({ ready: false, dns: { ok: false } })).text).toContain("DNS");
    expect(registryNextStep(base, probe({ ready: false, tls: { ok: false } })).text).toContain("production");
    expect(registryNextStep(base, probe({ ready: false, anonymous: { ok: false } })).text).toContain("déployée");
    expect(registryNextStep(base, probe({ ready: false, authenticated: { ok: false } })).text).toContain("redéployez");
    expect(registryNextStep(base, probe({ ready: false, pullWriteDenied: { ok: false } })).text).toContain("routeur d'écriture");
  });
});
