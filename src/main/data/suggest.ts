// Typo-tolerant title matching for search suggestions, over every title
// moviebox-tui has already fetched (its caches) plus history and favorites.
import type { Suggestion } from '@shared/types';

export interface KnownTitle {
  title: string;
  year?: string;
  kind?: string;
  cover?: string;
  subjectId?: string;
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The TUI shows dubs (`Dune [Hindi]`) and bundles (`… S1-S4`) under the plain title. */
export const displayTitle = (t: string) => t.replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+S\d+(?:\s*-\s*S?\d+)?\s*$/i, '').trim();

/** Optimal-string-alignment distance (Levenshtein plus adjacent swaps). */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

const similarity = (a: string, b: string) => 1 - distance(a, b) / Math.max(a.length, b.length);

/** How well one typed word matches one title word (the last typed word may be unfinished). */
function wordScore(q: string, w: string): number {
  if (w === q) return 1;
  if (w.startsWith(q)) return q.length >= 2 ? 0.95 : 0.6;
  if (q.length >= 3 && w.includes(q)) return 0.75;
  if (q.length < 3) return 0;
  const whole = similarity(q, w);
  const prefix = w.length > q.length ? similarity(q, w.slice(0, q.length)) * 0.92 : 0;
  return Math.max(whole, prefix);
}

/** 0 = no match; ~1 = every typed word matches; >1 = the title starts with what was typed. */
export function scoreTitle(query: string, title: string): number {
  const q = normalize(query);
  const t = normalize(title);
  if (!q || !t) return 0;
  if (t === q) return 2;
  if (t.startsWith(q)) return 1.6;

  let score = 0;
  const words = q.split(' ');
  const titleWords = t.split(' ');
  let matched = true;
  let sum = 0;
  for (const w of words) {
    const best = Math.max(...titleWords.map((x) => wordScore(w, x)));
    if (best < 0.6) {
      matched = false;
      break;
    }
    sum += best;
  }
  // Words the query doesn't mention count a little against a title: "breking bad" is nearer
  // "Breaking Bad" than "El Camino: A Breaking Bad Movie".
  if (matched) score = (sum / words.length) * (0.85 + 0.15 * Math.min(1, words.length / titleWords.length));

  // Spacing and punctuation differences: "spiderman" ↔ "Spider-Man".
  const cq = q.replace(/ /g, '');
  const ct = t.replace(/ /g, '');
  if (ct.startsWith(cq)) score = Math.max(score, 1.3);
  else if (cq.length >= 4) score = Math.max(score, similarity(cq, ct.slice(0, cq.length)) * 0.95);
  return score >= 0.72 ? score : 0;
}

export function suggestTitles(query: string, titles: KnownTitle[], limit = 8): Suggestion[] {
  if (normalize(query).length < 2) return [];
  const best = new Map<string, { s: Suggestion; score: number }>();
  for (const t of titles) {
    const shown = displayTitle(t.title);
    const score = scoreTitle(query, shown);
    if (!score) continue;
    // MovieBox lists a series once per season, each with its own year: suggest it once, from its first year.
    const series = /series|tv/i.test(t.kind ?? '');
    const key = `${normalize(shown)}|${series ? 'series' : (t.year ?? '')}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, { score, s: { title: shown, year: t.year, kind: t.kind, cover: t.cover, subjectId: t.subjectId, source: 'known' } });
      continue;
    }
    prev.score = Math.max(prev.score, score);
    if (t.year && (!prev.s.year || Number(t.year) < Number(prev.s.year))) prev.s = { ...prev.s, year: t.year, subjectId: t.subjectId ?? prev.s.subjectId, cover: t.cover ?? prev.s.cover };
    else if (!prev.s.cover && t.cover) prev.s = { ...prev.s, cover: t.cover };
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || Number(b.s.year ?? 0) - Number(a.s.year ?? 0))
    .slice(0, limit)
    .map((x) => x.s);
}
