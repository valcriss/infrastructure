/**
 * Icône personnalisée d'une application : un SVG et une couleur de fond.
 *
 * Un SVG peut porter du script et des références externes. La console ne l'affiche jamais en ligne dans la page (balise
 * `<img>` uniquement) et le sert avec une CSP restrictive ; cette validation s'y ajoute, par liste d'éléments et
 * d'attributs autorisés : tout ce qui n'est pas reconnu est refusé, pas nettoyé. Le SVG accepté est renvoyé normalisé
 * (déclaration XML et commentaires retirés, espace de noms ajouté s'il manque).
 */

/** Taille maximale d'un SVG (octets UTF-8). */
export const MAX_ICON_BYTES = 32 * 1024;

const SVG_NS = "http://www.w3.org/2000/svg";

/** Éléments graphiques autorisés (ni script, ni style, ni foreignObject, ni image, ni use). */
const ELEMENTS = new Set([
  "svg", "g", "defs", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "title", "desc",
  "lineargradient", "radialgradient", "stop", "clippath", "mask", "symbol",
]);

/** Attributs de présentation et de géométrie autorisés (comparés en minuscules). */
const ATTRIBUTES = new Set([
  "xmlns", "viewbox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "id",
  "fill", "fill-opacity", "fill-rule", "clip-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "opacity", "transform", "style", "class", "role", "aria-label",
  "aria-hidden", "preserveaspectratio", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "fx", "fy",
  "clip-path", "mask", "maskunits", "maskcontentunits", "clippathunits", "version", "fill-rule", "color", "display", "visibility",
]);

/** Attributs dont la valeur est une référence « url(#id) » : seule une ancre interne est acceptée. */
const REFERENCE = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;

export type IconCheck = { ok: true; svg: string } | { ok: false; error: string };

const fail = (error: string): IconCheck => ({ ok: false, error });

/** Valeur d'attribut sûre : pas de script, pas de donnée intégrée, références seulement internes. */
function safeValue(value: string): boolean {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});)/i.test(value)) return false;
  const v = value.replace(/&#x?[0-9a-f]+;/gi, "").toLowerCase();
  if (/javascript:|data:|vbscript:|expression\(|@import|<|>/.test(v)) return false;
  for (const m of value.matchAll(REFERENCE)) if (!(m[2] ?? "").startsWith("#")) return false;
  return true;
}

/** Contrôle et normalise un SVG envoyé par l'utilisateur. */
export function validateSvgIcon(input: string): IconCheck {
  if (new TextEncoder().encode(input).length > MAX_ICON_BYTES) return fail(`SVG trop volumineux (${MAX_ICON_BYTES / 1024} Kio au plus).`);
  let text = input.replace(/^\u{FEFF}/u, "").trim();
  text = text.replace(/^<\?xml[^>]*\?>\s*/i, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (text === "") return fail("Le fichier est vide.");
  if (/<!doctype|<!entity|<!\[cdata\[|<\?/i.test(text)) return fail("DOCTYPE, entités, CDATA et instructions de traitement ne sont pas acceptés.");

  const open: string[] = [];
  let root = false;
  let rootAttrs = "";
  let pos = 0;
  const tag = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)\s*>/y;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    const between = text.slice(pos, lt === -1 ? text.length : lt);
    if (between.trim() !== "") {
      // Du texte n'est admis que dans <title> et <desc>.
      const parent = open[open.length - 1];
      if (parent !== "title" && parent !== "desc") return fail("Texte inattendu dans le SVG.");
      if (!safeValue(between)) return fail("Contenu texte refusé.");
    }
    if (lt === -1) break;
    tag.lastIndex = lt;
    const m = tag.exec(text);
    if (!m) return fail("Balise mal formée.");
    pos = tag.lastIndex;
    const [, closing, rawName = "", attrText = "", selfClose] = m;
    const name = rawName.toLowerCase();
    if (!ELEMENTS.has(name)) return fail(`Élément « ${rawName} » non accepté.`);

    if (closing) {
      if (open.pop() !== name) return fail("Balises mal imbriquées.");
      continue;
    }
    if (open.length === 0) {
      if (root) return fail("Un seul élément racine <svg> est attendu.");
      if (name !== "svg") return fail("La racine doit être un élément <svg>.");
      root = true;
      rootAttrs = attrText;
    }
    // Attributs : nom="valeur" ou nom='valeur', rien d'autre.
    let rest = attrText.trim();
    const attr = /^([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')\s*/;
    while (rest !== "") {
      const a = attr.exec(rest);
      if (!a) return fail(`Attribut mal formé dans <${rawName}>.`);
      const attrName = (a[1] ?? "").toLowerCase();
      const value = a[3] ?? a[4] ?? "";
      if (attrName.startsWith("on")) return fail(`Attribut « ${a[1]} » (gestionnaire d'événement) refusé.`);
      if (attrName === "href" || attrName === "xlink:href") return fail("Les liens (href) ne sont pas acceptés.");
      if (attrName.startsWith("data-") || attrName.startsWith("xmlns:") ) { rest = rest.slice(a[0].length); continue; }
      if (!ATTRIBUTES.has(attrName)) return fail(`Attribut « ${a[1]} » non accepté.`);
      if (attrName === "xmlns" && value !== SVG_NS) return fail("Espace de noms XML inattendu.");
      if (!safeValue(value)) return fail(`Valeur refusée pour « ${a[1]} ».`);
      rest = rest.slice(a[0].length);
    }
    if (!selfClose) open.push(name);
  }
  if (!root) return fail("Aucun élément <svg>.");
  if (open.length > 0) return fail("Balise non fermée.");
  if (!/\bviewbox\s*=/i.test(rootAttrs)) return fail("Le SVG doit déclarer un « viewBox » (sinon il ne se redimensionne pas).");

  const svg = /\bxmlns\s*=/i.test(rootAttrs) ? text : text.replace(/^<\s*svg/i, `<svg xmlns="${SVG_NS}"`);
  return { ok: true, svg };
}

/** Couleur de fond : « #rrggbb » (ou « #rgb », ramenée à six chiffres), en minuscules ; null si invalide. */
export function normalizeIconColor(input: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const hex = (m[1] as string).toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
}

/** Couleur de texte lisible (noir ou blanc) sur un fond donné, d'après sa luminance relative. */
export function readableOn(color: string): "#ffffff" | "#0f172a" {
  const n = normalizeIconColor(color);
  if (!n) return "#0f172a";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0f172a" : "#ffffff";
}
