import { describe, expect, it } from "vitest";
import { ReplayGuard, SelfProtection, containerIdsFromMountinfo } from "./guard.js";

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

  it("juge l'échéance à l'heure de la console, même si l'horloge de l'hôte est décalée", () => {
    const consoleNow = Date.parse("2026-01-01T00:00:00Z");
    const hostNow = consoleNow + 11 * 60_000; // hôte en avance de 11 minutes
    const offset = consoleNow - hostNow; // mesuré à la connexion à partir de l'heure de la console
    const g = new ReplayGuard(() => hostNow + offset);
    expect(g.check("a", "2026-01-01T00:10:00Z")).toBe("ok"); // la demande vient d'être émise : valable 10 minutes
    const sansCorrection = new ReplayGuard(() => hostNow);
    expect(sansCorrection.check("b", "2026-01-01T00:10:00Z")).toBe("expired"); // c'était le défaut corrigé
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

describe("containerIdsFromMountinfo", () => {
  it("retrouve l'identifiant du conteneur même quand le nom d'hôte a été changé", () => {
    const id = "a".repeat(64);
    const text = `1 2 0:1 /var/lib/docker/containers/${id}/hostname /etc/hostname rw - ext4 /dev/sda1 rw\n3 4 0:2 / /proc rw - proc proc rw\n`;
    expect(containerIdsFromMountinfo(text)).toEqual([id]);
    expect(containerIdsFromMountinfo("rien d'utile")).toEqual([]);
  });
});

describe("SelfProtection", () => {
  const info = (project?: string) => ({ Config: { Labels: project ? { "com.docker.compose.project": project } : {} } });

  it("protège les projets listés explicitement", async () => {
    const p = new SelfProtection("/nonexistent.sock", undefined, ["console-docker"], { mountinfo: async () => "" });
    expect(await p.isProtected("console-docker")).toBe(true);
    expect(await p.isProtected("autre")).toBe(false);
  });

  it("protège son propre projet, retrouvé depuis son conteneur", async () => {
    const p = new SelfProtection("s", "abc123", [], { inspect: async () => info("console-docker"), mountinfo: async () => "" });
    expect(await p.isProtected("console-docker")).toBe(true);
    expect(await p.isProtected("autre")).toBe(false);
  });

  it("retrouve son projet par mountinfo quand le nom d'hôte ne correspond plus à un conteneur", async () => {
    const id = "b".repeat(64);
    const inspect = async (_s: string, path: string) => {
      if (path.includes(id)) return info("console-docker");
      throw new Error("introuvable");
    };
    const p = new SelfProtection("s", "nom-impose", [], { inspect, mountinfo: async () => `x /containers/${id}/hostname y` });
    expect(await p.isProtected("console-docker")).toBe(true);
  });

  it("ne mémorise pas un échec : Docker momentanément indisponible n'ôte pas la protection pour toujours", async () => {
    let up = false;
    const inspect = async () => {
      if (!up) throw new Error("socket indisponible");
      return info("console-docker");
    };
    const p = new SelfProtection("s", "abc123", [], { inspect, mountinfo: async () => "" });
    expect(await p.isProtected("console-docker")).toBe(false); // indéterminé pour l'instant
    up = true;
    expect(await p.isProtected("console-docker")).toBe(true); // réessayé et mémorisé
  });

  it("signale une seule fois qu'il ne retrouve pas son projet", async () => {
    const warnings: string[] = [];
    const p = new SelfProtection("s", "abc123", [], {
      inspect: async () => {
        throw new Error("non");
      },
      mountinfo: async () => "",
      warn: (m) => warnings.push(m),
    });
    await p.isProtected("a");
    await p.isProtected("b");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("PROTECTED_PROJECTS");
  });
});
