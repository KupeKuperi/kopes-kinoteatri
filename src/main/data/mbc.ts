// Decoder for moviebox-tui response caches: `MBC1` magic followed by a
// MessagePack array `[formatVersion, expiresAt, payload]`. Payload structs are
// serialized positionally (rmp-serde), so field meaning comes from position;
// layouts below were mapped from v0.1.26 cache files.
import fs from 'node:fs';
import { decode } from '@msgpack/msgpack';
import type { AudioTrack, Caption, DetailsInfo, Season } from '@shared/types';

export interface MbcFile {
  version: number;
  expiresAt: number;
  payload: unknown;
}

export function readMbc(file: string): MbcFile | null {
  const buf = fs.readFileSync(file);
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'MBC1') return null;
  const v = decode(buf.subarray(4));
  if (!Array.isArray(v) || v.length < 3) return null;
  return { version: Number(v[0]), expiresAt: Number(v[1]), payload: v[2] };
}

/** Windows-1252 bytes 0x80–0x9F by the character they stand for. */
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89,
  0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
const MOJIBAKE = /[Â-ô][-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]/;

/**
 * "RochÃ©" → "Roché", "Donâ€™t" → "Don’t": UTF-8 text a source read as Latin-1 / Windows-1252.
 * Changed only when the whole string decodes cleanly that way.
 */
export function fixMojibake(s: string): string {
  if (!MOJIBAKE.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const b = c <= 0xff ? c : CP1252[c];
    if (b === undefined) return s;
    bytes[i] = b;
  }
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return s;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? fixMojibake(v.trim()) : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function subjectRef(v: unknown): { provider: string; id: string } | null {
  if (!Array.isArray(v) || typeof v[0] !== 'string') return null;
  const id = typeof v[1] === 'string' ? v[1] : typeof v[1] === 'number' || typeof v[1] === 'bigint' ? String(v[1]) : null;
  return id ? { provider: v[0], id } : null;
}

export interface CachedSubject {
  provider: string;
  id: string;
  title: string;
  kind: string;
  year?: string;
  cover?: string;
}

/** search/*.cache payload: array of `[[provider, id], title, kind, year, cover, _]`. */
export function mapSearchPayload(payload: unknown): CachedSubject[] {
  const out: CachedSubject[] = [];
  for (const item of arr(payload)) {
    if (!Array.isArray(item)) continue;
    const ref = subjectRef(item[0]);
    const title = str(item[1]);
    if (!ref || !title) continue;
    out.push({ ...ref, title, kind: str(item[2]) ?? 'unknown', year: str(item[3]), cover: str(item[4]) });
  }
  return out;
}

/**
 * homepage/home_<tab>_<page>.cache payload: `[items, meta]` where items are
 * search-shaped entries and meta maps subject id → `[score, rating, rating, votes]`.
 */
export function mapHomepagePayload(payload: unknown): { items: CachedSubject[]; ratings: Map<string, string> } {
  const p = arr(payload);
  const ratings = new Map<string, string>();
  const meta = p[1];
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const [id, v] of Object.entries(meta as Record<string, unknown>)) {
      const r = num(arr(v)[1]);
      if (r !== undefined && r > 0) ratings.set(id, r.toFixed(1));
    }
  }
  return { items: mapSearchPayload(p[0]), ratings };
}

/**
 * details/*.cache payload (same layout for every source; MovieBox leaves 5 and 7–10 empty):
 * `[ref, title, kind, year, description, tagline, rating, director, cast, formats, languages, cover, duration, genres, seasons, audio]`
 * seasons: `[[seasonNo, [[season, episode, title?, _], …]], …]`, audio: `[[subjectId, label, label], …]`.
 */
export function mapDetailsPayload(payload: unknown): DetailsInfo | null {
  if (!Array.isArray(payload)) return null;
  const ref = subjectRef(payload[0]);
  const title = str(payload[1]);
  if (!ref || !title) return null;
  const seasons: Season[] = [];
  for (const s of arr(payload[14])) {
    if (!Array.isArray(s)) continue;
    const season = num(s[0]);
    if (season === undefined) continue;
    const episodes = arr(s[1])
      .filter(Array.isArray)
      .map((e) => ({ season: num(e[0]) ?? season, episode: num(e[1]) ?? 0, title: str(e[2]) }))
      .filter((e) => e.episode > 0);
    seasons.push({ season, episodes });
  }
  const audio: AudioTrack[] = [];
  for (const a of arr(payload[15])) {
    if (!Array.isArray(a)) continue;
    const id = str(a[0]) ?? (num(a[0]) !== undefined ? String(a[0]) : undefined);
    if (id) audio.push({ subjectId: id, label: str(a[1]) ?? str(a[2]) ?? 'Audio' });
  }
  const tags = arr(payload[13]).map(str).filter((t): t is string => Boolean(t));
  return {
    subjectId: ref.id,
    provider: ref.provider,
    title,
    kind: str(payload[2]) ?? 'unknown',
    year: str(payload[3]),
    description: str(payload[4]),
    tagline: str(payload[5]),
    rating: str(payload[6]),
    director: str(payload[7]),
    cast: str(payload[8]),
    formats: str(payload[9]),
    languages: str(payload[10]),
    cover: str(payload[11]),
    duration: str(payload[12]),
    tags,
    seasons,
    audio,
  };
}

export interface CachedStream {
  release?: string;
  resolution?: string;
  codec?: string;
  audio?: string;
  sizeBytes?: number;
  season?: number;
  episode?: number;
}

/**
 * streams/*.cache payload: array of
 * `[provider, release, resolution, codec, audioLanguages, sizeBytes, season, episode, sources, resourceId]`.
 * Stream URLs and request headers stay in the cache — the TUI does the playing.
 */
export function mapStreamsPayload(payload: unknown): CachedStream[] {
  return arr(payload)
    .filter(Array.isArray)
    .map((s) => ({
      release: str(s[1]),
      resolution: str(s[2]),
      codec: str(s[3]),
      audio: str(s[4]),
      sizeBytes: num(s[5]),
      season: num(s[6]),
      episode: num(s[7]),
    }));
}

/** captions/*.cache payload: `[[language, url], …]` — only languages are exposed. */
export function mapCaptionsPayload(payload: unknown): Caption[] {
  return arr(payload)
    .filter(Array.isArray)
    .map((c) => str(c[0]))
    .filter((l): l is string => Boolean(l))
    .map((language) => ({ language }));
}
