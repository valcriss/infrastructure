import { describe, expect, it } from "vitest";
import { findActiveOperation } from "./active-operation";

describe("findActiveOperation", () => {
  it("retrouve l'opération en cours ou en attente", () => {
    expect(findActiveOperation([{ id: "b", status: "running" }, { id: "a", status: "succeeded" }])?.id).toBe("b");
    expect(findActiveOperation([{ id: "c", status: "pending" }])?.id).toBe("c");
  });

  it("ignore les opérations terminées, y compris de résultat inconnu", () => {
    expect(findActiveOperation([{ id: "a", status: "succeeded" }, { id: "b", status: "failed" }, { id: "c", status: "unknown" }])).toBeNull();
    expect(findActiveOperation([])).toBeNull();
  });
});
