import type { PatchMessage } from "@infra/shared";
import { describe, expect, it } from "vitest";
import { buildkitImageOf, buildkitRunArgs, buildkitStartHint, configDiff, copaPatchArgs, fixableReport, osPackages, packageChanges, parsePushDigest, registryRef, registryScheme, trivyRemoteArgs } from "./patcher.js";
import { normalizeReport } from "./scanner.js";

const cfg = {
  patcherImage: "ghcr.io/x/patcher:1",
  buildkitImage: "moby/buildkit:v0.35.0-rootless",
  buildkitMemory: "3g",
  trivyImage: "ghcr.io/aquasecurity/trivy:0.76.1",
  trivyCacheVolume: "cache",
  trivyMemory: "2g",
};
const target: PatchMessage["target"] = { registry: "registry.exemple.fr", repository: "patched/docker-io-library-alpine", sourceTag: "src-8a1f59ffb675", patchedTag: "3.22.0-patch.1" };

describe("arguments des conteneurs", () => {
  it("le repli privilégié est explicite : image classique et --privileged, jamais par défaut", () => {
    const p = buildkitRunArgs({ ...cfg, buildkitPrivileged: true, buildkitPrivilegedImage: "moby/buildkit:v0.35.0" }, "bk");
    expect(p).toContain("--privileged");
    expect(p).toContain("moby/buildkit:v0.35.0");
    expect(p).not.toContain("seccomp=unconfined");
    expect(buildkitImageOf({ ...cfg, buildkitPrivileged: true, buildkitPrivilegedImage: "x:1" })).toBe("x:1");
    expect(buildkitImageOf(cfg)).toBe("moby/buildkit:v0.35.0-rootless");
    expect(buildkitRunArgs(cfg, "bk")).not.toContain("--privileged");
  });

  it("explique l'échec de BuildKit rootless sur un hôte qui interdit les espaces de noms utilisateur", () => {
    const logs = "[rootlesskit:parent] This error might have happened because /proc/sys/kernel/apparmor_restrict_unprivileged_userns is set to 1";
    expect(buildkitStartHint(logs)).toContain("apparmor_restrict_unprivileged_userns=0");
    expect(buildkitStartHint(logs)).toContain("BUILDKIT_PRIVILEGED=1");
    expect(buildkitStartHint("panic: autre cause")).toBeNull();
  });

  it("BuildKit est rootless, sans --privileged, avec mémoire plafonnée", () => {
    const a = buildkitRunArgs(cfg, "bk");
    expect(a).not.toContain("--privileged");
    expect(a).toEqual(expect.arrayContaining(["--security-opt", "seccomp=unconfined", "systempaths=unconfined", "--memory", "3g", "moby/buildkit:v0.35.0-rootless"]));
    expect(a.join(" ")).toContain("--oci-worker-no-process-sandbox");
    expect(a.join(" ")).toContain("--addr tcp://0.0.0.0:1234");
  });

  it("Trivy distant : réseau de BuildKit, sans socket Docker, identifiants hors ligne de commande", () => {
    const a = trivyRemoteArgs(cfg, "t", "bk", "/ws/.patch-1", "registry.exemple.fr/r@sha256:abc", "before.json", true);
    expect(a.join(" ")).not.toContain("docker.sock");
    expect(a).toEqual(expect.arrayContaining(["--network", "container:bk", "--cap-drop", "ALL", "--read-only", "-e", "TRIVY_USERNAME", "-e", "TRIVY_PASSWORD"]));
    expect(a.some((x) => x.includes("=") && /TRIVY_(USERNAME|PASSWORD)=/.test(x))).toBe(false);
    expect(a).toEqual(expect.arrayContaining(["--pkg-types", "os", "--image-src", "remote", "--list-all-pkgs"]));
    expect(a[a.length - 1]).toBe("registry.exemple.fr/r@sha256:abc");
    expect(trivyRemoteArgs(cfg, "t", "bk", "/d", "r", "o.json", false).join(" ")).not.toContain("TRIVY_USERNAME");
  });

  it("Copa : BuildKit en TCP, publication directe, aucun accès Docker, configuration d'authentification en lecture seule", () => {
    const a = copaPatchArgs(cfg, "c", "bk", "/ws/.patch-1", "registry.exemple.fr/r:src-1", "3.22.0-patch.1", 600);
    expect(a.join(" ")).not.toContain("docker.sock");
    expect(a).toEqual(expect.arrayContaining(["--network", "container:bk", "--addr", "tcp://localhost:1234", "--push", "--tag", "3.22.0-patch.1", "/ws/.patch-1/dockercfg:/dockercfg:ro"]));
    expect(a.join(" ")).toContain("--timeout 600s");
  });

  it("déduit le schéma du registre et les références", () => {
    expect(registryScheme("registry.exemple.fr")).toBe("https");
    expect(registryScheme("localhost:5000")).toBe("http");
    expect(registryScheme("127.0.0.1:55000")).toBe("http");
    expect(registryRef(target, { tag: "t" })).toBe("registry.exemple.fr/patched/docker-io-library-alpine:t");
    expect(registryRef(target, { digest: "sha256:ab" })).toBe("registry.exemple.fr/patched/docker-io-library-alpine@sha256:ab");
  });

  it("lit le digest annoncé par docker push", () => {
    const d = "sha256:" + "a".repeat(64);
    expect(parsePushDigest(`The push refers to repository [x]\nsrc-1: digest: ${d} size: 856\n`)).toBe(d);
    expect(parsePushDigest("erreur")).toBeNull();
  });
});

