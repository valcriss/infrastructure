import { describe, expect, it } from "vitest";
import { ReplayGuard, SelfProtection } from "./guard.js";

describe("ReplayGuard", () => {
  it("accepte une première demande puis ignore sa répétition", () => {
    const g = new ReplayGuard();
    expect(g.check("a")).toBe("ok");
    expect(g.check("a")).toBe("replayed");
    expect(g.check("b")).toBe("ok");
  });

  it("refuse une demande expirée, sans la mémoriser comme traitée", () => {
    let now = Date.parse("2026-01-01T00:10:00Z");
    const g = new ReplayGuard(() => now);
    expect(g.check("a", "2026-01-01T00:05:00Z")).toBe("expired");
    now = Date.parse("2026-01-01T00:00:00Z");
    expect(g.check("a", "2026-01-01T00:05:00Z")).toBe("ok");
  });

  it("accepte une demande sans échéance (console plus ancienne)", () => {
    expect(new ReplayGuard().check("x")).toBe("ok");
  });

  it("garde une mémoire bornée", () => {
    const g = new ReplayGuard();
    for (let i = 0; i < 5100; i++) g.check(`id-${i}`);
    expect(g.check("id-5099")).toBe("replayed");
    expect(g.check("id-0")).toBe("ok"); // oublié, mais trop ancien pour avoir encore une échéance valide
  });
});

describe("SelfProtection", () => {
  it("protège les projets listés explicitement", async () => {
    const p = new SelfProtection("/nonexistent.sock", undefined, ["console-docker"]);
    expect(await p.isProtected("console-docker")).toBe(true);
    expect(await p.isProtected("autre")).toBe(false);
  });

  it("ne protège rien d'implicite hors conteneur", async () => {
    const p = new SelfProtection("/nonexistent.sock", "abc123", []);
    expect(await p.isProtected("console-docker")).toBe(false);
  });
});
