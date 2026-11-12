import { describe, expect, it } from "vitest";
import { MAX_ICON_BYTES, normalizeIconColor, readableOn, validateSvgIcon } from "./svg-icon.js";

const OK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Logo</title><path d="M0 0h24v24H0z" fill="#fff"/></svg>`;
const refused = (svg: string): string => {
  const r = validateSvgIcon(svg);
  if (r.ok) throw new Error("accepté à tort");
  return r.error;
};

describe("validateSvgIcon", () => {
  it("accepte un SVG simple et le renvoie tel quel", () => {
    expect(validateSvgIcon(OK)).toEqual({ ok: true, svg: OK });
  });

  it("retire la déclaration XML et les commentaires, et ajoute l'espace de noms manquant", () => {
    const r = validateSvgIcon(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- éditeur -->\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`);
    expect(r).toEqual({ ok: true, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>` });
  });

  it("accepte les attributs courants des éditeurs (xml:space, espaces de noms déclarés, data-*)", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" viewBox="-0.06 83.4 512.16 345.26"><path data-name="a" d="M116.8 428.5c-38.3-3.3z" style="fill:#24a1c1"/></svg>`;
    expect(validateSvgIcon(svg)).toEqual({ ok: true, svg });
  });

  it("accepte les dégradés et les références internes", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>`;
    expect(validateSvgIcon(svg).ok).toBe(true);
  });

  it("refuse les scripts, gestionnaires d'événements, liens et contenus étrangers", () => {
    expect(refused(`<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>`)).toContain("script");
    expect(refused(`<svg viewBox="0 0 1 1" onload="alert(1)"><path d="M0 0"/></svg>`)).toContain("gestionnaire");
    expect(refused(`<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>`)).toContain("foreignObject");
    expect(refused(`<svg viewBox="0 0 1 1"><image href="https://x/a.png"/></svg>`)).toContain("image");
    expect(refused(`<svg viewBox="0 0 1 1"><use href="#a"/></svg>`)).toContain("use");
    expect(refused(`<svg viewBox="0 0 1 1"><style>@import url(https://x)</style></svg>`)).toContain("style");
    expect(refused(`<svg viewBox="0 0 1 1"><path href="javascript:alert(1)" d="M0 0"/></svg>`)).toContain("href");
    expect(refused(`<svg viewBox="0 0 1 1"><path d="M0 0" onclick='x()'/></svg>`)).toContain("gestionnaire");
  });

  it("refuse les références externes dans les valeurs, y compris dans « style »", () => {
    expect(refused(`<svg viewBox="0 0 1 1"><rect fill="url(https://x/a.svg#f)" width="1" height="1"/></svg>`)).toContain("fill");
    expect(refused(`<svg viewBox="0 0 1 1"><rect style="fill:url(//x/a)" width="1" height="1"/></svg>`)).toContain("style");
    expect(refused(`<svg viewBox="0 0 1 1"><rect style="background:url(data:image/png;base64,AA)" width="1" height="1"/></svg>`)).toContain("style");
  });

  it("refuse DOCTYPE, entités et CDATA", () => {
    expect(refused(`<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"/>`)).toContain("DOCTYPE");
    expect(refused(`<svg viewBox="0 0 1 1"><title><![CDATA[x]]></title></svg>`)).toContain("CDATA");
    expect(refused(`<svg viewBox="0 0 1 1"><title>&xxe;</title></svg>`)).toContain("refusé");
  });

  it("refuse les documents mal formés, multiples ou sans viewBox", () => {
    expect(refused("")).toContain("vide");
    expect(refused("pas un svg")).toContain("Texte");
    expect(refused(`<svg viewBox="0 0 1 1"><g></svg>`)).toContain("imbriquées");
    expect(refused(`<svg viewBox="0 0 1 1"><g>`)).toContain("fermée");
    expect(refused(`<svg viewBox="0 0 1 1"/><svg viewBox="0 0 1 1"/>`)).toContain("racine");
    expect(refused(`<svg><path d="M0 0"/></svg>`)).toContain("viewBox");
    expect(refused(`<g viewBox="0 0 1 1"/>`)).toContain("racine");
    expect(refused(`<svg viewBox="0 0 1 1" xmlns="http://autre"/>`)).toContain("noms");
  });

  it("refuse un fichier trop volumineux", () => {
    expect(refused(`<svg viewBox="0 0 1 1"><title>${"a".repeat(MAX_ICON_BYTES)}</title></svg>`)).toContain("volumineux");
  });
});

describe("couleur de fond", () => {
  it("normalise #rgb et #rrggbb en minuscules et refuse le reste", () => {
    expect(normalizeIconColor("#ABC")).toBe("#aabbcc");
    expect(normalizeIconColor(" #1E40AF ")).toBe("#1e40af");
    for (const bad of ["red", "#12", "#12345g", "rgb(0,0,0)", "#1234567", "url(x)", ""]) expect(normalizeIconColor(bad)).toBeNull();
  });

  it("choisit un texte lisible sur le fond", () => {
    expect(readableOn("#ffffff")).toBe("#0f172a");
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#1e40af")).toBe("#ffffff");
    expect(readableOn("n'importe quoi")).toBe("#0f172a");
  });
});
