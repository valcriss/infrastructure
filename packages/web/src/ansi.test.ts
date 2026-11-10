import { describe, expect, it } from "vitest";
import { BG_PALETTE, DEFAULT_BG, DEFAULT_FG, FG_PALETTE, parseAnsi, stripAnsi } from "./ansi";

const E = "\u001b";
describe("parseAnsi : texte et couleurs de base", () => {
  it("laisse une ligne sans code telle quelle, sans style", () => {
    expect(parseAnsi("simple ligne")).toEqual([{ text: "simple ligne" }]);
    expect(parseAnsi("")).toEqual([]);
  });

  it("applique une couleur de texte puis la remise à zéro", () => {
    const segs = parseAnsi(`${E}[31mrouge${E}[0m normal`);
    expect(segs).toEqual([{ text: "rouge", css: { color: FG_PALETTE[1] } }, { text: " normal" }]);
  });

  it("gère une ligne de Traefik : gris, vert, gras, cyan", () => {
    const line = `${E}[90m2026-11-10T21:08:37Z${E}[0m ${E}[32mINF${E}[0m ${E}[1mTraefik version 3.7.17${E}[0m ${E}[36mversion=${E}[0m3.7.17`;
    const segs = parseAnsi(line);
    expect(segs.map((s) => s.text)).toEqual(["2026-11-10T21:08:37Z", " ", "INF", " ", "Traefik version 3.7.17", " ", "version=", "3.7.17"]);
    expect(segs[0]?.css).toEqual({ color: FG_PALETTE[8] });
    expect(segs[2]?.css).toEqual({ color: FG_PALETTE[2] });
    expect(segs[4]?.css).toEqual({ fontWeight: "700" });
    expect(segs[6]?.css).toEqual({ color: FG_PALETTE[6] });
    expect(segs[7]?.css).toBeUndefined();
  });

  it("combine plusieurs paramètres, et « ESC[m » vaut une remise à zéro", () => {
    expect(parseAnsi(`${E}[1;4;33mx${E}[m y`)).toEqual([{ text: "x", css: { color: FG_PALETTE[3], fontWeight: "700", textDecoration: "underline" } }, { text: " y" }]);
  });

  it("couleurs vives (90-97, 100-107) et fond avec texte lisible choisi automatiquement", () => {
    expect(parseAnsi(`${E}[91mx`)[0]?.css).toEqual({ color: FG_PALETTE[9] });
    // Fond sombre sans couleur de texte : texte clair ; fond clair : texte sombre.
    expect(parseAnsi(`${E}[41mx`)[0]?.css).toEqual({ backgroundColor: BG_PALETTE[1], color: DEFAULT_FG });
    expect(parseAnsi(`${E}[47mx`)[0]?.css).toEqual({ backgroundColor: BG_PALETTE[7], color: DEFAULT_BG });
    expect(parseAnsi(`${E}[41;97mx`)[0]?.css).toEqual({ backgroundColor: BG_PALETTE[1], color: FG_PALETTE[15] });
    expect(parseAnsi(`${E}[103mx`)[0]?.css?.backgroundColor).toBe(BG_PALETTE[11]);
  });

  it("39 et 49 rétablissent les couleurs par défaut", () => {
    expect(parseAnsi(`${E}[31;42mA${E}[39mB${E}[49mC`).map((s) => s.css)).toEqual([
      { color: FG_PALETTE[1], backgroundColor: BG_PALETTE[2] },
      { backgroundColor: BG_PALETTE[2], color: DEFAULT_FG },
      undefined,
    ]);
  });
});

