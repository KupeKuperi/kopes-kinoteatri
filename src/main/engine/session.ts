// Runs moviebox-tui inside a hidden pseudo-terminal and mirrors its output
// into a headless xterm buffer that the driver reads screens from.
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { spawn, type IPty } from '@lydell/node-pty';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Screen } from './screen';
import { encodeConsoleInput, encodeKey } from './keys';
import { currentPath } from '../tools';

// Narrow enough that result lists render as a single column (linear order),
// tall enough that long episode lists and result pages fit without scrolling.
export const COLS = 110;
export const ROWS = 80;

export class EngineTimeout extends Error {
  constructor(what: string, readonly screen: string) {
    super(`Timed out waiting for ${what}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Output that only resets colours, moves the cursor or shows/hides it. The TUI sends that on
 * every ~100 ms tick even when nothing changed, so it must not count as drawing.
 */
const NO_DRAW = /\x1b\[[0-9;?]*[mHhl]|\x1b\[\d* q/g;

/** Terminal hints that would make the TUI try image protocols or tmux paths. */
const STRIP_ENV = ['WT_SESSION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'KITTY_WINDOW_ID', 'TMUX', 'GHOSTTY_RESOURCES_DIR', 'ALACRITTY_LOG', 'ALACRITTY_WINDOW_ID', 'ALACRITTY_SOCKET', 'WEZTERM_EXECUTABLE'];

export class EngineSession extends EventEmitter {
  private pty: IPty | null = null;
  private term: Terminal | null = null;
  private serializer: SerializeAddon | null = null;
  private lastOutput = 0;
  private stopping = false;
  /** Optional step log (key presses, waits and how long they took) for diagnosing slowness. */
  trace: ((line: string) => void) | null = null;

  constructor(
    private readonly binary: string,
    private readonly extraEnv: Record<string, string> = {},
  ) {
    super();
  }

  get running(): boolean {
    return this.pty !== null;
  }

  start(): void {
    const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    // The TUI queries the terminal (device attributes, cursor position); xterm answers.
    term.onData((d) => this.pty?.write(d));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP_ENV.includes(k) && k.toUpperCase() !== 'PATH') env[k] = v;
    // The TUI looks for yt-dlp and the players on PATH: give it PATH as it is now, not as it was at app start.
    env.PATH = currentPath();
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', MOVIEBOX_NO_IMAGE: '1', MOVIEBOX_IMAGE_PROTOCOL: 'none' }, this.extraEnv);

    // useConptyDll: the console host shipped with the terminal library, not Windows' own. Every
    // Windows version then behaves the same — older Windows 10 builds lack win32-input-mode,
    // which the key encoding relies on.
    const pty = spawn(this.binary, [], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: os.homedir(), env, useConptyDll: true });
    pty.onData((d) => {
      if (d.replace(NO_DRAW, '')) this.lastOutput = Date.now();
      term.write(d, () => this.emit('render'));
      this.emit('data', d);
    });
    pty.onExit(({ exitCode }) => {
      if (this.pty !== pty) return;
      this.pty = null;
      this.emit('exit', { exitCode, expected: this.stopping });
    });

    this.term?.dispose();
    this.term = term;
    this.serializer = serializer;
    this.pty = pty;
    this.stopping = false;
  }

  async stop(): Promise<void> {
    const pty = this.pty;
    if (!pty) return;
    this.stopping = true;
    const exited = new Promise<void>((r) => this.once('exit', () => r()));
    pty.write(encodeKey('ctrl+c'));
    await Promise.race([exited, sleep(2000)]);
    if (this.pty === pty) {
      try { pty.kill(); } catch { /* already gone */ }
      this.pty = null;
    }
  }

  screen(): Screen {
    if (!this.term) throw new Error('Engine is not running');
    return new Screen(this.term);
  }

  /** Full-screen ANSI snapshot, used to paint the engine console on open. */
  serialize(): string {
    return this.serializer?.serialize() ?? '';
  }

  write(raw: string): void {
    this.pty?.write(raw);
  }

  writeFromConsole(data: string): void {
    this.pty?.write(encodeConsoleInput(data));
  }

  /**
   * Sends a key and waits for the TUI's next redraw (bounded). Callers that
   * need a particular result wait for it explicitly with `waitFor`.
   */
  async key(key: string, times = 1): Promise<void> {
    const t0 = Date.now();
    for (let i = 0; i < times; i++) {
      this.write(encodeKey(key));
      if (times > 1) await sleep(25);
    }
    await this.settle();
    this.trace?.(`key ${key}${times > 1 ? ` x${times}` : ''} ${Date.now() - t0}ms`);
  }

  /** Types text into the focused input in one write (ConPTY turns it into key events). */
  async type(text: string): Promise<void> {
    const t0 = Date.now();
    this.write(text);
    await this.settle();
    this.trace?.(`type "${text}" ${Date.now() - t0}ms`);
  }

  /** Resolves shortly after the next redraw, or after `maxMs` if the screen doesn't change. */
  settle(maxMs = 250): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('render', onRender);
        setTimeout(resolve, 35);
      };
      const onRender = () => done();
      const timer = setTimeout(done, maxMs);
      this.once('render', onRender);
    });
  }

  /** Milliseconds since the TUI last drew anything. */
  quietFor(): number {
    return Date.now() - this.lastOutput;
  }

  /** Waits until the TUI stops drawing (spinners keep it busy, hence the cap). */
  async idle(quietMs = 90, maxMs = 1200): Promise<void> {
    const start = Date.now();
    await sleep(25);
    while (Date.now() - this.lastOutput < quietMs && Date.now() - start < maxMs) await sleep(20);
  }

  /** Polls the screen on every redraw until `test` returns a truthy value. */
  waitFor<T>(what: string, test: (s: Screen) => T | null | undefined | false, timeoutMs = 15000): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      const check = () => {
        if (done || !this.term) return;
        try {
          const s = this.screen();
          const v = test(s);
          if (v) finish(() => { this.trace?.(`wait ${what} ${Date.now() - started}ms`); resolve(v); });
          else if (Date.now() - started > timeoutMs) finish(() => reject(new EngineTimeout(what, s.text())));
        } catch (e) {
          finish(() => reject(e)); // a failing check must end the wait, not repeat forever
        }
      };
      // The engine exiting ends every wait at once instead of after its timeout.
      const onExit = () => finish(() => reject(new Error('The engine stopped.')));
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        this.off('render', check);
        this.off('exit', onExit);
        fn();
      };
      const started = Date.now();
      const timer = setInterval(check, 150);
      this.on('render', check);
      this.once('exit', onExit);
      check();
    });
  }
}
