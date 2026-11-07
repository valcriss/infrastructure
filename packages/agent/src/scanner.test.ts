import { MAX_SCAN_VULNERABILITIES } from "@infra/shared";
import { describe, expect, it } from "vitest";
import { parseImage } from "./docker.js";
import { maxImageBytes } from "./config.js";
import { normalizeReport, parseTrivyVersion, scanSizeError, trivyRunArgs } from "./scanner.js";

const vuln = (id: string, severity: string, pkg = "openssl", extra: Record<string, unknown> = {}) => ({
  VulnerabilityID: id,
  PkgName: pkg,
  InstalledVersion: "1.0",
  FixedVersion: "1.1",
  Severity: severity,
  Title: `Titre ${id}`,
  PrimaryURL: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
  Status: "fixed",
  ...extra,
});

describe("normalizeReport", () => {
  it("compte par gravité, trie du plus grave au moins grave et conserve l'OS", () => {
    const r = normalizeReport({
      Metadata: { OS: { Family: "alpine", Name: "3.12.12", EOSL: true }, ImageConfig: { Env: ["SECRET=ne-doit-pas-sortir"] } },
      Results: [{ Vulnerabilities: [vuln("CVE-3", "LOW"), vuln("CVE-1", "CRITICAL"), vuln("CVE-2", "HIGH"), vuln("CVE-4", "MEDIUM"), vuln("CVE-5", "bizarre")] }],
    });
    expect(r.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 1, unknown: 1 });
    expect(r.vulnerabilities.map((v) => v.id)).toEqual(["CVE-1", "CVE-2", "CVE-4", "CVE-3", "CVE-5"]);
    expect(r.os).toEqual({ family: "alpine", name: "3.12.12", eosl: true });
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(false);
    // La configuration de l'image (variables d'environnement) n'est jamais reprise.
    expect(JSON.stringify(r)).not.toContain("ne-doit-pas-sortir");
  });

  it("distingue « aucune vulnérabilité » d'un rapport vide invalide", () => {
    const clean = normalizeReport({ Results: [{ Target: "x", Vulnerabilities: null }] });
    expect(clean).toMatchObject({ total: 0, truncated: false, counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } });
    expect(normalizeReport(null).total).toBe(0);
  });

  it("dédoublonne et tolère des champs absents", () => {
    const r = normalizeReport({ Results: [{ Vulnerabilities: [vuln("CVE-1", "HIGH"), vuln("CVE-1", "HIGH"), { VulnerabilityID: "CVE-9", Severity: "LOW" }, { Severity: "HIGH" }] }] });
    expect(r.total).toBe(2);
    expect(r.vulnerabilities.find((v) => v.id === "CVE-9")).toMatchObject({ pkg: "", fixed: null, url: null, title: "" });
  });

  it("borne la liste détaillée mais garde des compteurs exacts", () => {
    const many = Array.from({ length: MAX_SCAN_VULNERABILITIES + 50 }, (_, i) => vuln(`CVE-${String(i).padStart(5, "0")}`, "LOW"));
    const r = normalizeReport({ Results: [{ Vulnerabilities: many }] });
    expect(r.vulnerabilities).toHaveLength(MAX_SCAN_VULNERABILITIES);
    expect(r.truncated).toBe(true);
    expect(r.counts.low).toBe(MAX_SCAN_VULNERABILITIES + 50);
  });

  it("tronque les textes trop longs", () => {
    const r = normalizeReport({ Results: [{ Vulnerabilities: [vuln("CVE-1", "HIGH", "p", { Title: "x".repeat(1000) })] }] });
    expect(r.vulnerabilities[0]?.title).toHaveLength(300);
  });
});

