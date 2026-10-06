import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, Menu, net, shell } from 'electron';
import type { EngineEvent } from '@shared/types';
import { CacheIndex } from './data/cacheIndex';
import { readGuiSettings } from './data/config';
import { ImdbService } from './data/imdb';
import { readLibrary, watchLibrary } from './data/library';
import { EngineManager } from './engine/manager';
import { handleImageScheme, registerImageScheme } from './images';
import { forwardEvents, registerIpc } from './ipc';
import { cacheDir, tuiDataDir } from './paths';
import { setupPhone, type Phone } from './phone';

const APP_NAME = "Kope's Kinoteatri";

/** Carries settings and recent searches over from the app's previous name. */
function migrateUserData(from: string, to: string) {
  try {
    if (fs.existsSync(to) || !fs.existsSync(from)) return;
    fs.mkdirSync(to, { recursive: true });
    for (const entry of ['gui-settings.json', 'Local Storage']) {
      const src = path.join(from, entry);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(to, entry), { recursive: true });
    }
  } catch {
    /* a fresh start is fine */
  }
}

registerImageScheme();

// The app's own folder (settings, poster cache, IMDb data). A plain folder name
// avoids the apostrophe in "Kope's"; earlier builds used "moviebox-gui".
app.setName(APP_NAME);
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const dir = path.join(app.getPath('appData'), 'kopes-kinoteatri');
  migrateUserData(path.join(app.getPath('appData'), 'moviebox-gui'), dir);
  app.setPath('userData', dir);
}

// A second launch only focuses the open window (see 'second-instance') and exits at once.
if (!app.requestSingleInstanceLock()) app.exit(0);

let win: BrowserWindow | null = null;
const userData = app.getPath('userData');
const engine = new EngineManager(new CacheIndex(cacheDir()), () => readGuiSettings(userData), path.join(userData, 'engine.pid'));
// Chromium's network stack (net.fetch) honours the system proxy settings.
const imdb = new ImdbService(path.join(userData, 'imdb'), (url) => net.fetch(url));

const toWindow = (event: EngineEvent) => {
  if (win && !win.isDestroyed()) win.webContents.send('mb:event', event);
};
let phone: Phone | null = null;
/** Engine events go to the window and to every phone that has the app open. */
const send = (event: EngineEvent) => {
  toWindow(event);
  phone?.broadcast(event);
};

function createWindow() {
  win = new BrowserWindow({
    width: 1340,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#160D12',
    title: APP_NAME,
    // The packaged app takes its icon from its .exe; in development use the source PNG.
    icon: app.isPackaged ? undefined : path.join(__dirname, '../../build/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#160D12', symbolColor: '#A8939C', height: 44 },
    // macOS draws its window buttons over the 44 px title bar; the title bar leaves room for them.
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  // MOVIEBOX_HIDDEN=1 (automated UI checks while the real app is in use): the window is
  // placed off screen without a taskbar button, so it keeps painting but is never seen.
  if (process.env.MOVIEBOX_HIDDEN) {
    win.setSkipTaskbar(true);
    win.setPosition(-32000, -32000);
    win.once('ready-to-show', () => win?.showInactive());
  } else {
    win.once('ready-to-show', () => win?.show());
  }
  win.on('closed', () => (win = null));

  // External links open in the browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!process.env.ELECTRON_RENDERER_URL || !url.startsWith(process.env.ELECTRON_RENDERER_URL)) e.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  // A Mac app needs its menu for ⌘Q, ⌘W and copy/paste in text fields; elsewhere the window has no menu bar.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  }
  handleImageScheme();
  const ipc = registerIpc(engine, imdb, userData, () => win, (url, init) => net.fetch(url, init), { beforePlay: () => phone?.beforePlay() ?? Promise.resolve() });
  phone = setupPhone({ engine, userData, handlers: ipc.handlers, handle: ipc.handle, rendererDir: path.join(__dirname, '../renderer'), send: toWindow });
  forwardEvents(engine, send);
  watchLibrary(tuiDataDir(), () => send({ type: 'library', payload: readLibrary() }));
  createWindow();
  // First end an engine a crashed earlier run may have left behind, then start this one (after
  // phone access, which sets the engine's players).
  void engine
    .reapOrphan()
    .then(() => phone?.start())
    .catch(() => undefined)
    .finally(() => engine.start());
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  phone?.stop();
  void engine.shutdown().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
