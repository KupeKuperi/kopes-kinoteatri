// IMDb ratings and IMDb-ranked lists.
//
// Ratings come from IMDb's official daily dataset (title.ratings.tsv.gz,
// ~9 MB, free for personal use), refreshed weekly. Titles, years and posters
// come from Cinemeta — the metadata add-on moviebox-tui itself is configured
// with. This is metadata only: finding and playing a title is still done by
// the engine on the active source.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ImdbRating } from '@shared/types';
import { displayTitle } from './suggest';

const CINEMETA = 'https://v3-cinemeta.strem.io';
const RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const DAY = 24 * 3600 * 1000;
/** Title → IMDb id matches; renamed whenever the matching rules change, so old matches are redone. */
const IDS_FILE = 'ids-v2.json';

export type ImdbListKind = 'movies' | 'series' | 'new-movies' | 'new-series';

export interface ImdbTitle {
  id: string;
  type: 'movie' | 'series';
  title: string;
  year?: string;
  poster?: string;
  genres?: string[];
  rating: number;
  votes: number;
}

interface CinemetaMeta {
  id?: string;
  imdb_id?: string;
  type?: string;
  name?: string;
  releaseInfo?: string;
  year?: string;
  poster?: string;
  genres?: string[];
  imdbRating?: string;
}

type Fetch = (url: string) => Promise<Response>;

const LIST_RULES: Record<ImdbListKind, { type: 'movie' | 'series'; minVotes: number; label: string }> = {
  movies: { type: 'movie', minVotes: 50000, label: 'Top Rated Movies' },
  series: { type: 'series', minVotes: 25000, label: 'Top Rated Series' },
  // New titles need a real audience too, or a few hundred enthusiastic voters top the list.
  'new-movies': { type: 'movie', minVotes: 10000, label: 'Best New Movies' },
  'new-series': { type: 'series', minVotes: 5000, label: 'Best New Series' },
};

export const listLabel = (kind: ImdbListKind) => LIST_RULES[kind].label;
export const listMinVotes = (kind: ImdbListKind) => LIST_RULES[kind].minVotes;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Is score tuple `a` ahead of `b` (compared position by position)? */
function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** "2008–2013" / "2019–" / "2014" → [start, end]. */
function yearRange(info?: string): [number, number] | null {
  const m = /(\d{4})(?:\s*[–-]\s*(\d{4})?)?/.exec(info ?? '');
  if (!m) return null;
  const start = Number(m[1]);
  const open = /[–-]\s*$/.test(info ?? '');
  return [start, m[2] ? Number(m[2]) : open ? new Date().getFullYear() + 1 : start];
}

