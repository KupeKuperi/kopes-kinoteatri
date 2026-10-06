// Live TV channel catalogue for display. Playlist sources come from the TUI's
// tv_config.json; channels are read from those M3U files (names, groups,
// logos). Tuning in is done by the engine.
import fs from 'node:fs';
import path from 'node:path';
import type { TvChannel, TvPlaylist, TvView } from '@shared/types';
import { configFile, dataDir, expandHome } from '../paths';

const MAX_BYTES = 15 * 1024 * 1024; // the TUI rejects larger playlists too

export function readPlaylistSources(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile('tv_config.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.playlists) ? raw.playlists : [];
    return list
      .map((p: unknown) => (typeof p === 'string' ? p : (p as { url?: string; source?: string; path?: string })?.url ?? (p as { source?: string })?.source ?? (p as { path?: string })?.path))
      .filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0);
  } catch {
    return [];
  }
}

interface ParsedChannel {
  name: string;
  group?: string;
  logo?: string;
  url: string;
}

export function parseM3u(text: string): ParsedChannel[] {
  const out: ParsedChannel[] = [];
  let pending: Omit<ParsedChannel, 'url'> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attr = (k: string) => new RegExp(`${k}="([^"]*)"`, 'i').exec(line)?.[1]?.trim() || undefined;
      const comma = line.lastIndexOf(',');
      const name = comma >= 0 ? line.slice(comma + 1).trim() : attr('tvg-name') ?? 'Channel';
      pending = { name: name || attr('tvg-name') || 'Channel', group: attr('group-title'), logo: attr('tvg-logo') };
    } else if (!line.startsWith('#') && pending) {
      out.push({ ...pending, url: line });
      pending = null;
    }
  }
  return out;
}

async function loadSource(source: string): Promise<string | null> {
  if (/^https?:\/\//i.test(source)) {
    try {
      const res = await fetch(source, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const text = await res.text();
      return text.length > MAX_BYTES ? null : text;
    } catch {
      return null;
    }
  }
  try {
    const p = expandHome(source);
    if (fs.statSync(p).size > MAX_BYTES) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

let cache: { key: string; view: TvView } | null = null;

export async function readTv(force = false): Promise<TvView> {
  const sources = readPlaylistSources();
  const key = sources.join('\n');
  if (!force && cache?.key === key) return cache.view;

  const playlists: TvPlaylist[] = [];
  const channels: TvChannel[] = [];
  const seenUrls = new Set<string>();
  for (const source of sources) {
    const text = await loadSource(source);
    const parsed = text ? parseM3u(text) : [];
    playlists.push({ source, name: path.basename(source.replace(/[?#].*$/, '')) || source, enabled: true, channelCount: text ? parsed.length : undefined });
    for (const ch of parsed) {
      // Same stream URL across playlists is one channel — matching the TUI's consolidation.
      if (seenUrls.has(ch.url)) continue;
      seenUrls.add(ch.url);
      channels.push({ index: channels.length, name: ch.name, group: ch.group, logo: ch.logo, playlist: source });
    }
  }
  const view: TvView = {
    playlists,
    channels,
    message: sources.length === 0 ? 'Add an M3U playlist to see channels.' : channels.length === 0 ? 'No channels could be read from these playlists.' : undefined,
  };
  cache = { key, view };
  return view;
}

/** Folder the TUI keeps downloaded playlists in (shown in diagnostics). */
export const tvCacheDir = () => path.join(dataDir(), 'tv_playlists');
