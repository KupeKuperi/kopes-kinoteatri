import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { MbApi } from '@shared/api';
import { CHANNELS } from '@shared/channels';
import type { EngineEvent } from '@shared/types';

// Every method is one IPC channel (the same table a phone's browser uses over HTTP).
const calls = Object.fromEntries(
  Object.entries(CHANNELS).map(([method, channel]) => [method, (...args: unknown[]) => ipcRenderer.invoke(channel, ...args)]),
);

const api = {
  ...calls,
  platform: process.platform,
  consoleInput: (data: string) => ipcRenderer.send('engine:input', data),
  on(listener: (event: EngineEvent) => void) {
    const handler = (_e: IpcRendererEvent, event: EngineEvent) => listener(event);
    ipcRenderer.on('mb:event', handler);
    return () => ipcRenderer.off('mb:event', handler);
  },
} as unknown as MbApi;

contextBridge.exposeInMainWorld('mb', api);
