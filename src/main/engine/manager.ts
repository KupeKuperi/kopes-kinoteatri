// Owns the engine lifecycle: finds the binary, keeps one hidden TUI session
// alive, and turns what the TUI draws (toasts, download panel, spinners) into
// events for the GUI.
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { ActiveDownload, EngineStatus, GuiSettings, Toast } from '@shared/types';
import { detectBinary } from '../binary';
import type { CacheIndex } from '../data/cacheIndex';
import { readTuiConfigRaw, setActiveMode } from '../data/config';
import { Driver } from './driver';
import { classify, parseDownloadPanel, parseInput, parseToasts, providerFromLabel, spinnerText } from './screen';
import { EngineSession } from './session';

/** Is `pid` a running moviebox-tui? (Process ids are reused, so the name must match too.) */
function isEngineProcess(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (err: Error | null, out: string) => resolve(!err && /moviebox-tui/i.test(out));
    if (process.platform === 'win32') execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (e, o) => done(e, o));
    else execFile('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000 }, (e, o) => done(e, o));
  });
}

export class EngineManager extends EventEmitter {
  session: EngineSession | null = null;
  /** One driver for the app's lifetime: open lists and titles survive an engine restart. */
  driver: Driver | null = null;
  status: EngineStatus = { state: 'starting', binary: null, activity: null, tuiStatus: null, mode: null, provider: null, error: null };

  private crashes: number[] = [];
  private originalMode: string | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private visibleToasts = new Set<string>();
  private toastSeq = 0;
  private lastDownloads = '[]';
  /** File name from the TUI's latest "Download started" notice (its progress panel has none). */
  private downloadName: string | null = null;
  /** start/stop/restart run one at a time (double clicks, crash restarts, settings saves). */
  private lifecycle: Promise<void> = Promise.resolve();
  private generation = 0;
  /** Extra environment for the engine, read each time it starts (phone access sets its players). */
  extraEnv: () => Record<string, string> = () => ({});

  constructor(
    readonly cache: CacheIndex,
    /** The GUI's own settings (engine location, subtitle choice), read when needed. */
    private readonly gui: () => GuiSettings,
    /** Notes the running engine's process id, so an engine this app couldn't stop is ended next start. */
    private readonly pidFile: string | null = null,
  ) {
    super();
  }

  private notePid(pid: number | null) {
    if (!this.pidFile) return;
    try {
      if (pid) fs.writeFileSync(this.pidFile, JSON.stringify({ pid }));
      else fs.rmSync(this.pidFile, { force: true });
    } catch {
      /* only a safety net */
    }
  }

  /**
   * Ends an engine that a previous run of this app left running: it crashed or was killed before it
   * could stop its engine (normally quitting stops it). Only a moviebox-tui process with the noted id.
   */
  async reapOrphan(): Promise<void> {
    if (!this.pidFile) return;
    let pid = 0;
    try {
      pid = Number(JSON.parse(fs.readFileSync(this.pidFile, 'utf8')).pid) || 0;
    } catch {
      return; // the last run stopped its engine
    }
    this.notePid(null);
    if (!pid || !(await isEngineProcess(pid))) return;
    try {
      process.kill(pid);
    } catch {
      /* gone meanwhile */
    }
  }

  private setStatus(patch: Partial<EngineStatus>) {
    const next = { ...this.status, ...patch };
    if (next.activity) next.state = 'busy';
    else if (next.state === 'busy') next.state = 'ready';
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    this.emit('status', next);
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const p = this.lifecycle.then(fn);
    this.lifecycle = p.catch(() => undefined);
    return p;
  }

