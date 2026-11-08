import { describe, expect, it } from "vitest";
import { criticalReopen, readJson, writeJson } from "./persist";

const memory = (init: Record<string, string> = {}) => {
  const data = { ...init };
  return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v), data };
};

describe("readJson / writeJson", () => {
  it("relit ce qui a été écrit et rend la valeur par défaut sinon", () => {
    const s = memory();
    expect(readJson("k", true, s)).toBe(true);
    writeJson("k", false, s);
    expect(readJson("k", true, s)).toBe(false);
  });

  it("ignore un contenu illisible", () => {
    expect(readJson("k", 5, memory({ k: "{pas du json" }))).toBe(5);
  });

  it("fonctionne sans stockage ou avec un stockage qui refuse l'écriture", () => {
    expect(readJson("k", 1, null)).toBe(1);
    expect(() => writeJson("k", 1, null)).not.toThrow();
    const refuse = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(() => writeJson("k", 1, refuse)).not.toThrow();
  });
});

describe("criticalReopen", () => {
  it("rouvre pour une alerte critique jamais vue, puis plus tant qu'elle est connue", () => {
    const first = criticalReopen(["a"], []);
    expect(first.reopen).toBe(true);
    expect(criticalReopen(["a"], first.seen).reopen).toBe(false);
  });

  it("ne rouvre pas quand les alertes diminuent", () => {
    expect(criticalReopen(["a"], ["a", "b"])).toEqual({ reopen: false, seen: ["a"] });
  });

  it("une alerte résolue puis revenue est de nouveau nouvelle", () => {
    const resolved = criticalReopen([], ["a"]);
    expect(resolved.seen).toEqual([]);
    expect(criticalReopen(["a"], resolved.seen).reopen).toBe(true);
  });

  it("ne rouvre pas sans alerte critique", () => {
    expect(criticalReopen([], []).reopen).toBe(false);
  });
});
