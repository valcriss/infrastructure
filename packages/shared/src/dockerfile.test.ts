import { describe, expect, it } from "vitest";
import { ComposeEditError, editServiceBuild } from "./compose-edit.js";
import { generateDockerfile, validateBaseImage, validatePackages } from "./dockerfile.js";

describe("generateDockerfile", () => {
  it("installe des outils et nettoie les caches, selon le gestionnaire de paquets", () => {
    const apk = generateDockerfile({ base: "ghost:alpine", packageManager: "apk", packages: ["curl"], upgrade: false, user: "node" });
    expect(apk).toContain("FROM ghost:alpine");
    expect(apk).toContain("USER root");
    expect(apk).toContain("apk add --no-cache curl");
    expect(apk.trimEnd().endsWith("USER node")).toBe(true);

    const apt = generateDockerfile({ base: "ghost:bookworm", packageManager: "apt-get", packages: ["curl", "wget"], upgrade: true, user: "" });
    expect(apt).toContain("apt-get update");
    expect(apt).toContain("apt-get upgrade -y");
    expect(apt).toContain("apt-get install -y --no-install-recommends curl wget");
    expect(apt).toContain("rm -rf /var/lib/apt/lists/*");
    // Utilisateur d'origine root : aucune instruction USER finale.
    expect(apt.trimEnd().split("\n").pop()).not.toMatch(/^USER/);
    expect(generateDockerfile({ base: "x:1", packageManager: "dnf", packages: [], upgrade: true, user: "0" })).toContain("dnf upgrade -y");
  });

  it("refuse les noms de paquets et les images de base douteux", () => {
    expect(validatePackages(["curl", "libssl3"])).toBeNull();
    expect(validatePackages(["curl; rm -rf /"])).not.toBeNull();
    expect(validatePackages(Array(13).fill("a"))).not.toBeNull();
    expect(validateBaseImage("ghost:bookworm")).toBeNull();
    expect(validateBaseImage("${IMAGE:-ghost:5}")).not.toBeNull();
    expect(validateBaseImage("a b")).not.toBeNull();
  });
});

describe("editServiceBuild", () => {
  const compose = "services:\n  ghost:\n    image: ghost:bookworm # image figée\n    restart: always\n  db:\n    image: mysql:8.0\n";

  it("remplace l'image par un build local en conservant le reste et les commentaires", () => {
    const out = editServiceBuild(compose, "ghost", { context: "./build/ghost", image: "app-ghost-custom:local" });
    expect(out.baseImage).toBe("ghost:bookworm");
    expect(out.compose).toContain("build: ./build/ghost");
    expect(out.compose).toContain("image: app-ghost-custom:local");
    expect(out.compose).toContain("restart: always");
    expect(out.compose).toContain("image: mysql:8.0");
  });

  it("refuse un service déjà construit, inconnu ou sans image simple", () => {
    const built = editServiceBuild(compose, "ghost", { context: "./b", image: "x:local" }).compose;
    expect(() => editServiceBuild(built, "ghost", { context: "./b", image: "x:local" })).toThrow(ComposeEditError);
    expect(() => editServiceBuild(compose, "absent", { context: "./b", image: "x:local" })).toThrow(ComposeEditError);
    expect(() => editServiceBuild("services:\n  a:\n    command: x\n", "a", { context: "./b", image: "x:local" })).toThrow(ComposeEditError);
  });
});