  start(): Promise<void> {
    return this.enqueue(() => this.doStart());
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  restart(): Promise<void> {
    return this.enqueue(async () => {
      await this.doStop();
      this.crashes = [];
      await this.doStart();
    });
  }

  private async doStart(): Promise<void> {
    if (this.session) return; // already running
    const gen = ++this.generation;
    this.setStatus({ state: 'starting', error: null, activity: null });
    const binary = await detectBinary(this.gui().binaryPath);
    if (gen !== this.generation) return;
    if (!binary) {
      this.setStatus({ state: 'missing', binary: null, error: 'moviebox-tui was not found. Set its location in Settings.' });
      return;
    }
    this.originalMode ??= (readTuiConfigRaw()?.active_mode as string | undefined) ?? null;

    const session = new EngineSession(binary.path, this.extraEnv());
    if (!this.driver) {
      const driver = new Driver(session, this.cache, () => this.gui().subtitles);
      driver.on('activity', (activity: string | null) => this.setStatus({ activity }));
      driver.on('details', (v) => this.emit('details', v));
      driver.on('results', (v) => this.emit('results', v));
      driver.on('subtitles', (v) => this.emit('subtitles', v));
      this.driver = driver;
    } else {
      this.driver.attach(session);
    }
    session.on('data', (d: string) => this.session === session && this.emit('console-data', d));
    session.on('render', () => this.session === session && this.scheduleMonitor());
    session.on('exit', ({ exitCode, expected }: { exitCode: number; expected: boolean }) => {
      if (this.session !== session) return;
      this.notePid(null);
      this.session = null;
      if (expected) return this.setStatus({ state: 'stopped', activity: null });
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < 60000), now];
      if (this.crashes.length > 3) {
        this.setStatus({ state: 'error', activity: null, error: `The engine exited ${this.crashes.length} times in a minute (last code ${exitCode}).` });
      } else {
        this.setStatus({ state: 'starting', activity: null, error: `The engine exited (code ${exitCode}); restarting.` });
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          void this.start();
        }, 800);
      }
    });

    this.session = session;
    this.setStatus({ binary });
    session.start();
    try {
      await session.waitFor('the engine to start', (s) => classify(s) !== 'unknown', 20000);
      // Its process id is known once it runs (the Windows pseudo-terminal reports it late).
      this.notePid(session.pid);
      // Right after its first frame the TUI blanks the screen for ~0.4 s to show its size ("110 × 80").
      await session.idle(250, 2500);
      await session.waitFor('the engine to start', (s) => classify(s) !== 'unknown', 5000);
      if (gen === this.generation && this.session === session) this.setStatus({ state: 'ready', error: null });
    } catch {
      if (gen === this.generation && this.session === session) {
        this.setStatus({ state: 'error', error: 'The engine started but never drew its home screen. Open the console to see why.' });
      }
    }
  }

  private async doStop(): Promise<void> {
    this.generation++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const session = this.session;
    this.session = null;
    await session?.stop();
    if (session) this.notePid(null);
    this.setStatus({ state: 'stopped', activity: null, tuiStatus: null });
  }

  /** Stops the engine and leaves the terminal app in the mode it was in before. */
  async shutdown(): Promise<void> {
    await this.stop();
    if (this.originalMode) setActiveMode(this.originalMode);
  }

  /** A download is running inside the engine (a restart would stop it). */
  get downloading(): boolean {
    return this.lastDownloads !== '[]';
  }

  requireDriver(): Driver {
    if (!this.driver || !this.session) throw new Error(this.status.error ?? 'The engine is not running.');
    return this.driver;
  }

  // ── Screen monitor ───────────────────────────────────────────────────────

  private scheduleMonitor() {
    if (this.monitorTimer) return;
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = null;
      this.monitor();
    }, 200);
  }

  /** Reads the screen now (status, toasts, downloads) instead of after the next redraw. */
  refreshStatus(): void {
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
    this.monitor();
  }

  private monitor() {
    const session = this.session;
    if (!session) return;
    const s = session.screen();

    const now = new Set<string>();
    for (const t of parseToasts(s)) {
      const key = `${t.kind}|${t.title}|${t.message}`;
      now.add(key);
      if (!this.visibleToasts.has(key)) {
        const started = /^Downloading (.+?)(?: \(resumable\))?\.?$/.exec(t.message);
        if (/download started/i.test(t.title) && started) this.downloadName = started[1];
        const toast: Toast = { id: ++this.toastSeq, ...t };
        this.emit('toast', toast);
      }
    }
    this.visibleToasts = now;

    const panel = parseDownloadPanel(s) ?? [];
    const downloads: ActiveDownload[] = panel.map((d) => ({
      ...d,
      label: this.downloadName && panel.length === 1 && /^download/i.test(d.label) ? this.downloadName : d.label,
    }));
    const dl = JSON.stringify(downloads);
    if (dl !== this.lastDownloads) {
      this.lastDownloads = dl;
      this.emit('downloads', downloads);
    }

    this.driver?.noticePicker();

    const kind = classify(s);
    const provider = providerFromLabel(parseInput(s)?.label ?? '') ?? this.status.provider;
    this.setStatus({
      tuiStatus: spinnerText(s),
      mode: kind === 'tv' || kind === 'tv-playlists' ? 'tv' : kind === 'unknown' ? this.status.mode : 'streaming',
      provider,
    });
  }
}
