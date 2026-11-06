import type { Inventory } from "@infra/shared";
import { describe, expect, it } from "vitest";
import { fitInventory } from "./inventory-fit.js";

const sha = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

const inventory = (containers: number, layersPerImage: number): Inventory => ({
  observedAt: "2026-11-07T00:00:00.000Z",
  dockerVersion: "29",
  containers: Array.from({ length: containers }, (_, i) => ({
    id: `c${i}`.padEnd(12, "0"),
    names: [`app-${i}`],
    image: "img",
    imageId: sha(i),
    state: "running",
    status: "Up",
    created: 1,
    mounts: [{ type: "bind", source: "/srv/data", destination: "/data", rw: true }],
    ports: [{ privatePort: 80, type: "tcp" }],
    networks: ["n"],
  })),
  images: Array.from({ length: containers }, (_, i) => ({ id: sha(i), repoTags: [`img:${i}`], repoDigests: [], size: 1, layers: Array.from({ length: layersPerImage }, (_, l) => sha(i * 1000 + l)) })),
});

const bytes = (i: Inventory) => Buffer.byteLength(JSON.stringify({ type: "inventory", inventory: i }));

describe("fitInventory", () => {
  it("ne touche à rien quand l'inventaire tient dans la limite", () => {
    const inv = inventory(5, 3);
    const r = fitInventory(inv, 1_000_000);
    expect(r.dropped).toEqual([]);
    expect(r.inventory).toBe(inv);
  });

  it("abandonne d'abord les détails facultatifs et garde conteneurs et états", () => {
    const inv = inventory(200, 40);
    const limit = Math.floor(bytes(inv) * 0.6);
    const r = fitInventory(inv, limit);
    expect(bytes(r.inventory)).toBeLessThanOrEqual(limit);
    expect(r.dropped[0]).toBe("montages");
    expect(r.inventory.containers).toHaveLength(200);
    expect(r.inventory.containers[0]).toMatchObject({ state: "running", image: "img" });
    expect(r.inventory.containers[0]).not.toHaveProperty("mounts");
  });

  it("va jusqu'à retirer les images, puis des conteneurs, plutôt que de dépasser la limite", () => {
    const inv = inventory(300, 60);
    const small = fitInventory(inv, 20_000);
    expect(bytes(small.inventory)).toBeLessThanOrEqual(20_000);
    expect(small.dropped).toContain("images");
    expect(small.dropped.at(-1)).toMatch(/conteneur/);
    expect(small.inventory.containers.length).toBeLessThan(300);
  });
});
