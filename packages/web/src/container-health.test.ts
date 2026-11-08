import { describe, expect, it } from "vitest";
import { healthApplies } from "./container-health";

describe("healthApplies", () => {
  it("seulement pour un conteneur en marche", () => {
    expect(healthApplies("running")).toBe(true);
    for (const s of ["exited", "created", "dead", "paused", "restarting"]) expect(healthApplies(s)).toBe(false);
  });
});