export class ImdbService {
  private ratings: Map<string, [number, number]> | null = null;
  private ratingsLoad: Promise<Map<string, [number, number]>> | null = null;
  private lists = new Map<ImdbListKind, { at: number; items: ImdbTitle[] }>();
  private ids: Record<string, { id: string | null; at: number }> = {};
  private inflight = new Map<string, Promise<ImdbRating | null>>();
  private idsDirty = false;
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(
    private readonly dir: string,
    private readonly fetchFn: Fetch = (url) => fetch(url),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      this.ids = JSON.parse(fs.readFileSync(path.join(dir, IDS_FILE), 'utf8'));
    } catch {
      this.ids = {};
    }
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'lists.json'), 'utf8')) as Record<string, { at: number; items: ImdbTitle[] }>;
      for (const [k, v] of Object.entries(saved)) this.lists.set(k as ImdbListKind, v);
    } catch {
      /* first run */
    }
  }

  // ── network helpers ──────────────────────────────────────────────────────

  /** At most 6 requests at a time, so a results page doesn't flood Cinemeta. */
  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= 6) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async json<T>(url: string): Promise<T> {
    return this.limited(async () => {
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return (await res.json()) as T;
    });
  }

  // ── ratings dataset ──────────────────────────────────────────────────────

  private async loadRatings(): Promise<Map<string, [number, number]>> {
    if (this.ratings) return this.ratings;
    this.ratingsLoad ??= (async () => {
      const file = path.join(this.dir, 'title.ratings.tsv.gz');
      let fresh = false;
      try {
        fresh = Date.now() - fs.statSync(file).mtimeMs < 7 * DAY;
      } catch {
        /* not downloaded yet */
      }
      if (!fresh) {
        try {
          const res = await this.fetchFn(RATINGS_URL);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const tmp = `${file}.part`;
          fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
          fs.renameSync(tmp, file);
        } catch (e) {
          if (!fs.existsSync(file)) throw new Error(`IMDb ratings could not be downloaded (${String(e)})`);
          // keep using last week's copy
        }
      }
      const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
      const map = new Map<string, [number, number]>();
      let start = text.indexOf('\n') + 1; // skip header
      while (start > 0 && start < text.length) {
        const end = text.indexOf('\n', start);
        const line = text.slice(start, end < 0 ? undefined : end);
        start = end < 0 ? -1 : end + 1;
        const t1 = line.indexOf('\t');
        const t2 = line.indexOf('\t', t1 + 1);
        const votes = Number(line.slice(t2 + 1));
        if (votes < 500) continue; // too few votes to mean much
        map.set(line.slice(0, t1), [Number(line.slice(t1 + 1, t2)), votes]);
      }
      this.ratings = map;
      return map;
    })();
    try {
      return await this.ratingsLoad;
    } catch (e) {
      this.ratingsLoad = null;
      throw e;
    }
  }

  // ── lists ────────────────────────────────────────────────────────────────

  async list(kind: ImdbListKind, limit = 60): Promise<ImdbTitle[]> {
    const cached = this.lists.get(kind);
    if (cached && Date.now() - cached.at < 3 * DAY && cached.items.length) return cached.items;

    const rule = LIST_RULES[kind];
    const ratings = await this.loadRatings();
    const pages: string[] = [];
    if (kind === 'movies' || kind === 'series') {
      // ~1,000 popular titles: every IMDb Top 250 classic is among them.
      for (let skip = 0; skip < 1000; skip += 50) pages.push(`${CINEMETA}/catalog/${rule.type}/top/${skip ? `skip=${skip}` : ''}`.replace(/\/$/, '') + '.json');
    } else {
      const year = new Date().getFullYear();
      for (const y of [year, year - 1]) for (let skip = 0; skip < 300; skip += 50) pages.push(`${CINEMETA}/catalog/${rule.type}/year/genre=${y}${skip ? `&skip=${skip}` : ''}.json`);
    }
    const metas = (await Promise.all(pages.map((u) => this.json<{ metas?: CinemetaMeta[] }>(u).then((r) => r.metas ?? [], () => [] as CinemetaMeta[])))).flat();

    const seen = new Set<string>();
    const items: ImdbTitle[] = [];
    for (const m of metas) {
      const id = m.imdb_id ?? m.id;
      if (!id?.startsWith('tt') || seen.has(id) || !m.name) continue;
      seen.add(id);
      const r = ratings.get(id);
      if (!r || r[1] < rule.minVotes) continue;
      items.push({
        id,
        type: rule.type,
        title: m.name,
        year: yearRange(m.releaseInfo ?? m.year)?.[0]?.toString(),
        poster: m.poster || `https://images.metahub.space/poster/medium/${id}/img`,
        genres: m.genres,
        rating: r[0],
        votes: r[1],
      });
    }
    items.sort((a, b) => b.rating - a.rating || b.votes - a.votes);
    const top = items.slice(0, limit);
    if (top.length) {
      this.lists.set(kind, { at: Date.now(), items: top });
      this.saveLists();
    }
    return top;
  }

  private saveLists() {
    try {
      fs.writeFileSync(path.join(this.dir, 'lists.json'), JSON.stringify(Object.fromEntries(this.lists)));
    } catch {
      /* cache only */
    }
  }

  // ── rating for a title the engine found ──────────────────────────────────

  /** IMDb rating for a title from a source's results, matched by name, kind and year. */
  lookup(rawTitle: string, year?: string, kind?: string): Promise<ImdbRating | null> {
    // Sources tag dubs and bundles in titles ("Interstellar [Hindi]", "Breaking Bad S1-S5").
    const title = displayTitle(rawTitle);
    const type = /series|tv/i.test(kind ?? '') ? 'series' : /movie/i.test(kind ?? '') ? 'movie' : undefined;
    const key = `${type ?? 'any'}|${norm(title)}|${year ?? ''}`;
    const known = this.ids[key];
    if (known && Date.now() - known.at < (known.id ? 30 : 3) * DAY) {
      return known.id ? this.ratingFor(known.id) : Promise.resolve(null);
    }
    let p = this.inflight.get(key);
    if (!p) {
      p = this.resolve(title, year, type)
        .then((id) => {
          this.ids[key] = { id, at: Date.now() };
          this.scheduleSaveIds();
          return id ? this.ratingFor(id) : null;
        })
        .catch(() => null)
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async ratingFor(id: string): Promise<ImdbRating | null> {
    const ratings = await this.loadRatings().catch(() => null);
    const r = ratings?.get(id);
    return r ? { id, rating: r[0], votes: r[1] } : null;
  }

  private async resolve(title: string, year: string | undefined, type: 'movie' | 'series' | undefined): Promise<string | null> {
    const want = norm(title);
    if (!want) return null;
    const y = year ? Number(year) : undefined;
    const ratings = await this.loadRatings().catch(() => null);
    let best: { id: string; rank: number[] } | null = null;
    for (const t of type ? [type] : (['movie', 'series'] as const)) {
      const res = await this.json<{ metas?: CinemetaMeta[] }>(`${CINEMETA}/catalog/${t}/top/search=${encodeURIComponent(title)}.json`).catch(() => ({ metas: [] }));
      for (const m of res.metas ?? []) {
        const id = m.imdb_id ?? m.id;
        if (!id?.startsWith('tt')) continue;
        // The same name, or that name plus a subtitle IMDb uses ("Dune" is "Dune: Part One" there).
        const base = /^(.*?)\s*[:–—-]\s+\S/.exec(m.name ?? '')?.[1];
        const nameScore = norm(m.name ?? '') === want ? 2 : base && norm(base) === want ? 1 : 0;
        if (!nameScore) continue;
        const votes = ratings?.get(id)?.[1] ?? 0;
        const range = yearRange(m.releaseInfo ?? m.year);
        let yearScore = 2; // no year to compare
        if (y && range) {
          const off = Math.abs(range[0] - y);
          if (off === 0) yearScore = 5;
          else if (t === 'series' && y >= range[0] && y <= range[1]) yearScore = 4; // a later season's year
          else if (off === 1) yearScore = 3;
          // Cinemeta can list a film by its later US release ("Spirited Away": 2003, made in 2001);
          // only well-known titles get that leeway, so remakes years apart stay apart.
          else if (off <= 3 && nameScore === 2 && votes >= 5000) yearScore = 1;
          else yearScore = 0;
        }
        if (!yearScore || (nameScore === 1 && yearScore < 3)) continue; // a subtitled name needs the year too
        // Among equal years, a title people actually rated beats an obscure namesake.
        const rank = [yearScore, votes >= 1000 ? 1 : 0, nameScore, votes];
        if (!best || better(rank, best.rank)) best = { id, rank };
      }
    }
    return best?.id ?? null;
  }

  private saveTimer: NodeJS.Timeout | null = null;
  private scheduleSaveIds() {
    this.idsDirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.idsDirty) return;
      this.idsDirty = false;
      try {
        fs.writeFileSync(path.join(this.dir, IDS_FILE), JSON.stringify(this.ids));
      } catch {
        /* cache only */
      }
    }, 2000);
  }
}
