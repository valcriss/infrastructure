import { describe, expect, it } from "vitest";
import { diffLines, hasChanges } from "./diff";

describe("diffLines", () => {
  it("ne signale rien pour deux textes identiques", () => {
    expect(hasChanges(diffLines("a\nb\nc", "a\nb\nc"))).toBe(false);
  });

  it("détecte ajouts, suppressions et modifications", () => {
    const d = diffLines("a\nb\nc", "a\nx\nc\nd");
    expect(d).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "x" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
  });

  it("gère les textes vides", () => {
    expect(diffLines("", "a")).toEqual([{ type: "add", text: "a" }]);
    expect(diffLines("a", "")).toEqual([{ type: "del", text: "a" }]);
    expect(diffLines("", "")).toEqual([]);
  });

  it("conserve l'ordre sur une insertion au milieu", () => {
    const d = diffLines("1\n2\n3", "1\n2\n2.5\n3");
    expect(d.filter((l) => l.type === "add")).toEqual([{ type: "add", text: "2.5" }]);
    expect(d.filter((l) => l.type === "del")).toEqual([]);
  });
});
