import { describe, expect, it } from "vitest";
import { appendEntries, filterEntries, makeEntry } from "./log-entries";

const E = "\u001b";

describe("makeEntry", () => {
  it("analyse la ligne une fois et garde le texte sans codes", () => {
    const e = makeEntry(`${E}[32mINF${E}[0m démarré`);
    expect(e.plain).toBe("INF démarré");
    expect(e.segments).toHaveLength(2);
  });

  it("donne des identifiants uniques et croissants", () => {
    const [a, b, c] = ["a", "b", "c"].map(makeEntry);
    expect(new Set([a?.id, b?.id, c?.id]).size).toBe(3);
    expect((b?.id ?? 0) > (a?.id ?? 1)).toBe(true);
  });
});

describe("appendEntries", () => {
  it("ajoute un lot et garde les dernières lignes avec leurs identifiants", () => {
    const first = appendEntries([], ["1", "2", "3"], 4);
    const ids = first.map((e) => e.id);
    const second = appendEntries(first, ["4", "5"], 4);
    expect(second.map((e) => e.plain)).toEqual(["2", "3", "4", "5"]);
    // Les lignes conservées ne sont pas recréées : même identifiant, donc pas de nouvel affichage.
    expect(second.slice(0, 2).map((e) => e.id)).toEqual(ids.slice(1, 3));
  });

  it("ne modifie pas le tableau d'origine et accepte un lot vide", () => {
    const base = appendEntries([], ["a"], 10);
    expect(appendEntries(base, [], 10)).toEqual(base);
    expect(base).toHaveLength(1);
  });
});

describe("filterEntries", () => {
  const entries = appendEntries([], [`${E}[31mERR${E}[0m connexion refusée`, `${E}[32mINF${E}[0m prêt`, "sans couleur"], 10);

  it("cherche dans le texte sans les codes de couleur, sans tenir compte de la casse", () => {
    expect(filterEntries(entries, "err connexion").map((e) => e.plain)).toEqual(["ERR connexion refusée"]);
    expect(filterEntries(entries, "PRÊT").map((e) => e.plain)).toEqual(["INF prêt"]);
  });

  it("ne trouve pas un code de couleur comme du texte", () => {
    expect(filterEntries(entries, "[31m")).toEqual([]);
    expect(filterEntries(entries, "31")).toEqual([]);
  });

  it("un filtre vide ou d'espaces rend toutes les lignes", () => {
    expect(filterEntries(entries, "")).toBe(entries);
    expect(filterEntries(entries, "   ")).toBe(entries);
  });
});
