// Where moviebox-tui keeps its files, by its own rules (src/config.rs, built on the `dirs` crate):
//
//              Windows                    macOS                                Linux
//   config     %APPDATA%\moviebox-tui     ~/Library/Application Support/…      $XDG_CONFIG_HOME or ~/.config/…
//   data       %APPDATA%\moviebox-tui     ~/Library/Application Support/…      $XDG_DATA_HOME or ~/.local/share/…
//   cache      %LOCALAPPDATA%\moviebox-tui ~/Library/Caches/…                  $XDG_CACHE_HOME or ~/.cache/…
//   logs       %LOCALAPPDATA%\…\logs      <data>/logs                          <data>/logs
//
// Its MOVIEBOX_CONFIG_DIR / _DATA_DIR / _CACHE_DIR overrides (full folders) are honoured too.
import os from 'node:os';
import path from 'node:path';

const APP = 'moviebox-tui';
const home = os.homedir();
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const env = (name: string) => process.env[name]?.trim() || undefined;
const roaming = () => env('APPDATA') ?? path.join(home, 'AppData', 'Roaming');
const localAppData = () => env('LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local');
const macSupport = () => path.join(home, 'Library', 'Application Support');

/** config.json, addons_config.json, tv_config.json */
export const configDir = (): string =>
  env('MOVIEBOX_CONFIG_DIR') ?? path.join(isWindows ? roaming() : isMac ? macSupport() : (env('XDG_CONFIG_HOME') ?? path.join(home, '.config')), APP);

/** history.json, favorites.json (the config folder too on Windows and macOS). */
export const tuiDataDir = (): string =>
  env('MOVIEBOX_DATA_DIR') ??
  path.join(isWindows ? roaming() : isMac ? macSupport() : (env('XDG_DATA_HOME') ?? path.join(home, '.local', 'share')), APP);

/** Response caches (search, details, streams, captions, homepage) and downloaded TV playlists. */
export const cacheDir = (): string =>
  env('MOVIEBOX_CACHE_DIR') ??
  path.join(isWindows ? localAppData() : isMac ? path.join(home, 'Library', 'Caches') : (env('XDG_CACHE_HOME') ?? path.join(home, '.cache')), APP);

/** The TUI's logs (moviebox-tui_rCURRENT.log). */
export const logsDir = (): string => (isWindows ? path.join(localAppData(), APP, 'logs') : path.join(tuiDataDir(), 'logs'));

export const configFile = (name: string): string => path.join(configDir(), name);

/** The TUI's default when `download_dir` is null (shown in its settings screen). */
export const defaultDownloadDir = (): string => path.join(home, 'Downloads', 'MovieBox-TUI');

export const expandHome = (p: string): string => (p.startsWith('~') ? path.join(home, p.slice(1)) : p);
