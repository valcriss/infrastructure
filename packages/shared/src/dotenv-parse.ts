export interface DotenvIssue {
  line: number;
  message: string;
}

export interface DotenvParsed {
  values: Record<string, string>;
  issues: DotenvIssue[];
  /** Variables dont la valeur contient un `$` interprété par Docker Compose (non protégé) : la console l'enregistre tel quel. */
  interpolated: string[];
}

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Retire un éventuel commentaire en fin de ligne (` # ...`) après une valeur entre guillemets. */
const trailingOk = (rest: string): boolean => rest.trim() === "" || rest.trim().startsWith("#");

/**
 * Lit un fichier `.env` au format Docker Compose : commentaires, lignes vides, `export`, valeurs sans guillemets,
 * entre guillemets simples (littérales) ou doubles (séquences d'échappement). Les erreurs sont signalées par ligne,
 * la lecture continue ; une clé répétée garde la dernière valeur, comme Compose.
 */
export function parseDotenv(text: string): DotenvParsed {
  const values: Record<string, string> = {};
  const issues: DotenvIssue[] = [];
  const interpolated = new Set<string>();
  text.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!m) {
      issues.push({ line, message: `Ligne ignorée : « ${trimmed.slice(0, 40)} » (attendu NOM=valeur).` });
      return;
    }
    const key = m[1] as string;
    const rest = m[2] as string;
    if (!KEY.test(key)) {
      issues.push({ line, message: `Nom de variable invalide : « ${key} ».` });
      return;
    }
    let value: string;
    let literal = false;
    if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0 || !trailingOk(rest.slice(end + 1))) {
        issues.push({ line, message: `${key} : guillemet simple non refermé (ou texte après la valeur).` });
        return;
      }
      value = rest.slice(1, end);
      literal = true;
    } else if (rest.startsWith('"')) {
      let out = "";
      let j = 1;
      let closed = false;
      for (; j < rest.length; j++) {
        const c = rest[j] as string;
        if (c === "\\" && j + 1 < rest.length) {
          const n = rest[j + 1] as string;
          out += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n === "$" ? "\u0000$" : n;
          j++;
        } else if (c === '"') {
          closed = true;
          break;
        } else out += c;
      }
      if (!closed || !trailingOk(rest.slice(j + 1))) {
        issues.push({ line, message: `${key} : guillemet double non refermé (ou texte après la valeur).` });
        return;
      }
      // Un `$` échappé (`\$`) est littéral ; les autres seraient interpolés par Compose.
      value = out.replaceAll("\u0000$", "\u0001");
      if (/\$/.test(value)) interpolated.add(key);
      else interpolated.delete(key);
      value = value.replaceAll("\u0001", "$");
    } else {
      const hash = rest.search(/\s#/);
      value = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
      if (/\$/.test(value)) interpolated.add(key);
      else interpolated.delete(key);
    }
    if (literal) interpolated.delete(key);
    values[key] = value;
  });
  return { values, issues, interpolated: [...interpolated].filter((k) => k in values).sort() };
}
