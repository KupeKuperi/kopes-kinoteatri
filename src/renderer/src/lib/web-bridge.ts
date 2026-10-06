// In a phone's browser there is no Electron preload: `window.mb` talks to the app's phone server
// over HTTP instead, with the same methods and channels. Imported first (main.tsx), before
// anything reads window.mb.
import type { MbApi } from '@shared/api';
import { CHANNELS } from '@shared/channels';
import type { EngineEvent } from '@shared/types';

if (!window.mb) {
  const listeners = new Set<(event: EngineEvent) => void>();
  let events: EventSource | null = null;

  const call =
    (channel: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      let res: Response;
      try {
        res = await fetch(`/api/call/${encodeURIComponent(channel)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
          credentials: 'same-origin',
        });
      } catch {
        throw new Error("The computer isn't answering. Is Kope's Kinoteatri open there, on the same Wi-Fi?");
      }
      if (res.status === 401) throw new Error('This phone is not paired any more. Scan the QR code on the computer again.');
      const answer = (await res.json().catch(() => ({ ok: false, error: `The computer answered ${res.status}.` }))) as { ok: boolean; value?: unknown; error?: string };
      if (!answer.ok) throw new Error(answer.error ?? 'Something went wrong on the computer.');
      return answer.value;
    };

  window.mb = {
    ...Object.fromEntries(Object.entries(CHANNELS).map(([method, channel]) => [method, call(channel)])),
    platform: 'web',
    imageBase: '/img/',
    // The engine console and the computer's file dialogs stay on the computer.
    consoleInput: () => undefined,
    consoleSnapshot: async () => '',
    pickFolder: async () => null,
    pickFile: async () => null,
    on(listener: (event: EngineEvent) => void) {
      listeners.add(listener);
      if (!events) {
        events = new EventSource('/api/events');
        events.onmessage = (m) => {
          let event: EngineEvent;
          try {
            event = JSON.parse(m.data) as EngineEvent;
          } catch {
            return;
          }
          for (const l of listeners) l(event);
        };
      }
      return () => listeners.delete(listener);
    },
  } as unknown as MbApi;
}

export {};
