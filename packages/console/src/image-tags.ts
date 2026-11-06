export type UpdatePolicy = "same_tag" | "patch" | "minor" | "major" | "pattern";
export const POLICIES: UpdatePolicy[] = ["same_tag", "patch", "minor", "major", "pattern"];

export interface ParsedTag {
  prefix: string;
  nums: number[];
  /** Suffixe de variante : `-alpine`, `-bookworm-slim`… Doit être identique pour comparer deux tags. */
  suffix: string;
  prerelease: boolean;
}

const PRERELEASE = /(^|[-_.+])(alpha|beta|rc|pre|preview|dev|snapshot|nightly|canary|test|unstable|edge|next)(\d|[-_.+]|$)/i;

/**
 * Lit un tag de type version (`1.27.3-alpine`, `v2.1`). Retourne null pour un
 * tag non interprétable (`latest`, `stable`, `bookworm`, `20241106`) : on ne
 * suppose ni SemVer, ni qu'un tri alphabétique donne la dernière version.
 */
export function parseTag(tag: string): ParsedTag | null {
  const m = /^(v?)(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?([-_+.][A-Za-z0-9._+-]*)?$/.exec(tag);
  if (!m) return null;
  const nums = [m[2], m[3], m[4], m[5]].filter((x): x is string => x !== undefined).map(Number);
  // Un tag de date (20241106) n'est pas une version : un seul gros nombre sans point.
  if (nums.length === 1 && (m[2] as string).length >= 6) return null;
  const suffix = m[6] ?? "";
  return { prefix: m[1] ?? "", nums, suffix, prerelease: PRERELEASE.test(suffix) };
}

const shapeOf = (suffix: string): string => suffix.replace(/\d+/g, "#");

function compareNums(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Tri « naturel » décroissant (les nombres sont comparés comme des nombres). */
export function naturalDesc(a: string, b: string): number {
  return b.localeCompare(a, "en", { numeric: true });
}

// Expressions de suivi : sous-ensemble sûr (pas de groupe quantifié, pas de rétro-référence)
// pour éviter les expressions à backtracking catastrophique sur des milliers de tags.
const SAFE_PATTERN_CHARS = /^[A-Za-z0-9._\-+*?^$|\\[\](){},]*$/;

export function validatePattern(pattern: string): string | null {
  if (pattern.length === 0 || pattern.length > 100) return "Expression vide ou trop longue (100 caractères maximum).";
  if (!SAFE_PATTERN_CHARS.test(pattern)) return "Caractères non autorisés dans l'expression.";
  if (/\)\s*[*+{]/.test(pattern)) return "Les groupes répétés ((…)+, (…)*, (…){n}) ne sont pas autorisés.";
  if (/\\[1-9]|\(\?[<=!]/.test(pattern)) return "Références arrière et assertions ne sont pas autorisées.";
  try {
    new RegExp(pattern);
  } catch {
    return "Expression régulière invalide.";
  }
  return null;
}

export interface CandidateResult {
  candidates: string[];
  /** Vrai quand la décision repose sur une heuristique (tag non interprétable, expression libre). */
  uncertain: boolean;
  notes: string[];
}

const MAX_CANDIDATES = 5;
const MAX_TAGS_SCANNED = 20_000;

/**
 * Cherche de nouveaux tags candidats selon la politique du composant.
 * Les préversions sont exclues (sauf si le tag actuel en est une) et seuls
 * des tags de même variante (suffixe) et de même précision sont comparés :
 * `1.27-alpine` ne propose jamais `1.28.1` ni `1.28`.
 */
export function pickCandidates(current: string, tags: string[], policy: UpdatePolicy, pattern?: string | null): CandidateResult {
  const notes: string[] = [];
  if (policy === "same_tag") return { candidates: [], uncertain: false, notes };

  const pool = tags.slice(0, MAX_TAGS_SCANNED).filter((t) => t !== current);

  if (policy === "pattern") {
    const err = pattern ? validatePattern(pattern) : "Expression absente.";
    if (err) return { candidates: [], uncertain: true, notes: [err] };
    const re = new RegExp(pattern as string);
    const started = Date.now();
    const hits: string[] = [];
    for (const t of pool) {
      if (Date.now() - started > 250) {
        notes.push("Recherche interrompue (expression trop coûteuse).");
        break;
      }
      if (re.test(t)) hits.push(t);
    }
    // Ordre naturel : sans connaître la sémantique des tags, la nouveauté est une hypothèse.
    const newer = hits.filter((t) => naturalDesc(t, current) < 0).sort(naturalDesc);
    return { candidates: newer.slice(0, MAX_CANDIDATES), uncertain: true, notes: [...notes, "Candidats déduits de l'expression : l'ordre des tags est supposé, pas garanti."] };
  }

  const cur = parseTag(current);
  if (!cur) {
    // Tag non interprétable : on cherche des tags de même forme (chiffres → \d+), en le signalant.
    if (!/\d/.test(current)) {
      return { candidates: [], uncertain: true, notes: [`Le tag « ${current} » est flottant : seul le suivi du contenu (même tag) est pertinent.`] };
    }
    const shape = new RegExp("^" + current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+/g, "\\d+") + "$");
    const similar = pool.filter((t) => shape.test(t) && naturalDesc(t, current) < 0).sort(naturalDesc);
    return {
      candidates: similar.slice(0, MAX_CANDIDATES),
      uncertain: true,
      notes: [`Le tag « ${current} » n'est pas une version : candidats de même forme, ordre supposé.`],
    };
  }

  if (policy === "patch" && cur.nums.length < 3) {
    return { candidates: [], uncertain: false, notes: [`Le tag « ${current} » n'a pas de niveau patch : il suit déjà les correctifs, surveillez son contenu (même tag).`] };
  }
  if (policy === "minor" && cur.nums.length < 2) {
    return { candidates: [], uncertain: false, notes: [`Le tag « ${current} » n'a pas de niveau mineur : choisissez « majeure ».`] };
  }

  const found: { tag: string; nums: number[] }[] = [];
  for (const t of pool) {
    const p = parseTag(t);
    if (!p || p.prefix !== cur.prefix || p.nums.length !== cur.nums.length) continue;
    if (p.prerelease && !cur.prerelease) continue;
    // Variante identique ; pour une préversion (-rc1 → -rc2), seule la numérotation de la préversion peut changer.
    const sameVariant = cur.prerelease ? shapeOf(p.suffix) === shapeOf(cur.suffix) : p.suffix === cur.suffix;
    if (!sameVariant) continue;
    const order = compareNums(p.nums, cur.nums);
    if (order < 0 || (order === 0 && (!cur.prerelease || naturalDesc(p.suffix, cur.suffix) >= 0))) continue;
    const sameMajor = p.nums[0] === cur.nums[0];
    const sameMinor = sameMajor && p.nums[1] === cur.nums[1];
    if (policy === "patch" && !sameMinor) continue;
    if (policy === "minor" && !sameMajor) continue;
    found.push({ tag: t, nums: p.nums });
  }
  found.sort((a, b) => compareNums(b.nums, a.nums) || naturalDesc(a.tag, b.tag));
  return { candidates: found.slice(0, MAX_CANDIDATES).map((f) => f.tag), uncertain: false, notes };
}
