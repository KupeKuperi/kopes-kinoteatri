// IPC surface between the renderer and the engine / data readers.
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { TitleRef } from '@shared/api';
import type { DownloadScope, EngineEvent, FavoriteEntry, GuiSettings, HistoryEntry, ResultsView, SettingsBundle, TuiSettings } from '@shared/types';
import { detectPlayers, which } from './binary';
import { readGuiSettings, readTuiSettings, writeGuiSettings, writeTuiSettings } from './data/config';
import { deleteUnfinished, listDownloads } from './data/downloads';
import { listLabel, listMinVotes, type ImdbListKind, type ImdbService } from './data/imdb';
import { readLibrary } from './data/library';
import { suggestTitles, type KnownTitle } from './data/suggest';
import { readPlaylistSources, readTv } from './data/tv';
import type { EngineManager } from './engine/manager';
import { cacheDir, configDir, defaultDownloadDir, expandHome } from './paths';
import { installEngine, installTool, TOOLS, type Tool } from './tools';

export function registerIpc(
  engine: EngineManager,
  imdb: ImdbService,
  userData: string,
  getWindow: () => BrowserWindow | null,
  fetchFn: (url: string) => Promise<Response>,
): void {
  const driver = () => engine.requireDriver();
  const handle = (channel: string, fn: (...args: any[]) => unknown) => ipcMain.handle(channel, (_e, ...args) => fn(...args));

  const env = () => {
    const tui = readTuiSettings();
    return {
      configDir: configDir(),
      dataDir: cacheDir(),
      downloadDir: tui?.downloadDir ? expandHome(tui.downloadDir) : defaultDownloadDir(),
      ytDlp: which('yt-dlp'),
      ffmpeg: which('ffmpeg'),
      players: detectPlayers({ vlc: tui?.vlcPath, mpv: tui?.mpvPath, iina: tui?.iinaPath }),
    };
  };

  handle('app:status', () => ({ status: engine.status, env: env() }));
  handle('engine:restart', () => engine.restart());
  // First run on a computer without the engine: install its official release, then start it.
  handle('engine:install', async () => {
    try {
      await installEngine(fetchFn, (step) => engine.emit('setup', step));
    } finally {
      engine.emit('setup', null);
    }
    await engine.restart();
    return { status: engine.status, env: env() };
  });
  // VLC (to play) and yt-dlp (MovieBox downloads): winget on Windows, Homebrew on a Mac (else their
  // download page opens). Nothing else can be installed from here.
  handle('tools:install', async (tool: string) => {
    if (!(tool in TOOLS)) throw new Error('Unknown tool.');
    const r = await installTool(tool as Tool, (url) => shell.openExternal(url));
    // The engine finds yt-dlp on the PATH it started with: restart it so it sees the new one.
    if (!r.manual && tool === 'yt-dlp' && !engine.downloading) await engine.restart();
    return { env: env(), manual: r.manual };
  });
  handle('engine:snapshot', () => engine.session?.serialize() ?? '');
  ipcMain.on('engine:input', (_e, data: string) => engine.session?.writeFromConsole(data));

  handle('search', (q: string) => driver().search(q));
  // Instant, typo-tolerant matches from titles moviebox-tui has already seen.
  handle('suggest', (q: string) => {
    const lib = readLibrary();
    const known: KnownTitle[] = [
      ...engine.cache.knownTitles(),
      ...lib.history.map((h) => ({ title: h.title, year: h.year, kind: h.kind, cover: h.cover, subjectId: h.subjectId })),
      ...lib.favorites.map((f) => ({ title: f.title, year: f.year, kind: f.kind, cover: f.cover, subjectId: f.subjectId })),
    ];
    return suggestTitles(q, known);
  });
  // Search-as-you-type through the engine; null when a newer request superseded it.
  handle('suggest:live', (q: string) => driver().searchLatest(q));
  handle('browse:categories', () => driver().browseCategories());
  handle('browse', (i: number) => driver().browse(i));
  handle('providers:list', () => driver().listProviders());
  handle('providers:set', async (name: string) => {
    await driver().setProvider(name);
    engine.refreshStatus(); // the status the window reads next must already name the new source
  });

  // Search and open run as one engine operation, so nothing can slip in between.
  const openTitle = (ref: TitleRef) => driver().openTitle({ title: ref.title, year: ref.year, subjectId: ref.subjectId });

  // IMDb lists and ratings (metadata only; titles are found and played through the engine).
  handle('imdb:list', async (kind: ImdbListKind): Promise<ResultsView> => {
    const items = await imdb.list(kind);
    return {
      source: 'imdb',
      label: listLabel(kind),
      provider: 'IMDb',
      total: items.length,
      items: items.map((t, index) => ({
        index,
        title: t.title,
        year: t.year,
        type: t.type === 'series' ? 'Series' : 'Movie',
        cover: t.poster,
        imdb: { id: t.id, rating: t.rating, votes: t.votes },
      })),
      message: `${listMinVotes(kind).toLocaleString('en-US')}+ votes on IMDb`,
    };
  });
  handle('imdb:ratings', (refs: Array<{ title: string; year?: string; type?: string }>) =>
    Promise.all(refs.slice(0, 120).map((r) => imdb.lookup(r.title, r.year, r.type))),
  );

  handle('details:open', (i: number, key?: string) => driver().open(i, key));
  handle('details:open-title', (ref: TitleRef) => openTitle(ref));
  handle('details:peek', () => driver().peekDetails());
  handle('details:audio', (i: number) => driver().selectAudio(i));
  handle('details:season', (s: number) => driver().selectSeason(s));
  handle('details:episode', (s: number, e: number) => driver().selectEpisode(s, e));
  handle('play', (i: number) => driver().play(i));
  handle('subtitles:choose', (i: number) => driver().chooseSubtitle(i));
  handle('download', (scope: DownloadScope, target: number) => driver().download(scope, target));
  handle('favorite:toggle', () => driver().toggleFavorite());
  handle('downloads:cancel', () => driver().cancelDownloads());

  handle('library:get', () => readLibrary());
  handle('history:resume', (h: HistoryEntry) => driver().resume(h));
  handle('history:remove', (h: HistoryEntry) => driver().removeFromHistory(h));
  handle('favorite:open', (f: FavoriteEntry) => openTitle({ title: f.title, year: f.year, subjectId: f.subjectId }));

  const downloadDir = () => {
    const dir = readTuiSettings()?.downloadDir;
    return dir ? expandHome(dir) : defaultDownloadDir();
  };
  handle('downloads:list', () => {
    const dir = downloadDir();
    return { dir, files: listDownloads(dir) };
  });
  /** `p` resolved, if it is the download folder or inside it. */
  const insideDownloads = (p: string, what: string) => {
    const root = path.resolve(downloadDir());
    const target = path.resolve(p);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Only downloaded files can be ${what} from here.`);
    return target;
  };
  // Removes what an unfinished download left behind (its pieces only, never a finished file).
  handle('downloads:delete-unfinished', (p: string) => deleteUnfinished(insideDownloads(p, 'deleted'), downloadDir()));
  // Only the download folder and the files in it can be opened from the UI.
  handle('shell:open', async (p: string) => {
    const target = insideDownloads(p, 'opened');
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  });
  handle('shell:reveal', (p: string) => shell.showItemInFolder(p));
  handle('dialog:folder', async (current?: string) => {
    const win = getWindow();
    const opts = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>, defaultPath: current };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:file', async (current?: string) => {
    const win = getWindow();
    const opts = { properties: ['openFile'] as Array<'openFile'>, defaultPath: current };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0];
  });

  handle('tv:get', (force?: boolean) => readTv(force));
  handle('tv:add', async (source: string) => {
    await driver().tvAddPlaylist(source);
    return readTv(true);
  });
  handle('tv:remove', async (source: string) => {
    const index = readPlaylistSources().indexOf(source);
    if (index < 0) throw new Error('That playlist is not in the list any more.');
    await driver().tvRemovePlaylist(index);
    if (readPlaylistSources().includes(source)) throw new Error('The engine kept the playlist. Remove it from the console with /config in Live TV mode.');
    return readTv(true);
  });
  handle('tv:play', (name: string, group?: string) => driver().tvPlay(name, group));
  handle('tv:leave', () => driver().leaveTv());

  const bundle = (): SettingsBundle => ({ tui: readTuiSettings(), gui: readGuiSettings(userData) });
  handle('settings:get', bundle);
  handle('settings:save', async (patch: { tui?: Partial<TuiSettings>; gui?: Partial<GuiSettings> }) => {
    const gui = readGuiSettings(userData);
    // The window's own preferences (subtitles) apply at once; only engine settings need a restart.
    if (!patch.tui && (patch.gui?.binaryPath === undefined || patch.gui.binaryPath === gui.binaryPath)) {
      writeGuiSettings(userData, { ...gui, ...patch.gui });
      return bundle();
    }
    // The TUI reads config.json at startup, so stop it first and start it again after writing.
    engine.driver?.forgetSources();
    await engine.stop();
    try {
      if (patch.tui) writeTuiSettings(patch.tui);
      if (patch.gui) writeGuiSettings(userData, { ...readGuiSettings(userData), ...patch.gui });
    } finally {
      void engine.start(); // even if writing failed, don't leave the engine stopped
    }
    return bundle();
  });
}

export function forwardEvents(engine: EngineManager, send: (e: EngineEvent) => void): void {
  engine.on('status', (payload) => send({ type: 'status', payload }));
  engine.on('toast', (payload) => send({ type: 'toast', payload }));
  engine.on('downloads', (payload) => send({ type: 'downloads', payload }));
  engine.on('details', (payload) => send({ type: 'details', payload }));
  engine.on('results', (payload) => send({ type: 'results', payload }));
  engine.on('subtitles', (payload) => send({ type: 'subtitles', payload }));
  engine.on('setup', (payload) => send({ type: 'setup', payload }));
  engine.on('console-data', (payload) => send({ type: 'console-data', payload }));
}
