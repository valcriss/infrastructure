import { describe, expect, it } from "vitest";
import { localRepoDigest, normalizeRegistry, parseImageRef, platformOf } from "./image-ref.js";
import { parseTag, pickCandidates, validatePattern } from "./image-tags.js";

const D = "sha256:" + "a".repeat(64);

describe("parseImageRef", () => {
  it("normalise les références du Docker Hub", () => {
    expect(parseImageRef("nginx")).toMatchObject({ registry: "docker.io", apiHost: "registry-1.docker.io", repository: "library/nginx", tag: "latest", dockerHub: true });
    expect(parseImageRef("nginx:1.27-alpine")).toMatchObject({ repository: "library/nginx", tag: "1.27-alpine" });
    expect(parseImageRef("bitnami/redis:7")).toMatchObject({ repository: "bitnami/redis", tag: "7", registry: "docker.io" });
    expect(parseImageRef("docker.io/library/alpine:3.20")).toMatchObject({ repository: "library/alpine", registry: "docker.io" });
  });

  it("reconnaît registres tiers, ports et localhost", () => {
    expect(parseImageRef("ghcr.io/org/app:v1")).toMatchObject({ registry: "ghcr.io", apiHost: "ghcr.io", repository: "org/app", tag: "v1", dockerHub: false });
    expect(parseImageRef("registry.local:5000/team/app:2.0")).toMatchObject({ registry: "registry.local:5000", repository: "team/app", tag: "2.0" });
    expect(parseImageRef("localhost:5000/app")).toMatchObject({ registry: "localhost:5000", repository: "app", tag: "latest" });
    expect(parseImageRef("localhost/app:1")).toMatchObject({ registry: "localhost", repository: "app" });
  });

  it("gère les digests (image épinglée)", () => {
    expect(parseImageRef(`nginx@${D}`)).toMatchObject({ tag: null, digest: D, repository: "library/nginx" });
    expect(parseImageRef(`ghcr.io/o/a:1.0@${D}`)).toMatchObject({ tag: "1.0", digest: D });
  });

  it("rejette les références invalides et les identifiants bruts", () => {
    for (const bad of ["", "sha256:" + "a".repeat(64), "UPPER/case", "a b", "nginx:", "nginx@sha256:xyz", "-x", "a//b"]) {
      expect(parseImageRef(bad), bad).toBeNull();
    }
  });
});

describe("normalizeRegistry", () => {
  it("unifie les alias du Docker Hub et valide la forme", () => {
    expect(normalizeRegistry("Index.Docker.io")).toBe("docker.io");
    expect(normalizeRegistry("GHCR.io")).toBe("ghcr.io");
    expect(normalizeRegistry("reg.local:5000")).toBe("reg.local:5000");
    expect(normalizeRegistry("https://x")).toBeNull();
    expect(normalizeRegistry("a b")).toBeNull();
  });
});

describe("digest local et plateforme", () => {
  const ref = parseImageRef("nginx:1.27") as NonNullable<ReturnType<typeof parseImageRef>>;
  it("retrouve le digest de registre du bon dépôt, pas d'un autre", () => {
    expect(localRepoDigest({ repoDigests: [`nginx@${D}`] }, ref)).toBe(D);
    expect(localRepoDigest({ repoDigests: [`ghcr.io/o/nginx@${D}`] }, ref)).toBeNull();
    expect(localRepoDigest({ repoDigests: [] }, ref)).toBeNull(); // image locale sans registre
  });
  it("formate la plateforme", () => {
    expect(platformOf({ os: "linux", arch: "arm64", variant: "v8" })).toBe("linux/arm64/v8");
    expect(platformOf({})).toBe("");
  });
});

describe("parseTag", () => {
  it("lit les tags de version et leur variante", () => {
    expect(parseTag("1.27.3-alpine")).toMatchObject({ nums: [1, 27, 3], suffix: "-alpine", prefix: "", prerelease: false });
    expect(parseTag("v2.1")).toMatchObject({ nums: [2, 1], prefix: "v" });
    expect(parseTag("7")).toMatchObject({ nums: [7], suffix: "" });
    expect(parseTag("1.0.0-rc1")?.prerelease).toBe(true);
    expect(parseTag("2.0-beta.2")?.prerelease).toBe(true);
    expect(parseTag("1.27-alpine")?.prerelease).toBe(false);
  });
  it("refuse ce qui n'est pas une version : latest, stable, dates, noms de distribution", () => {
    for (const t of ["latest", "stable", "bookworm", "20241106", "alpine", "main"]) expect(parseTag(t), t).toBeNull();
  });
});

