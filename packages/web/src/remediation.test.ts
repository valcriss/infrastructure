import { describe, expect, it } from "vitest";
import { isPatchedRef, latestByImage, majorJump, stageIndex, statusLabel } from "./remediation";

describe("remédiation (libellés)", () => {
  it("nomme les étapes et les verdicts, et situe l'étape en cours", () => {
    expect(statusLabel("scanning_after")).toBe("Scan après");
    expect(statusLabel("validated")).toBe("Validé");
    expect(statusLabel("unknown")).toBe("Indéterminé");
    expect(stageIndex("queued")).toBe(0);
    expect(stageIndex("verifying")).toBe(5);
    expect(stageIndex("validated")).toBe(-1);
  });

  it("repère un changement de version majeure d'un paquet", () => {
    expect(majorJump("1.3.1-r2", "1.4-r0")).toBe(false);
    expect(majorJump("1.3.1-r2", "2.0-r0")).toBe(true);
    expect(majorJump("3.5.0-r0", "3.5.9-r0")).toBe(false);
    expect(majorJump("2:1.0-1", "3:1.0-1")).toBe(true);
    expect(majorJump("-", "1.0")).toBe(false);
  });

  it("garde le correctif le plus récent par contenu d'image", () => {
    const jobs = [
      { id: "a", imageId: "i1", platform: "linux/amd64", createdAt: "2026-11-11T10:00:00Z" },
      { id: "b", imageId: "i1", platform: "linux/amd64", createdAt: "2026-11-12T10:00:00Z" },
      { id: "c", imageId: "i1", platform: "linux/arm64", createdAt: "2026-11-10T10:00:00Z" },
    ];
    const m = latestByImage(jobs);
    expect(m.get("i1|linux/amd64")?.id).toBe("b");
    expect(m.get("i1|linux/arm64")?.id).toBe("c");
  });

  it("reconnaît une image corrigée par la console", () => {
    expect(isPatchedRef("registry.exemple.fr/patched/docker-io-library-alpine@sha256:abc", "registry.exemple.fr")).toBe(true);
    expect(isPatchedRef("alpine:3.22.0", "registry.exemple.fr")).toBe(false);
    expect(isPatchedRef("registry.exemple.fr/patched/x@sha256:abc", null)).toBe(false);
  });
});
