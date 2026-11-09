import { MAX_SCAN_VULNERABILITIES } from "@infra/shared";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as docker from "./docker.js";
import * as exec from "./exec.js";
import { parseImage } from "./docker.js";
import { maxImageBytes } from "./config.js";
import { normalizeReport, parseTrivyVersion, scanSizeError, TrivyScanner, trivyProxyEnv, trivyRunArgs } from "./scanner.js";

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

  describe("trivyProxyEnv", () => {
    const cfg = { trivyImage: "trivy:test", cacheVolume: "cache", memory: "2g" };

    it("transmet les six variantes sans changer leur casse ni leur valeur", () => {
      const proxy = {
        HTTP_PROXY: "http://user:secret@proxy:3128",
        HTTPS_PROXY: "http://secure-proxy:3128",
        NO_PROXY: "localhost,.internal",
        http_proxy: "http://lower-proxy:8080",
        https_proxy: "http://lower-secure-proxy:8080",
        no_proxy: "127.0.0.1",
      };
      const env = { ...proxy, SECRET: "private", ALL_PROXY: "socks5://other:1080" };
      expect(trivyProxyEnv(env)).toEqual(proxy);
      const args = trivyRunArgs(cfg, "/scan", "scan-test", env);
      for (const name of Object.keys(proxy)) {
        expect(args[args.indexOf(name) - 1]).toBe("-e");
        expect(args.indexOf(name)).toBeLessThan(args.indexOf(cfg.trivyImage));
      }
      for (const value of Object.values(proxy)) expect(args).not.toContain(value);
      expect(args).not.toContain("SECRET");
      expect(args).not.toContain("ALL_PROXY");
    });

    it.each(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"])("transmet aussi %s seule", (name) => {
      expect(trivyProxyEnv({ [name]: "value" })).toEqual({ [name]: "value" });
      expect(trivyRunArgs(cfg, "/scan", "scan-test", { [name]: "value" })).toContain(name);
    });

    it("ne transmet aucune variable absente et preserve les valeurs vides explicites", () => {
      expect(trivyProxyEnv({ HTTP_PROXY: undefined })).toEqual({});
      expect(trivyProxyEnv({ NO_PROXY: "" })).toEqual({ NO_PROXY: "" });
      expect(trivyRunArgs(cfg, "/scan", "scan-test", {})).toEqual([
        "run", "--rm", "--name", "scan-test",
        "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges",
        "--read-only", "--tmpfs", "/tmp:rw,size=512m",
        "-e", "TMPDIR=/scan/tmp",
        "--memory", "2g", "--pids-limit", "512",
        "-v", "/scan:/scan", "-v", "cache:/cache", "trivy:test",
      ]);
    });

    it("fournit les valeurs a Docker et les noms aux deux conteneurs Trivy", async () => {
      const root = await mkdtemp(join(tmpdir(), "infra-proxy-test-"));
      const proxy = {
        HTTP_PROXY: "http://user:secret@proxy:3128", HTTPS_PROXY: "http://proxy:3128", NO_PROXY: ".internal",
        http_proxy: "http://lower:8080", https_proxy: "http://lower:8080", no_proxy: "localhost",
      };
      for (const [name, value] of Object.entries(proxy)) vi.stubEnv(name, value);
      vi.stubEnv("UNRELATED_SECRET", "private");
      vi.spyOn(docker, "dockerGet").mockResolvedValue({ Size: 1 });
      const run = vi.spyOn(exec, "runCommand").mockImplementation(async (_file, args) => {
        if (args.includes("--input")) {
          await writeFile(join(root, ".scan-proxy-test", "result.json"), JSON.stringify({ Results: [] }));
        }
        return { stdout: args.includes("version") ? '{"Version":"test"}' : "", code: 0, timedOut: false, stderr: "" };
      });
      try {
        const scanner = new TrivyScanner({
          ...cfg, workspaceDir: root, dockerSocket: "/var/run/docker.sock",
          maxImageBytes: 1024, timeoutMs: 60_000,
        });
        expect(await scanner.scan({ type: "scan", scanId: "proxy-test", imageId: "sha256:test", imageRef: "test" })).toMatchObject({ status: "succeeded", trivy: { version: "test" } });
        const containers = run.mock.calls.filter(([, args]) => args[0] === "run");
        expect(containers).toHaveLength(2);
        for (const [, args, options] of containers) {
          expect(options.env).toMatchObject(proxy);
          expect(options.env).not.toHaveProperty("UNRELATED_SECRET");
          for (const [name, value] of Object.entries(proxy)) {
            expect(args[args.indexOf(name) - 1]).toBe("-e");
            expect(args).not.toContain(value);
          }
        }
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    });
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