const report = {
  Metadata: { OS: { Family: "alpine", Name: "3.22.0" } },
  Results: [
    {
      Class: "os-pkgs",
      Packages: [{ Name: "zlib", Version: "1.3.1-r2" }, { Name: "musl", Version: "1.2.5-r10" }],
      Vulnerabilities: [
        { VulnerabilityID: "CVE-1", PkgName: "zlib", InstalledVersion: "1.3.1-r2", FixedVersion: "1.3.2-r0", Severity: "HIGH" },
        { VulnerabilityID: "CVE-2", PkgName: "musl", InstalledVersion: "1.2.5-r10", Severity: "LOW" },
      ],
    },
    { Class: "lang-pkgs", Vulnerabilities: [{ VulnerabilityID: "GHSA-1", PkgName: "lodash", InstalledVersion: "1", FixedVersion: "2", Severity: "MEDIUM" }] },
  ],
};

describe("rapports Trivy", () => {
  it("distingue les paquets du système des dépendances applicatives", () => {
    const n = normalizeReport(report);
    expect(n.vulnerabilities.find((v) => v.id === "CVE-1")?.kind).toBe("os");
    expect(n.vulnerabilities.find((v) => v.id === "GHSA-1")?.kind).toBe("lang");
  });

  it("filtre l'entrée de Copa : seuls les constats corrigeables sont conservés, le rapport source n'est pas modifié", () => {
    const f = fixableReport(report);
    expect(f.fixable).toBe(2);
    expect(f.report.Results?.[0]?.Vulnerabilities).toHaveLength(1);
    expect(report.Results[0]?.Vulnerabilities).toHaveLength(2);
    expect(fixableReport({ Results: [{ Class: "os-pkgs", Vulnerabilities: [{ FixedVersion: "" }] }] }).fixable).toBe(0);
  });

  it("liste les paquets modifiés, ajoutés ou retirés, sans compter ceux qui n'ont pas changé", () => {
    const before = osPackages(report);
    expect([...before.keys()]).toEqual(["zlib", "musl"]);
    const after = new Map([["zlib", "1.4-r0"], ["musl", "1.2.5-r10"], ["new", "1"]]);
    expect(packageChanges(before, after).changes).toEqual([{ name: "new", from: "-", to: "1" }, { name: "zlib", from: "1.3.1-r2", to: "1.4-r0" }]);
  });
});

describe("configDiff", () => {
  const src = { Entrypoint: ["/entry"], Cmd: ["run"], User: "app", WorkingDir: "/app", Env: ["A=1", "B=2"], ExposedPorts: { "80/tcp": {} }, Labels: { a: "1" } };
  it("n'y voit rien quand seul le libellé BaseImage est ajouté, et ignore l'ordre des variables", () => {
    const d = configDiff(src, { ...src, Env: ["B=2", "A=1"], Labels: { a: "1", BaseImage: "docker.io/x:1" } });
    expect(d).toEqual({ configChanges: [], labelsAdded: ["BaseImage"] });
    expect(configDiff({ Cmd: [] }, { Cmd: null }).configChanges).toEqual([]);
  });
  it("rapporte les noms des champs modifiés, jamais leurs valeurs", () => {
    const d = configDiff(src, { ...src, Entrypoint: ["/autre"], User: "root", Env: ["A=1", "SECRET=hunter2"], Labels: { a: "2" } });
    expect(d.configChanges).toEqual(["Entrypoint", "User", "Env", "Labels"]);
    expect(JSON.stringify(d)).not.toContain("hunter2");
  });
});