const TAGS = ["1.25.3", "1.26.0", "1.26.2", "1.27.0", "1.27.1", "1.27.2", "1.28.0", "2.0.0", "2.0.0-rc1", "2.1.0-beta", "1.27.3-alpine", "1.28.0-alpine", "latest", "stable"];

describe("pickCandidates — politiques", () => {
  it("patch : même mineure, patch supérieur, même variante, sans préversion", () => {
    expect(pickCandidates("1.27.0", TAGS, "patch").candidates).toEqual(["1.27.2", "1.27.1"]);
    expect(pickCandidates("1.27.0-alpine", [...TAGS, "1.27.5-alpine"], "patch").candidates).toEqual(["1.27.5-alpine", "1.27.3-alpine"]);
  });
  it("minor : même majeure ; major : tout ce qui est plus récent", () => {
    expect(pickCandidates("1.26.0", TAGS, "minor").candidates).toEqual(["1.28.0", "1.27.2", "1.27.1", "1.27.0", "1.26.2"]);
    expect(pickCandidates("1.27.0", TAGS, "major").candidates[0]).toBe("2.0.0");
    expect(pickCandidates("1.27.0", TAGS, "major").candidates).not.toContain("2.1.0-beta");
  });
  it("same_tag ne propose aucun tag", () => {
    expect(pickCandidates("1.27.0", TAGS, "same_tag")).toEqual({ candidates: [], uncertain: false, notes: [] });
  });
  it("garde les préversions si le tag actuel en est une", () => {
    expect(pickCandidates("2.0.0-rc1", ["2.0.0-rc2", "2.0.0-rc3", "2.0.0"], "patch").candidates).toContain("2.0.0-rc2");
  });
  it("ne compare que des tags de même précision : un tag flottant 1.27 ne propose pas 1.27.3", () => {
    const r = pickCandidates("1.27", ["1.27.3", "1.28", "1.29"], "minor");
    expect(r.candidates).toEqual(["1.29", "1.28"]);
    expect(pickCandidates("1.27", ["1.27.3"], "patch").notes[0]).toContain("niveau patch");
  });
  it("trie numériquement, pas alphabétiquement (1.10 > 1.9)", () => {
    expect(pickCandidates("1.8.0", ["1.9.0", "1.10.0", "1.11.0"], "minor").candidates).toEqual(["1.11.0", "1.10.0", "1.9.0"]);
  });
});

describe("pickCandidates — tags non interprétables", () => {
  it("signale l'incertitude pour un tag de date et propose des tags de même forme", () => {
    const r = pickCandidates("20241106", ["20241001", "20241201", "20250105", "latest"], "major");
    expect(r.uncertain).toBe(true);
    expect(r.candidates).toEqual(["20250105", "20241201"]);
  });
  it("n'invente rien pour un tag flottant", () => {
    const r = pickCandidates("latest", TAGS, "major");
    expect(r.candidates).toEqual([]);
    expect(r.uncertain).toBe(true);
    expect(r.notes[0]).toContain("flottant");
  });
  it("applique une expression libre en le signalant", () => {
    const r = pickCandidates("rel-1.0", ["rel-1.1", "rel-1.0", "rel-0.9", "autre"], "pattern", "^rel-\\d+\\.\\d+$");
    expect(r).toMatchObject({ candidates: ["rel-1.1"], uncertain: true });
    expect(pickCandidates("x", ["a"], "pattern", null).notes[0]).toContain("absente");
  });
});

describe("validatePattern — sécurité", () => {
  it("accepte les expressions simples", () => {
    for (const p of ["^v1\\.\\d+$", "^release-.*$", "^(a|b)-1$"]) expect(validatePattern(p), p).toBeNull();
  });
  it("refuse les expressions à backtracking catastrophique, rétro-références et trop longues", () => {
    for (const p of ["(a+)+$", "(a|aa)*b", "(.*)*x", "(a)\\1", "(?<=a)b", "x".repeat(101), "", "[", "a;b"]) {
      expect(validatePattern(p), p).not.toBeNull();
    }
  });
});
