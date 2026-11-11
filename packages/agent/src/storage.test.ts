import { describe, expect, it } from "vitest";
import { measureArgs, parseDu, skipReason } from "./storage.js";

describe("mesure des montages", () => {
  it("n'explore ni la racine ni les emplacements système", () => {
    expect(skipReason("/")).not.toBeNull();
    expect(skipReason("/proc/1")).not.toBeNull();
    expect(skipReason("/var/run/docker.sock")).not.toBeNull();
    expect(skipReason("/var/lib/docker/volumes")).not.toBeNull();
    expect(skipReason("relatif/dossier")).not.toBeNull();
    expect(skipReason("/home/ubuntu/../etc")).not.toBeNull();
    expect(skipReason("/home/ubuntu/dockers/site")).toBeNull();
    expect(skipReason("/srv/runtime")).toBeNull();
  });

  it("lit la taille de `du -sk` en octets", () => {
    expect(parseDu("1234\t/m\n")).toBe(1234 * 1024);
    expect(parseDu("0\t/m")).toBe(0);
    expect(parseDu("erreur")).toBeNull();
  });

  it("monte le chemin en lecture seule, sans réseau ni droits superflus", () => {
    const args = measureArgs("img", "/srv/data");
    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("/srv/data:/m:ro");
    expect(args.slice(-3)).toEqual(["img", "-sk", "/m"]);
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
  });
});
