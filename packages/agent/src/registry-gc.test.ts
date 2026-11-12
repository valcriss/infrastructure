import { describe, expect, it } from "vitest";
import { isRegistryImage, parseDuKb, registryGcArgs } from "./registry-gc.js";

describe("ramasse-miettes du registre : garde-fous de l'agent", () => {
  it("ne cible que l'image officielle du registre", () => {
    for (const ok of ["registry:3.0.0", "registry:3", "docker.io/library/registry:3.0.0", "library/registry:2.8.3"]) expect(isRegistryImage(ok)).toBe(true);
    for (const bad of ["registry", "evil/registry:3", "registry:3; rm -rf /", "ghcr.io/x/registry:3", "traefik:v3", "registry@sha256:" + "a".repeat(64), ""]) expect(isRegistryImage(bad)).toBe(false);
  });

  it("la commande est fixe : seul --dry-run est paramétrable", () => {
    expect(registryGcArgs("abc", false)).toEqual(["exec", "abc", "registry", "garbage-collect", "/etc/distribution/config.yml"]);
    expect(registryGcArgs("abc", true)).toEqual(["exec", "abc", "registry", "garbage-collect", "/etc/distribution/config.yml", "--dry-run"]);
  });

  it("lit l'espace occupé de la sortie de du", () => {
    expect(parseDuKb("3824\t/var/lib/registry\n")).toBe(3824);
    expect(parseDuKb("du: erreur")).toBeNull();
    expect(parseDuKb("")).toBeNull();
  });
});
