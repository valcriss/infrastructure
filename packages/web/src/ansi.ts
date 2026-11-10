// Interprétation des codes de couleur ANSI (SGR) d'une ligne de log : texte + style, sans jamais produire de HTML.
// Les autres séquences d'échappement (déplacement du curseur, effacement, titre de fenêtre) et les caractères de
// contrôle sont retirés : ils n'ont pas de sens dans une liste de lignes.

export interface AnsiSegment {
  text: string;
  /** Style CSS en ligne ; absent pour un texte sans mise en forme. */
  css?: Record<string, string>;
}

/** Couleurs de texte (16 couleurs), choisies pour rester lisibles sur le fond sombre des logs. */
export const FG_PALETTE = [
  "#64748b", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#c084fc", "#22d3ee", "#e2e8f0",
  "#94a3b8", "#fca5a5", "#86efac", "#fde047", "#93c5fd", "#d8b4fe", "#67e8f9", "#f8fafc",
] as const;

/** Couleurs de fond : plus sombres, pour que le texte clair reste contrasté dessus. */
export const BG_PALETTE = [
  "#1e293b", "#b91c1c", "#15803d", "#a16207", "#1d4ed8", "#7e22ce", "#0e7490", "#cbd5e1",
  "#475569", "#dc2626", "#16a34a", "#ca8a04", "#2563eb", "#9333ea", "#0891b2", "#f1f5f9",
] as const;

export const DEFAULT_FG = "#e2e8f0";
export const DEFAULT_BG = "#0b1220";

interface State {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

const fresh = (): State => ({ bold: false, dim: false, italic: false, underline: false, inverse: false });

const LEVELS = [0, 95, 135, 175, 215, 255];
const hex = (r: number, g: number, b: number): string => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

/** Couleur d'un indice 0-255 (16 couleurs, cube 6×6×6, niveaux de gris). */
function indexed(n: number, bg: boolean): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return (bg ? BG_PALETTE : FG_PALETTE)[n];
  if (n < 232) {
    const c = n - 16;
    return hex(LEVELS[Math.floor(c / 36)] as number, LEVELS[Math.floor(c / 6) % 6] as number, LEVELS[c % 6] as number);
  }
  const g = 8 + 10 * (n - 232);
  return hex(g, g, g);
}

/** Luminance relative approchée (0 = noir, 1 = blanc) d'une couleur `#rrggbb`. */
function luminance(color: string): number {
  const n = parseInt(color.slice(1), 16);
  const lin = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Applique les paramètres d'une séquence « ESC [ … m » à l'état courant. */
function applySgr(state: State, params: string): void {
  const tokens = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    // Forme avec « : » (38:2::r:g:b, 38:5:n, 4:3) : les sous-paramètres sont dans le même élément.
    if (token.includes(":")) {
      const sub = token.split(":").map((p) => (p === "" ? NaN : Number(p)));
      const code = sub[0] as number;
      if (code === 38 || code === 48) {
        let color: string | undefined;
        if (sub[1] === 5) color = indexed(sub[2] as number, code === 48);
        else if (sub[1] === 2) {
          const rgb = sub.slice(-3) as [number, number, number];
          if (rgb.every(Number.isFinite)) color = hex(...rgb);
        }
        if (color) state[code === 38 ? "fg" : "bg"] = color;
      } else if (code === 4) state.underline = sub[1] !== 0;
      continue;
    }
    const code = token === "" ? 0 : Number(token);
    if (!Number.isInteger(code)) continue;
    if (code === 38 || code === 48) {
      const mode = Number(tokens[i + 1]);
      if (mode === 5) {
        const color = indexed(Number(tokens[i + 2]), code === 48);
        if (color) state[code === 38 ? "fg" : "bg"] = color;
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [Number(tokens[i + 2]), Number(tokens[i + 3]), Number(tokens[i + 4])];
        if ([r, g, b].every(Number.isFinite)) state[code === 38 ? "fg" : "bg"] = hex(r, g, b);
        i += 4;
      } else i += 1;
      continue;
    }
    if (code === 0) Object.assign(state, fresh(), { fg: undefined, bg: undefined });
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4 || code === 21) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code >= 30 && code <= 37) state.fg = FG_PALETTE[code - 30];
    else if (code === 39) state.fg = undefined;
    else if (code >= 40 && code <= 47) state.bg = BG_PALETTE[code - 40];
    else if (code === 49) state.bg = undefined;
    else if (code >= 90 && code <= 97) state.fg = FG_PALETTE[code - 90 + 8];
    else if (code >= 100 && code <= 107) state.bg = BG_PALETTE[code - 100 + 8];
  }
}

function cssOf(s: State): Record<string, string> | undefined {
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) [fg, bg] = [bg ?? DEFAULT_BG, fg ?? DEFAULT_FG];
  // Un fond sans couleur de texte : on choisit un texte lisible sur ce fond.
  if (bg && !fg) fg = luminance(bg) > 0.4 ? DEFAULT_BG : DEFAULT_FG;
  const css: Record<string, string> = {};
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  if (s.bold) css.fontWeight = "700";
  if (s.italic) css.fontStyle = "italic";
  if (s.underline) css.textDecoration = "underline";
  if (s.dim) css.opacity = "0.65";
  return Object.keys(css).length > 0 ? css : undefined;
}

// Séquences à interpréter ou à retirer. Les caractères de contrôle sont voulus : c'est ce que l'on cherche.
const TOKEN = new RegExp(
  [
    "\\u001b\\[([0-?]*)[ -/]*([@-~])", // CSI : paramètres, octet final (« m » = couleurs)
    "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\|$)", // OSC (titre de fenêtre, lien) terminé par BEL ou ESC \
    "\\u001b[@-Z\\\\-_]?", // séquence à deux caractères, ou ESC isolé
    "[\\u0000-\\u0008\\u000b-\\u001a\\u001c-\\u001f\\u007f]", // autres caractères de contrôle (la tabulation est conservée)
  ].join("|"),
  "g",
);

/** Une ligne de log en segments de texte stylés. Le texte est celui du conteneur, jamais interprété comme du HTML. */
export function parseAnsi(line: string): AnsiSegment[] {
  // Barres de progression : les « \r » réécrivent la ligne, seule la dernière version compte.
  const text = line.includes("\r") ? (line.split("\r").filter((p) => p !== "").pop() ?? "") : line;
  const out: AnsiSegment[] = [];
  const state = fresh();
  let last = 0;
  const push = (to: number): void => {
    if (to <= last) return;
    const css = cssOf(state);
    out.push({ text: text.slice(last, to), ...(css ? { css } : {}) });
  };
  for (const m of text.matchAll(TOKEN)) {
    push(m.index);
    last = m.index + m[0].length;
    if (m[2] === "m") applySgr(state, m[1] ?? "");
  }
  push(text.length);
  return out;
}

/** Le texte d'une ligne sans aucune séquence de contrôle (filtre de recherche, copie). */
export const stripAnsi = (line: string): string => parseAnsi(line).map((s) => s.text).join("");