describe("parseAnsi : couleurs 256 et 24 bits, attributs", () => {
  it("couleurs indexées : 16 couleurs, cube 6x6x6 et niveaux de gris", () => {
    expect(parseAnsi(`${E}[38;5;1mx`)[0]?.css?.color).toBe(FG_PALETTE[1]);
    expect(parseAnsi(`${E}[38;5;208mx`)[0]?.css?.color).toBe("#ff8700");
    expect(parseAnsi(`${E}[38;5;16mx`)[0]?.css?.color).toBe("#000000");
    expect(parseAnsi(`${E}[38;5;231mx`)[0]?.css?.color).toBe("#ffffff");
    expect(parseAnsi(`${E}[38;5;244mx`)[0]?.css?.color).toBe("#808080");
    expect(parseAnsi(`${E}[48;5;2mx`)[0]?.css?.backgroundColor).toBe(BG_PALETTE[2]);
  });

  it("couleurs 24 bits, avec les deux écritures (; et :)", () => {
    expect(parseAnsi(`${E}[38;2;120;200;255mx`)[0]?.css?.color).toBe("#78c8ff");
    expect(parseAnsi(`${E}[48;2;10;20;30mx`)[0]?.css?.backgroundColor).toBe("#0a141e");
    expect(parseAnsi(`${E}[38:2::120:200:255mx`)[0]?.css?.color).toBe("#78c8ff");
    expect(parseAnsi(`${E}[38:5:208mx`)[0]?.css?.color).toBe("#ff8700");
  });

  it("ignore une couleur invalide sans casser la suite", () => {
    expect(parseAnsi(`${E}[38;5;999mx${E}[31my`).map((s) => s.css)).toEqual([undefined, { color: FG_PALETTE[1] }]);
    expect(parseAnsi(`${E}[38;2;1;2mx`)[0]?.css).toBeUndefined();
    expect(parseAnsi(`${E}[38;9mx`)[0]?.css).toBeUndefined();
  });

  it("attributs : gras, atténué, italique, souligné, inversion, et leurs annulations", () => {
    expect(parseAnsi(`${E}[1;2;3;4mx`)[0]?.css).toEqual({ fontWeight: "700", fontStyle: "italic", textDecoration: "underline", opacity: "0.65" });
    expect(parseAnsi(`${E}[1;2;3;4m${E}[22;23;24mx`)[0]).toEqual({ text: "x" });
    // Inversion : texte et fond échangés, avec les couleurs par défaut du lecteur.
    expect(parseAnsi(`${E}[7mx`)[0]?.css).toEqual({ color: DEFAULT_BG, backgroundColor: DEFAULT_FG });
    expect(parseAnsi(`${E}[31;7mx`)[0]?.css).toEqual({ color: DEFAULT_BG, backgroundColor: FG_PALETTE[1] });
    expect(parseAnsi(`${E}[7m${E}[27mx`)[0]).toEqual({ text: "x" });
    expect(parseAnsi(`${E}[4:3mx`)[0]?.css).toEqual({ textDecoration: "underline" });
  });
});

describe("parseAnsi : séquences retirées et robustesse", () => {
  it("retire les séquences de curseur, d'effacement et de titre de fenêtre", () => {
    expect(stripAnsi(`${E}[2K${E}[1Gligne ${E}[3A${E}[?25lutile${E}]0;titre${E}\\ fin`)).toBe("ligne utile fin");
    expect(stripAnsi(`a${E}]8;;https://exemple.fr\u0007lien${E}]8;;\u0007b`)).toBe("alienb");
  });

  it("retire les caractères de contrôle mais garde la tabulation", () => {
    expect(stripAnsi("a\u0007b\u0008c\td\u007f")).toBe("abc\td");
  });

  it("garde la dernière version d'une ligne réécrite avec des retours chariot", () => {
    expect(stripAnsi("10%\r50%\r100%")).toBe("100%");
    expect(stripAnsi("ligne\r")).toBe("ligne");
    expect(stripAnsi("\r")).toBe("");
  });

  it("ne traite jamais le contenu comme du HTML", () => {
    const html = `<script>alert(1)</script> <b>gras</b> ${E}[31m<img src=x onerror=alert(1)>${E}[0m`;
    const segs = parseAnsi(html);
    expect(segs.map((s) => s.text).join("")).toBe("<script>alert(1)</script> <b>gras</b> <img src=x onerror=alert(1)>");
    expect(segs.flatMap((s) => Object.keys(s.css ?? {}))).toEqual(["color"]);
  });

  it("une séquence tronquée ou invalide ne fait ni planter ni perdre le texte", () => {
    expect(stripAnsi(`avant${E}[31`)).toBe("avant[31");
    expect(stripAnsi(`avant${E}`)).toBe("avant");
    // Code inconnu : ignoré. Un caractère non valide dans les paramètres termine la séquence, comme dans un terminal.
    expect(stripAnsi(`${E}[999;mtexte`)).toBe("texte");
    expect(stripAnsi(`${E}]0;titre sans fin`)).toBe("");
  });

  it("stripAnsi rend le texte brut d'une ligne colorée", () => {
    expect(stripAnsi(`${E}[90m2026${E}[0m ${E}[32mINF${E}[0m message`)).toBe("2026 INF message");
  });

  it("traite une longue ligne en un temps raisonnable", () => {
    const long = `${E}[31mx${E}[0m`.repeat(20000);
    const start = Date.now();
    expect(parseAnsi(long).length).toBe(20000);
    expect(Date.now() - start).toBeLessThan(1500);
  });
});
