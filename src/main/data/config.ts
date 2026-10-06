// Settings: the TUI's own config.json (shared with the terminal app) plus a
// small GUI-only settings file in Electron's userData folder.
import fs from 'node:fs';
import path from 'node:path';
import type { GuiSettings, PlayerName, TuiSettings } from '@shared/types';
import { configFile } from '../paths';

type Raw = Record<string, unknown>;

const NOT_PROVIDERS = new Set(['streaming_enabled', 'tv_enabled', 'addons_enabled']);

export function readTuiConfigRaw(): Raw | null {
  try {
    return JSON.parse(fs.readFileSync(configFile('config.json'), 'utf8')) as Raw;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readTuiSettings(): TuiSettings | null {
  const raw = readTuiConfigRaw();
  if (!raw) return null;
  const providers: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.endsWith('_enabled') && !NOT_PROVIDERS.has(k) && typeof v === 'boolean') providers[k.slice(0, -'_enabled'.length)] = v;
  }
  const strOrNull = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    defaultPlayer: (typeof raw.default_player === 'string' ? raw.default_player : 'mpv') as PlayerName,
    vlcPath: strOrNull(raw.vlc_path),
    mpvPath: strOrNull(raw.mpv_path),
    iinaPath: strOrNull(raw.iina_path),
    downloadDir: strOrNull(raw.download_dir),
    autoUpdate: raw.auto_update !== false,
    streamingEnabled: raw.streaming_enabled !== false,
    tvEnabled: raw.tv_enabled !== false,
    providers,
  };
}

/** Merges a patch into config.json, keeping every key the GUI doesn't know about. */
export function writeTuiSettings(patch: Partial<TuiSettings>): void {
  // Never write a config we couldn't read: it would drop every key the GUI doesn't manage.
  const raw = readTuiConfigRaw();
  if (!raw) throw new Error("moviebox-tui's config.json could not be read, so settings were not saved. Try again in a moment.");
  const set = (key: string, v: unknown) => {
    if (v !== undefined) raw[key] = v;
  };
  set('default_player', patch.defaultPlayer);
  set('vlc_path', patch.vlcPath === '' ? null : patch.vlcPath);
  set('mpv_path', patch.mpvPath === '' ? null : patch.mpvPath);
  set('iina_path', patch.iinaPath === '' ? null : patch.iinaPath);
  set('download_dir', patch.downloadDir === '' ? null : patch.downloadDir);
  set('auto_update', patch.autoUpdate);
  set('streaming_enabled', patch.streamingEnabled);
  set('tv_enabled', patch.tvEnabled);
  for (const [name, on] of Object.entries(patch.providers ?? {})) raw[`${name}_enabled`] = on;
  writeJsonAtomic(configFile('config.json'), raw);
}

export function setActiveMode(mode: string): void {
  const raw = readTuiConfigRaw();
  if (!raw || raw.active_mode === mode) return;
  raw.active_mode = mode;
  writeJsonAtomic(configFile('config.json'), raw);
}

const DEFAULT_GUI: GuiSettings = { binaryPath: '', subtitles: 'English' };

export function readGuiSettings(userData: string): GuiSettings {
  try {
    return { ...DEFAULT_GUI, ...JSON.parse(fs.readFileSync(path.join(userData, 'gui-settings.json'), 'utf8')) };
  } catch {
    return { ...DEFAULT_GUI };
  }
}

export function writeGuiSettings(userData: string, settings: GuiSettings): void {
  fs.mkdirSync(userData, { recursive: true });
  writeJsonAtomic(path.join(userData, 'gui-settings.json'), settings);
}
