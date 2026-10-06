// Phone access, put together: settings (on/off, port, pairing key), the server phones open, the
// player stand-in the engine starts while it is on, and the relay between them.
import crypto from 'node:crypto';
import path from 'node:path';
import type { EngineEvent, HistoryEntry, PhoneSettings } from '@shared/types';
import { detectPlayers } from '../binary';
import { readGuiSettings, readTuiSettings, writeGuiSettings } from '../data/config';
import type { EngineManager } from '../engine/manager';
import { PlayerBridge } from './bridge';
import { Relay } from './relay';
import { PhoneServer, type Handler } from './server';

const DEFAULT_PORT = 47800;

export interface Phone {
  relay: Relay;
  /** Before any play: a phone that is still watching lets the engine's player go first. */
  beforePlay(): Promise<void>;
  /** Starts what phone access needs (call before the engine starts: its environment depends on it). */
  start(): Promise<void>;
  broadcast(event: EngineEvent): void;
  stop(): void;
}

export function setupPhone(opts: {
  engine: EngineManager;
  userData: string;
  handlers: Map<string, Handler>;
  handle: (channel: string, fn: Handler) => void;
  rendererDir: string;
  send: (event: EngineEvent) => void;
}): Phone {
  const { engine, userData, handle } = opts;

  // Read once (every video request checks the key), written through on change.
  let current: PhoneSettings | null = null;
  const settings = (): PhoneSettings => {
    if (current) return current;
    const gui = readGuiSettings(userData);
    const phone = { enabled: false, port: DEFAULT_PORT, key: '', ...gui.phone };
    if (!phone.key) {
      phone.key = crypto.randomBytes(18).toString('base64url');
      writeGuiSettings(userData, { ...gui, phone });
    }
    return (current = phone);
  };
  const save = (patch: Partial<PhoneSettings>) => {
    const phone = { ...settings(), ...patch };
    writeGuiSettings(userData, { ...readGuiSettings(userData), phone });
    current = phone;
  };

  const relay = new Relay();
  const bridge = new PlayerBridge(path.join(userData, 'phone'));
  bridge.onLaunch = relay.decide;
  const server = new PhoneServer({
    rendererDir: opts.rendererDir,
    handlers: opts.handlers,
    relay,
    key: () => settings().key,
    host: process.env.KK_PHONE_HOST || undefined,
  });

  const broadcast = (event: EngineEvent) => server.broadcast(event);
  relay.on('session', (payload) => {
    const event: EngineEvent = { type: 'phone-play', payload };
    opts.send(event);
    broadcast(event);
  });
  relay.on('ended', (id: string) => {
    const event: EngineEvent = { type: 'phone-end', payload: { id } };
    opts.send(event);
    broadcast(event);
  });

  // While phone access is on, the engine's players are the stand-ins (the real ones still play
  // everything the computer starts). With no player installed, a phone can still watch.
  engine.extraEnv = () => {
    if (!settings().enabled) return {};
    const tui = readTuiSettings();
    const found = detectPlayers({ vlc: tui?.vlcPath, mpv: tui?.mpvPath, iina: tui?.iinaPath });
    return bridge.engineEnv(found.vlc || found.mpv ? { vlc: found.vlc, mpv: found.mpv } : { vlc: '', mpv: null });
  };

  const start = async () => {
    const s = settings();
    if (!s.enabled) return;
    await bridge.start();
    await server.start(s.port);
  };

  const beforePlay = () => relay.endAll();

  /** Plays on the phone `device`: the engine's next player launch goes there. */
  const onPhone = async <T>(device: string, title: string, live: boolean, play: () => Promise<T>): Promise<T> => {
    if (!settings().enabled) throw new Error('Phone access is off on the computer.');
    await relay.endAll();
    // The engine answers its subtitle question from the subtitle setting (unless the phone chose).
    const sub = readGuiSettings(userData).subtitles;
    const ticket = relay.expect(device, title, live, sub && sub !== 'ask' && sub !== 'off' ? sub : undefined);
    try {
      const result = await play();
      // The launch arrives right after the engine starts its player; after that, stop waiting.
      setTimeout(() => relay.cancelExpect(ticket), 20_000);
      return result;
    } catch (e) {
      // No launch is coming: the computer's next play must not go to the phone.
      relay.cancelExpect(ticket);
      throw e;
    }
  };

  const driver = () => engine.requireDriver();
  handle('phone:get', () => {
    const s = settings();
    return server.info(s.enabled, s.port);
  });
  handle('phone:set', async (patch: { enabled?: boolean; newKey?: boolean }) => {
    const before = settings();
    const enabled = patch.enabled ?? before.enabled;
    save({ enabled, ...(patch.newKey ? { key: crypto.randomBytes(18).toString('base64url') } : {}) });
    if (enabled !== before.enabled) {
      if (enabled) await start();
      else {
        await relay.endAll();
        server.stop();
        bridge.stop();
      }
      // The engine picks its player when it starts: give it (or take back) the stand-ins.
      await engine.restart();
    }
    return server.info(enabled, before.port);
  });
  handle('phone:play', (device: string, streamIndex: number, title: string) => onPhone(device, title, false, () => driver().play(streamIndex)));
  handle('phone:resume', (device: string, entry: HistoryEntry) => onPhone(device, entry.title, false, () => driver().resume(entry)));
  handle('phone:tv', (device: string, name: string, group?: string) => onPhone(device, name, true, () => driver().tvPlay(name, group)));
  handle('phone:progress', (session: string) => relay.touch(session));
  handle('phone:stop', (session: string) => relay.end(session));

  return {
    relay,
    beforePlay,
    start,
    broadcast,
    stop() {
      server.stop();
      bridge.stop();
    },
  };
}
