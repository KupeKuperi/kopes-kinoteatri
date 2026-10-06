// History, continue-watching and favorites, read from the JSON files the TUI
// maintains. The TUI is the only writer; the GUI watches for changes.
import fs from 'node:fs';
import type { FavoriteEntry, HistoryEntry, LibrarySnapshot } from '@shared/types';
import { configFile } from '../paths';

type Raw = Record<string, unknown>;

const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** stype follows the MovieBox API: 1 = movie, 2 = series. */
const kindOf = (r: Raw): HistoryEntry['kind'] => {
  const t = r.stype ?? r.kind ?? r.media_type ?? r.type;
  if (t === 1 || t === 'movie' || t === 'Movie') return 'movie';
  if (t === 2 || t === 'series' || t === 'Series' || t === 'tv') return 'series';
  return 'unknown';
};

function readJson(name: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(configFile(name), 'utf8'));
  } catch {
    return null;
  }
}

function toHistory(r: Raw): HistoryEntry | null {
  const subjectId = s(r.subject_id) ?? s(r.id);
  const title = s(r.title);
  if (!subjectId || !title) return null;
  const provider = s(r.provider) ?? 'moviebox';
  const season = n(r.season);
  const episode = n(r.episode);
  return {
    key: `${provider}:${subjectId}:${season ?? 0}:${episode ?? 0}`,
    provider,
    subjectId,
    title,
    cover: s(r.cover_url) ?? s(r.cover),
    kind: kindOf(r),
    year: s(r.release_year) ?? s(r.year),
    season,
    episode,
    timestamp: n(r.timestamp) ?? 0,
    durationSeconds: n(r.duration_seconds),
    progressSeconds: n(r.progress_seconds),
    completed: r.completed === true,
    release: s(r.stream_filename),
  };
}

function toFavorite(r: Raw): FavoriteEntry | null {
  const subjectId = s(r.subject_id) ?? s(r.id);
  const title = s(r.title);
  if (!subjectId || !title) return null;
  const provider = s(r.provider) ?? 'moviebox';
  return {
    key: `${provider}:${subjectId}`,
    provider,
    subjectId,
    title,
    cover: s(r.cover_url) ?? s(r.cover),
    kind: kindOf(r),
    year: s(r.release_year) ?? s(r.year),
    addedAt: n(r.added_at) ?? n(r.timestamp),
  };
}

const records = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => Boolean(x) && typeof x === 'object') : []);

export function readLibrary(): LibrarySnapshot {
  const history = (readJson('history.json') ?? {}) as Raw;
  const all = [...records(history.recent), ...records(history.watched)]
    .map(toHistory)
    .filter((h): h is HistoryEntry => h !== null)
    .sort((a, b) => b.timestamp - a.timestamp);
  // Newest first; keep the first (newest) entry per key.
  const seen = new Set<string>();
  const unique = all.filter((h) => !seen.has(h.key) && Boolean(seen.add(h.key)));

  const favRaw = readJson('favorites.json') as Raw | unknown[] | null;
  const favItems = Array.isArray(favRaw) ? favRaw : records((favRaw as Raw | null)?.items);
  const favorites = records(favItems)
    .map(toFavorite)
    .filter((f): f is FavoriteEntry => f !== null);

  return {
    continueWatching: unique.filter((h) => !h.completed),
    history: unique,
    favorites,
  };
}

/** Calls `onChange` (debounced) whenever the TUI rewrites history or favorites. */
export function watchLibrary(dir: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, (_event, file) => {
      if (file && !/^(history|favorites)\.json$/.test(String(file))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    });
  } catch {
    /* directory missing until the TUI first runs */
  }
  return () => watcher?.close();
}
