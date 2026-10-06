import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { MbApi } from '@shared/api';
import type { EngineEvent } from '@shared/types';

const call =
  <A extends unknown[], R>(channel: string) =>
  (...args: A): Promise<R> =>
    ipcRenderer.invoke(channel, ...args);

const api: MbApi = {
  platform: process.platform,
  status: call('app:status'),
  restartEngine: call('engine:restart'),
  consoleSnapshot: call('engine:snapshot'),
  consoleInput: (data) => ipcRenderer.send('engine:input', data),
  installEngine: call('engine:install'),
  installTool: call('tools:install'),
  chooseSubtitle: call('subtitles:choose'),

  search: call('search'),
  suggest: call('suggest'),
  suggestLive: call('suggest:live'),
  browseCategories: call('browse:categories'),
  imdbList: call('imdb:list'),
  imdbRatings: call('imdb:ratings'),
  browse: call('browse'),
  providers: call('providers:list'),
  setProvider: call('providers:set'),

  open: call('details:open'),
  openTitle: call('details:open-title'),
  peekDetails: call('details:peek'),
  selectAudio: call('details:audio'),
  selectSeason: call('details:season'),
  selectEpisode: call('details:episode'),
  play: call('play'),
  download: call('download'),
  toggleFavorite: call('favorite:toggle'),
  cancelDownloads: call('downloads:cancel'),

  library: call('library:get'),
  resume: call('history:resume'),
  removeFromHistory: call('history:remove'),
  openFavorite: call('favorite:open'),

  downloads: call('downloads:list'),
  deleteUnfinished: call('downloads:delete-unfinished'),
  openPath: call('shell:open'),
  revealPath: call('shell:reveal'),
  pickFolder: call('dialog:folder'),
  pickFile: call('dialog:file'),

  tv: call('tv:get'),
  tvAddPlaylist: call('tv:add'),
  tvRemovePlaylist: call('tv:remove'),
  tvPlay: call('tv:play'),
  tvLeave: call('tv:leave'),

  settings: call('settings:get'),
  saveSettings: call('settings:save'),

  on(listener) {
    const handler = (_e: IpcRendererEvent, event: EngineEvent) => listener(event);
    ipcRenderer.on('mb:event', handler);
    return () => ipcRenderer.off('mb:event', handler);
  },
};

contextBridge.exposeInMainWorld('mb', api);
