// Indexes the TUI's on-disk response caches so the GUI can show posters,
// synopses and stream metadata for whatever the engine just loaded.
import fs from 'node:fs';
import path from 'node:path';
import type { Caption, DetailsInfo } from '@shared/types';
import {
  mapCaptionsPayload,
  mapDetailsPayload,
  mapHomepagePayload,
  mapSearchPayload,
  mapStreamsPayload,
  readMbc,
  type CachedStream,
  type CachedSubject,
} from './mbc';

interface Indexed<T> {
  value: T;
  mtime: number;
}

const NON_PROVIDER_DIRS = new Set(['logs', 'tv_playlists']);

/** Lower-case, drop dub/edition suffixes like ` [Hindi]` or ` S1-S4` the TUI hides in lists. */
export function normalizeTitle(title: string): string {
  return title
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s+S\d+(?:\s*-\s*S?\d+)?\s*$/i, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** File time, or 0 if the file vanished in the meantime (the TUI prunes its caches). */
const mtimeOf = (file: string) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** Display name of a source (as the TUI labels it) → the id its caches use. */
export function providerId(display?: string | null): string | undefined {
  if (!display) return undefined;
  const k = display.toLowerCase().replace(/[^a-z0-9]/g, '');
  const known: Record<string, string> = { moviebox: 'moviebox', '4khdhub': 'fourkhdhub', '4khd': 'fourkhdhub', fourkhdhub: 'fourkhdhub', dramachi: 'dramachi', addons: 'addons', circleftp: 'bdix_circleftp', dhakaflix: 'bdix_dhakaflix' };
  return known[k] ?? k;
}

const kindOf = (displayType?: string) => {
  const t = (displayType ?? '').toLowerCase();
  if (t.startsWith('movie')) return 'movie';
  if (t.startsWith('series') || t.startsWith('tv')) return 'series';
  return t;
};

export class CacheIndex {
  /**
   * Entries as the TUI lists them (search results, homepage feed). Kept apart
   * from details on purpose: details carry a series' first-air year, while the
   * lists show each season as its own entry with that season's year
   * ("The Office S9", 2012) — overwriting one with the other loses the match.
   */
  private listings = new Map<string, Indexed<CachedSubject>>();
  private details = new Map<string, Indexed<DetailsInfo> & { hash: string; dir: string }>();
  /** Ratings the homepage feed ships for its entries (keyed by subject id). */
  private listRatings = new Map<string, string>();
  private seen = new Map<string, string>();

  constructor(private readonly root: string) {}

  private providerDirs(): string[] {
    try {
      return fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !NON_PROVIDER_DIRS.has(d.name))
        .map((d) => path.join(this.root, d.name));
    } catch {
      return [];
    }
  }

  private changedFiles(dir: string): Array<{ file: string; mtime: number }> {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: Array<{ file: string; mtime: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.cache')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        const sig = `${st.mtimeMs}:${st.size}`;
        if (this.seen.get(file) === sig) continue;
        out.push({ file, mtime: st.mtimeMs });
        this.seen.set(file, sig);
      } catch {
        /* removed while scanning */
      }
    }
    return out;
  }

  private lastRefresh = 0;

  /** Picks up new and changed cache files (at most every 300 ms; lookups come in bursts). */
  refresh(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastRefresh < 300) return;
    this.lastRefresh = now;
    for (const dir of this.providerDirs()) {
      // Seasons of one show share a subject id but are listed separately
      // ("The Office S8" 2011, "The Office S9" 2012), so the key includes title and year.
      const addListing = (s: CachedSubject, mtime: number) => {
        const key = `${s.provider}:${s.id}:${s.title}:${s.year ?? ''}`;
        const prev = this.listings.get(key);
        if (!prev || prev.mtime <= mtime) this.listings.set(key, { value: { ...s, cover: s.cover ?? prev?.value.cover }, mtime });
      };
      for (const { file, mtime } of this.changedFiles(path.join(dir, 'search'))) {
        const mbc = this.safeRead(file);
        if (mbc) for (const s of mapSearchPayload(mbc.payload)) addListing(s, mtime);
      }
      // homepage/home_<tab>_<page>.cache: the feed behind the Discover categories.
      for (const { file, mtime } of this.changedFiles(path.join(dir, 'homepage'))) {
        const mbc = this.safeRead(file);
        if (!mbc) continue;
        const { items, ratings } = mapHomepagePayload(mbc.payload);
        for (const s of items) addListing(s, mtime);
        for (const [id, r] of ratings) this.listRatings.set(id, r);
      }
      for (const { file, mtime } of this.changedFiles(path.join(dir, 'details'))) {
        const mbc = this.safeRead(file);
        const info = mbc && mapDetailsPayload(mbc.payload);
        if (!info) continue;
        // 4KHDHub versions its file names (details_v2_<hash>, streams/v4_<hash>_…); match on <hash>.
        const hash = (/^details_(\w+)\.cache$/.exec(path.basename(file))?.[1] ?? '').replace(/^v\d+_/, '');
        this.details.set(`${info.provider}:${info.subjectId}`, { value: info, mtime, hash, dir });
      }
    }
  }

  /** Listing entries first, then titles only known from opened details. */
  private *candidates(): Generator<Indexed<CachedSubject>> {
    yield* this.listings.values();
    for (const d of this.details.values()) {
      const v = d.value;
      yield { value: { provider: v.provider, id: v.subjectId, title: v.title, kind: v.kind, year: v.year, cover: v.cover }, mtime: d.mtime };
    }
  }

  private safeRead(file: string) {
    try {
      return readMbc(file);
    } catch {
      // Probably mid-write; forget the signature so the next refresh retries.
      this.seen.delete(file);
      return null;
    }
  }

  /** Best cached subject for a card the TUI displayed. */
  findSubject(title: string, year?: string, displayType?: string, provider?: string): CachedSubject | null {
    this.refresh();
    const norm = normalizeTitle(title);
    const kind = kindOf(displayType);
    let best: { s: Indexed<CachedSubject>; score: number } | null = null;
    for (const s of this.candidates()) {
      const v = s.value;
      let score = 0;
      if (v.title === title) score += 4;
      else if (normalizeTitle(v.title) === norm) score += 2;
      else continue;
      if (year && v.year === year) score += 2;
      else if (year && v.year && v.year !== year) continue;
      if (kind && v.kind === kind) score += 1;
      if (provider && v.provider === provider) score += 3; // the source the card came from
      if (!/\[[^\]]*\]/.test(v.title)) score += 1; // prefer original audio over dubs
      if (!best || score > best.score || (score === best.score && s.mtime > best.s.mtime)) best = { s, score };
    }
    if (!best && year) {
      // No entry for that exact year: another season or edition of the same title
      // (same name and type, nearest year) carries the right poster.
      let near: { s: Indexed<CachedSubject>; gap: number } | null = null;
      for (const s of this.candidates()) {
        const v = s.value;
        if (normalizeTitle(v.title) !== norm || (kind && v.kind !== kind) || !v.cover) continue;
        const gap = Math.abs(Number(v.year) - Number(year)) + (/\[[^\]]*\]/.test(v.title) ? 0.5 : 0);
        if (Number.isFinite(gap) && (!near || gap < near.gap)) near = { s, gap };
      }
      if (near) return { ...near.s.value, year };
    }
    if (best && !best.s.value.cover) {
      // Same subject seen elsewhere with a poster (e.g. details fetched later).
      const { provider, id } = best.s.value;
      const cover =
        this.details.get(`${provider}:${id}`)?.value.cover ??
        [...this.listings.values()].find((l) => l.value.provider === provider && l.value.id === id && l.value.cover)?.value.cover;
      if (cover) return { ...best.s.value, cover };
    }
    return best?.s.value ?? null;
  }

  /** Details for the title shown on the TUI's details screen. */
  /**
   * Details for the title shown on the TUI's details screen. With `provider`,
   * only that source's details count: the same title in another source has
   * different seasons, episodes and streams.
   */
  findDetails(title: string, opts: { year?: string; subjectId?: string; newerThan?: number; provider?: string } = {}): DetailsInfo | null {
    this.refresh();
    if (opts.subjectId) {
      for (const d of this.details.values()) {
        if (d.value.subjectId === opts.subjectId && (!opts.provider || d.value.provider === opts.provider)) return d.value;
      }
    }
    const norm = normalizeTitle(title);
    let best: (Indexed<DetailsInfo> & { score: number }) | null = null;
    for (const d of this.details.values()) {
      if (opts.newerThan && d.mtime < opts.newerThan) continue;
      if (opts.provider && d.value.provider !== opts.provider) continue;
      const v = d.value;
      let score = 0;
      if (v.title === title) score += 4;
      else if (normalizeTitle(v.title) === norm) score += 2;
      else continue;
      if (opts.year && v.year === opts.year) score += 2;
      if (!best || score > best.score || (score === best.score && d.mtime > best.mtime)) best = { ...d, score };
    }
    return best?.value ?? null;
  }

  /** Every title moviebox-tui has fetched (search results and opened details). */
  knownTitles(): Array<{ title: string; year?: string; kind?: string; cover?: string; subjectId: string }> {
    this.refresh();
    return [...this.candidates()].map(({ value: v }) => ({ title: v.title, year: v.year, kind: v.kind, cover: v.cover, subjectId: v.id }));
  }

  rating(provider: string | undefined, id: string | undefined): string | undefined {
    if (!id) return undefined;
    for (const d of this.details.values()) if (d.value.subjectId === id && (!provider || d.value.provider === provider) && d.value.rating) return d.value.rating;
    return this.listRatings.get(id);
  }

  /** Streams the TUI resolved for a subject (and episode, for series). */
  streams(info: DetailsInfo, season?: number, episode?: number): CachedStream[] | null {
    this.refresh(true);
    const d = this.details.get(`${info.provider}:${info.subjectId}`);
    if (!d?.hash) return null;
    const dir = path.join(d.dir, 'streams');
    let names: string[];
    const core = (n: string) => n.replace(/^v\d+_/, '');
    try {
      names = fs.readdirSync(dir).filter((n) => core(n).startsWith(d.hash + '_'));
    } catch {
      return null;
    }
    const wanted = season !== undefined && episode !== undefined ? `${d.hash}_${season}_${episode}.cache` : null;
    const pick = wanted
      ? names.find((n) => core(n) === wanted)
      : names.map((n) => ({ n, m: mtimeOf(path.join(dir, n)) })).sort((a, b) => b.m - a.m)[0]?.n;
    if (!pick) return null;
    try {
      const mbc = readMbc(path.join(dir, pick));
      return mbc ? mapStreamsPayload(mbc.payload) : null;
    } catch {
      return null;
    }
  }

  /** Caption languages from the newest captions cache written after `since`. */
  captionsSince(since: number): Caption[] | null {
    let newest: { file: string; mtime: number } | null = null;
    for (const dir of this.providerDirs()) {
      const cdir = path.join(dir, 'captions');
      let names: string[] = [];
      try {
        names = fs.readdirSync(cdir);
      } catch {
        continue;
      }
      for (const n of names) {
        const file = path.join(cdir, n);
        const mtime = mtimeOf(file);
        if (mtime >= since && (!newest || mtime > newest.mtime)) newest = { file, mtime };
      }
    }
    if (!newest) return null;
    try {
      const mbc = readMbc(newest.file);
      return mbc ? mapCaptionsPayload(mbc.payload) : null;
    } catch {
      return null;
    }
  }
}
