export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

/** Au-delà de ce nombre de cases, on évite le calcul exact (mémoire). */
const MAX_CELLS = 4_000_000;

/** Différences ligne à ligne (plus longue sous-séquence commune). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  // Retire le préfixe et le suffixe communs pour réduire le calcul.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ type: "same", text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ type: "same", text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);

  if (x.length * y.length > MAX_CELLS) {
    return [
      ...head,
      ...x.map((text): DiffLine => ({ type: "del", text })),
      ...y.map((text): DiffLine => ({ type: "add", text })),
      ...tail,
    ];
  }

  // table[i][j] = longueur de la plus longue sous-séquence commune de x[i..] et y[j..]
  const table: Uint32Array[] = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      table[i]![j] = x[i] === y[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      middle.push({ type: "same", text: x[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      middle.push({ type: "del", text: x[i++]! });
    } else {
      middle.push({ type: "add", text: y[j++]! });
    }
  }
  while (i < x.length) middle.push({ type: "del", text: x[i++]! });
  while (j < y.length) middle.push({ type: "add", text: y[j++]! });
  return [...head, ...middle, ...tail];
}

export const hasChanges = (lines: DiffLine[]): boolean => lines.some((l) => l.type !== "same");
