import { describe, expect, it } from "vitest";
import type { RemovalHostPlan } from "./api";
import { defaultSelection, hostHasWork, nameMatches } from "./removal-selection";

const host = (over: Partial<RemovalHostPlan> = {}): RemovalHostPlan => ({
  available: true,
  containers: [{ id: "a", name: "app-web-1", state: "exited", image: "app-web-custom:local" }],
  running: 0,
  networks: [{ id: "n", name: "app_default" }],
  volumes: [{ name: "app_data", sizeBytes: 1024 }],
  images: [
    { ref: "app-web-custom:local", id: "sha256:1", usedByOthers: 0 },
    { ref: "postgres:17", id: "sha256:2", usedByOthers: 2 },
  ],
  binds: ["/home/ubuntu/store/medias"],
  workspace: true,
  ...over,
});

describe("defaultSelection", () => {
  it("ne coche jamais les volumes ni les images utilisées ailleurs", () => {
    expect(defaultSelection(host())).toEqual({ networks: true, workspace: true, volumes: [], images: ["app-web-custom:local"] });
  });

  it("ne coche ni réseau ni dossier de travail absents", () => {
    expect(defaultSelection(host({ networks: [], workspace: false }))).toMatchObject({ networks: false, workspace: false });
  });
});

describe("nameMatches", () => {
  it("exige le nom exact", () => {
    expect(nameMatches("runescape", "runescape")).toBe(true);
    expect(nameMatches("Runescape", "runescape")).toBe(false);
    expect(nameMatches("runescape ", "runescape")).toBe(false);
    expect(nameMatches("", "runescape")).toBe(false);
  });
});

describe("hostHasWork", () => {
  it("les conteneurs du projet sont toujours à retirer", () => {
    expect(hostHasWork(host(), { networks: false, workspace: false, volumes: [], images: [] })).toBe(true);
  });
  it("rien à faire sans conteneur ni case cochée", () => {
    expect(hostHasWork(host({ containers: [] }), { networks: false, workspace: false, volumes: [], images: [] })).toBe(false);
    expect(hostHasWork(host({ containers: [] }), { networks: false, workspace: false, volumes: ["app_data"], images: [] })).toBe(true);
  });
});
