// Where moviebox-tui keeps its files. Windows paths are verified against a real
// install; macOS/Linux follow the `dirs` crate conventions the TUI is built on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = 'moviebox-tui';
const home = os.homedir();

function firstExisting(candidates: string[]): string {
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

/** config.json, history.json, favorites.json, tv_config.json */
export const configDir = (): string => {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP);
  if (process.platform === 'darwin') return firstExisting([path.join(home, 'Library', 'Application Support', APP), path.join(home, '.config', APP)]);
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP);
};

/** Response caches, logs, TV playlists. */
export const dataDir = (): string => {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), APP);
  if (process.platform === 'darwin') return firstExisting([path.join(home, 'Library', 'Caches', APP), path.join(home, 'Library', 'Application Support', APP)]);
  return firstExisting([
    path.join(process.env.XDG_CACHE_HOME ?? path.join(home, '.cache'), APP),
    path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), APP),
  ]);
};

export const configFile = (name: string): string => path.join(configDir(), name);

/** The TUI's default when `download_dir` is null (shown in its settings screen). */
export const defaultDownloadDir = (): string => path.join(home, 'Downloads', 'MovieBox-TUI');

export const expandHome = (p: string): string => (p.startsWith('~') ? path.join(home, p.slice(1)) : p);