describe("parseTrivyVersion", () => {
  it("lit la version et la fraîcheur de la base", () => {
    expect(
      parseTrivyVersion({ Version: "0.76.1", VulnerabilityDB: { Version: 2, UpdatedAt: "2026-11-06T18:59:52Z", DownloadedAt: "2026-11-06T20:20:47Z" } }),
    ).toEqual({ version: "0.76.1", dbVersion: 2, dbUpdatedAt: "2026-11-06T18:59:52Z", dbDownloadedAt: "2026-11-06T20:20:47Z" });
    expect(parseTrivyVersion({})).toEqual({ version: "inconnue" });
  });
});

describe("parseImage", () => {
  it("extrait digests de registre, plateforme et taille", () => {
    expect(
      parseImage({ Id: "sha256:abc", RepoTags: ["nginx:1.27"], RepoDigests: ["nginx@sha256:def"], Size: 123, Os: "linux", Architecture: "amd64", Variant: "" }),
    ).toEqual({ id: "sha256:abc", repoTags: ["nginx:1.27"], repoDigests: ["nginx@sha256:def"], size: 123, os: "linux", arch: "amd64" });
  });
  it("reconnaît une image locale (sans digest de registre) et rejette une réponse invalide", () => {
    expect(parseImage({ Id: "sha256:abc", RepoTags: ["monimage:dev"], RepoDigests: [], Size: 5 })?.repoDigests).toEqual([]);
    expect(parseImage({})).toBeNull();
    expect(parseImage(null)).toBeNull();
  });
});

describe("trivyRunArgs", () => {
  const args = trivyRunArgs({ trivyImage: "ghcr.io/aquasecurity/trivy:0.76.1", cacheVolume: "cache", memory: "2g" }, "/ws/.scan-1", "scan-1");

  it("garde toutes les restrictions du conteneur Trivy", () => {
    expect(args).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--read-only", "--security-opt", "no-new-privileges", "--memory", "2g"]));
    expect(args.join(" ")).not.toContain("docker.sock");
  });

  it("dirige les gros fichiers temporaires (base Java) vers le dossier du scan, sur disque, et non vers la mémoire", () => {
    const i = args.indexOf("-e");
    expect(args[i + 1]).toBe("TMPDIR=/scan/tmp");
    expect(args).toContain("/ws/.scan-1:/scan"); // le dossier du scan est monté et supprimé après le scan
  });
});

describe("scanSizeError", () => {
  const GIB = 1024 ** 3;

  it("accepte une image de 5,4 Gio avec la limite par défaut de 10 Gio (le cas qui échouait avec 5 Gio)", () => {
    expect(scanSizeError(5568 * 1e6, maxImageBytes({}), 100 * GIB)).toBeNull();
  });

  it("refuse une image trop grosse et indique comment relever la limite", () => {
    const e = scanSizeError(12 * GIB, 10 * GIB, 100 * GIB);
    expect(e).toContain("trop volumineuse");
    expect(e).toContain("TRIVY_MAX_IMAGE_GB");
  });

  it("refuse tout de suite quand la partition n'a pas la place d'exporter l'image, au lieu d'échouer en plein scan", () => {
    const e = scanSizeError(5 * GIB, 10 * GIB, 6 * GIB);
    expect(e).toContain("Espace disque insuffisant");
    expect(e).toContain("6,0 Gio libres");
    expect(scanSizeError(5 * GIB, 10 * GIB, null)).toBeNull(); // espace indéterminé : on laisse faire
  });
});

describe("maxImageBytes", () => {
  it("lit TRIVY_MAX_IMAGE_GB, puis l'ancienne variable en octets, puis 10 Gio", () => {
    expect(maxImageBytes({ TRIVY_MAX_IMAGE_GB: "20" })).toBe(20 * 1024 ** 3);
    expect(maxImageBytes({ TRIVY_MAX_IMAGE_GB: "1.5" })).toBe(1.5 * 1024 ** 3);
    expect(maxImageBytes({ TRIVY_MAX_IMAGE_BYTES: "123456" })).toBe(123456);
    expect(maxImageBytes({ TRIVY_MAX_IMAGE_GB: "abc" })).toBe(10 * 1024 ** 3);
    expect(maxImageBytes({})).toBe(10 * 1024 ** 3);
  });
});
