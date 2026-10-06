// Stremio add-ons for the engine's "Addons" source. moviebox-tui keeps them in addons_config.json
// (its own format, below) and reads the file when it starts; Cinemeta, which finds the titles, is
// always there. Add-ons that provide streams are what make the Addons source play anything.
import fs from 'node:fs';
import type { AddonInfo } from '@shared/types';
import { configFile } from '../paths';
import { readTuiConfigRaw, writeJsonAtomic } from './config';

/** One entry of addons_config.json, as moviebox-tui writes it (src/providers/addons/models.rs). */
interface InstalledAddon {
  manifest_url: string;
  name: string;
  version: string | null;
  description: string | null;
  enabled: boolean;
  provides_catalog: boolean;
  provides_meta: boolean;
  provides_stream: boolean;
  id_prefixes: string[];
  types: string[];
}

const CINEMETA: InstalledAddon = {
  manifest_url: 'https://v3-cinemeta.strem.io/manifest.json',
  name: 'Cinemeta',
  version: '3.0.14',
  description: 'Official Catalog and Metadata',
  enabled: true,
  provides_catalog: true,
  provides_meta: true,
  provides_stream: false,
  id_prefixes: ['tt'],
  types: ['movie', 'series'],
};

const isCore = (a: InstalledAddon) => a.name.toLowerCase() === 'cinemeta' || a.manifest_url.toLowerCase().includes('cinemeta');

const ADDONS_FILE = () => configFile('addons_config.json');

/** The installed add-ons; Cinemeta first, as the engine itself makes sure of. */
export function readAddons(): InstalledAddon[] {
  let list: InstalledAddon[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ADDONS_FILE(), 'utf8'));
    if (Array.isArray(parsed)) list = parsed.filter((a) => a && typeof a.manifest_url === 'string' && typeof a.name === 'string');
  } catch {
    /* missing or unreadable: the engine starts over from Cinemeta too */
  }
  if (!list.some(isCore)) list.unshift({ ...CINEMETA });
  return list;
}

function writeAddons(list: InstalledAddon[]) {
  fs.mkdirSync(configFile(''), { recursive: true });
  writeJsonAtomic(ADDONS_FILE(), list);
}

export function addonViews(list = readAddons()): AddonInfo[] {
  return list.map((a) => ({
    url: a.manifest_url,
    name: a.name,
    version: a.version ?? undefined,
    description: a.description ?? undefined,
    enabled: isCore(a) || a.enabled,
    core: isCore(a),
    catalog: a.provides_catalog || a.provides_meta,
    streams: a.provides_stream,
  }));
}

/** Names of the enabled add-ons that provide streams (none: the Addons source can't play anything). */
export const streamAddonNames = (): string[] => readAddons().filter((a) => a.enabled && a.provides_stream).map((a) => a.name);

/** The link as the engine normalizes it: stremio:// links, missing https:// and a bare base URL work too. */
export function normalizeManifestUrl(raw: string): string {
  let url = raw.trim();
  if (url.startsWith('stremio://')) url = `https://${url.slice('stremio://'.length)}`;
  else if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const cut = url.search(/[?#]/);
  const base = cut < 0 ? url : url.slice(0, cut);
  const suffix = cut < 0 ? '' : url.slice(cut);
  return base.endsWith('/manifest.json') ? url : `${base.replace(/\/+$/, '')}/manifest.json${suffix}`;
}

type Resource = string | { name?: unknown };

/** Reads an add-on's manifest; the same fields the engine needs from it. */
export async function fetchAddon(raw: string, fetchFn: (url: string, init?: RequestInit) => Promise<Response>): Promise<InstalledAddon> {
  const url = normalizeManifestUrl(raw);
  try {
    new URL(url);
  } catch {
    throw new Error('That is not an add-on link.');
  }
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`The add-on did not answer (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!res.ok) throw new Error(`The add-on answered with HTTP ${res.status}.`);
  let m: Record<string, unknown>;
  try {
    m = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error('That link is not a Stremio add-on (its manifest is not JSON).');
  }
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name || typeof m.id !== 'string') throw new Error('That link is not a Stremio add-on (its manifest has no name).');
  const resources = (Array.isArray(m.resources) ? (m.resources as Resource[]) : []).map((r) => (typeof r === 'string' ? r : String(r?.name ?? ''))).map((r) => r.toLowerCase());
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    manifest_url: url,
    name,
    version: typeof m.version === 'string' ? m.version : null,
    description: typeof m.description === 'string' ? m.description : null,
    enabled: true,
    provides_catalog: resources.includes('catalog') || (Array.isArray(m.catalogs) && m.catalogs.length > 0),
    provides_meta: resources.includes('meta'),
    provides_stream: resources.includes('stream'),
    id_prefixes: strings(m.idPrefixes),
    types: strings(m.types),
  };
}

/** The engine gives each add-on 5 seconds to list its streams (src/providers/addons/aggregator.rs). */
export const ENGINE_STREAM_WAIT_SECONDS = 5;

/**
 * How long the add-on takes to list the streams of a well-known title (Interstellar, or the first
 * episode of Game of Thrones for series-only add-ons); null when it didn't answer within 20 s.
 */
export async function timeStreams(addon: InstalledAddon, fetchFn: (url: string, init?: RequestInit) => Promise<Response>): Promise<number | null> {
  const base = addon.manifest_url.replace(/\/manifest\.json(?=$|[?#]).*$/, '');
  const movies = !addon.types.length || addon.types.includes('movie');
  const url = `${base}/stream/${movies ? 'movie/tt0816692' : 'series/tt0944947:1:1'}.json`;
  const started = Date.now();
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(20000) });
    await res.arrayBuffer();
    return (Date.now() - started) / 1000;
  } catch {
    return null;
  }
}

/**
 * Applies a change to the add-on list and keeps config.json's `addons_enabled` in step: on while
 * an add-on provides streams, so the Addons source stays chosen after the engine restarts.
 */
export function updateAddons(change: (list: InstalledAddon[]) => InstalledAddon[]): void {
  const list = change(readAddons());
  writeAddons(list);
  const raw = readTuiConfigRaw();
  const wanted = list.some((a) => a.enabled && a.provides_stream);
  if (raw && raw.addons_enabled !== wanted) {
    raw.addons_enabled = wanted;
    writeJsonAtomic(configFile('config.json'), raw);
  }
}

export function addAddon(addon: InstalledAddon): (list: InstalledAddon[]) => InstalledAddon[] {
  return (list) => {
    const i = list.findIndex((a) => a.manifest_url === addon.manifest_url);
    if (i >= 0) {
      const next = [...list];
      next[i] = addon;
      return next;
    }
    return [...list, addon];
  };
}

export const removeAddon = (url: string) => (list: InstalledAddon[]) => list.filter((a) => isCore(a) || a.manifest_url !== url);

export const enableAddon = (url: string, enabled: boolean) => (list: InstalledAddon[]) =>
  list.map((a) => (a.manifest_url === url && !isCore(a) ? { ...a, enabled } : a));
