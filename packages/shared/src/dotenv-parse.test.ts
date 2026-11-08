import { describe, expect, it } from "vitest";
import { parseDotenv } from "./dotenv-parse.js";

describe("parseDotenv", () => {
  it("lit les valeurs simples, vides et avec export, en ignorant commentaires et lignes vides", () => {
    const r = parseDotenv("# commentaire\n\nA=1\nexport B = deux\nC=\n  D=x  \n");
    expect(r.values).toEqual({ A: "1", B: "deux", C: "", D: "x" });
    expect(r.issues).toEqual([]);
  });

  it("retire les guillemets et gère les commentaires en fin de ligne", () => {
    const r = parseDotenv("A='un deux' # note\nB=\"trois\" # note\nC=quatre # note\nD=a#b\n");
    expect(r.values).toEqual({ A: "un deux", B: "trois", C: "quatre", D: "a#b" });
  });

  it("interprète les échappements des guillemets doubles et garde les simples littéraux", () => {
    const r = parseDotenv('A="l1\\nl2 \\"q\\""\nB=\'a\\nb\'\n');
    expect(r.values.A).toBe('l1\nl2 "q"');
    expect(r.values.B).toBe("a\\nb");
  });

  it("signale les valeurs qui seraient interpolées par Compose", () => {
    const r = parseDotenv("A=pre$x\nB='pre$x'\nC=\"pre\\$x\"\nD=\"pre${X}\"\nE=ok\n");
    expect(r.interpolated).toEqual(["A", "D"]);
    expect(r.values.B).toBe("pre$x");
    expect(r.values.C).toBe("pre$x");
  });

  it("signale les lignes invalides sans interrompre la lecture", () => {
    const r = parseDotenv("A=1\nn'importe quoi\n1BAD=2\nC='non refermé\nD=4\n");
    expect(r.values).toEqual({ A: "1", D: "4" });
    expect(r.issues.map((i) => i.line)).toEqual([2, 3, 4]);
  });

  it("garde la dernière valeur d'une clé répétée et ignore un BOM", () => {
    expect(parseDotenv("﻿A=1\nA=2\n").values).toEqual({ A: "2" });
  });
});
