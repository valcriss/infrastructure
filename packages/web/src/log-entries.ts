import { parseAnsi, stripAnsi, type AnsiSegment } from "./ansi";

// Lignes de log prêtes à afficher : chaque ligne est analysée une seule fois, à son arrivée, et garde un
// identifiant stable. Quand les plus anciennes sont écartées, les lignes restantes gardent leur identifiant :
// l'affichage ne les recrée pas.

export interface LogEntry {
  id: number;
  /** Texte sans séquence de contrôle : filtre de recherche. */
  plain: string;
  segments: AnsiSegment[];
}

let counter = 0;

export function makeEntry(raw: string): LogEntry {
  const segments = parseAnsi(raw);
  return { id: ++counter, plain: segments.map((s) => s.text).join(""), segments };
}

/** Ajoute un lot de lignes et ne garde que les `max` dernières. */
export function appendEntries(previous: LogEntry[], batch: string[], max: number): LogEntry[] {
  const next = previous.concat(batch.map(makeEntry));
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Lignes dont le texte (sans codes de couleur) contient le filtre, sans tenir compte de la casse. */
export function filterEntries(entries: LogEntry[], filter: string): LogEntry[] {
  const f = filter.trim().toLowerCase();
  return f ? entries.filter((e) => e.plain.toLowerCase().includes(f)) : entries;
}

export { stripAnsi };
