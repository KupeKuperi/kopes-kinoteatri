// Drives the hidden moviebox-tui session: every GUI intent becomes the same
// keystrokes a person would type, and results are read back from the TUI's
// screen (state, ordering, focus) and its response caches (posters, synopses,
// stream metadata). Operations run one at a time.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  BrowseCategory,
  DetailsInfo,
  DetailsState,
  DetailsView,
  DownloadScope,
  HistoryEntry,
  PaneName,
  ResultItem,
  ResultsView,
  StreamOption,
  StreamsStatus,
  SubtitleChoice,
} from '@shared/types';
import { providerId, type CacheIndex } from '../data/cacheIndex';
import { fixMojibake } from '../data/mbc';
import { logsDir } from '../paths';
import type { EngineSession } from './session';
import {
  classify,
  parseCardMeta,
  parseDetails,
  parseDownloadPanel,
  parseInput,
  parseResults,
  parseStreamRows,
  parseSubtitlePicker,
  providerFromLabel,
  type Card,
  type DetailsScreen,
  type Pane,
  type ResultsScreen,
  type Screen,
} from './screen';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TUI_LOG = () => path.join(logsDir(), 'moviebox-tui_rCURRENT.log');

/**
 * Resolution from the release name when it states one: the engine labels some
 * 1080p releases "4K" (4KHDHub) and some 540p ones "480p" (Dramachi).
 */
export function resolutionOf(release: string | undefined, screen: string): string {
  const m = /(?:^|[^a-z0-9])(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p)(?:[^a-z0-9]|$)/i.exec(release ?? '');
  if (m) return m[1].toLowerCase();
  return screen === '4K' ? '2160p' : screen;
}

/** Notable format details from a release name, e.g. `REMUX · DV · HDR10 · Atmos · HEVC`. */
export function mediaTags(release: string | undefined): string | undefined {
  if (!release) return undefined;
  const r = ` ${release} `;
  const tags: string[] = [];
  const add = (test: RegExp, tag: string) => test.test(r) && !tags.includes(tag) && tags.push(tag);
  add(/[^a-z]remux[^a-z]/i, 'REMUX');
  add(/[^a-z](dv|dovi|dolby[ .]?vision)[^a-z]/i, 'Dolby Vision');
  add(/hdr10\+|hdr10plus/i, 'HDR10+');
  if (!tags.includes('HDR10+')) add(/[^a-z]hdr(10)?[^a-z+]/i, 'HDR');
  add(/atmos/i, 'Atmos');
  add(/[^0-9]7\.1[^0-9]/, '7.1');
  if (!tags.includes('7.1')) add(/[^0-9]5\.1[^0-9]/, '5.1');
  add(/x265|h\.?265|hevc/i, 'HEVC');
  if (!tags.includes('HEVC')) add(/x264|h\.?264|[^a-z]avc[^a-z]/i, 'H.264');
  add(/[^a-z]av1[^a-z]/i, 'AV1');
  add(/10[ -]?bit/i, '10-bit');
  return tags.length ? tags.join(' · ') : undefined;
}

/** Text as the screen model renders it: characters outside the BMP (emoji) become one "□" cell. */
export const asScreenText = (text: string) => text.replace(/[\u{10000}-\u{10FFFF}]/gu, '\u25a1');

/** Does the search box show `text`? Long input is drawn as "...<end of text>". */
export function inputMatches(shown: string | undefined, text: string): boolean {
  if (shown === undefined) return false;
  const want = asScreenText(text);
  if (shown === want) return true;
  for (const ellipsis of ['...', '…']) {
    if (shown.startsWith(ellipsis) && shown.length > ellipsis.length + 3) return want.endsWith(shown.slice(ellipsis.length));
  }
  return false;
}

/**
 * The home box cuts input that doesn't fit at the end and adds the key hint:
 * "The Lord of the Rings: The Fellowship of th [Enter] Search". Returns the visible start.
 */
export function inputHead(shown: string | undefined): string | null {
  return (shown && /^(.+?)\s+\[Enter\] \w+$/.exec(shown)?.[1]) || null;
}

/** Spellings a source may use for a language, besides the English name the TUI shows. */
const SUBTITLE_ALIASES: Record<string, string[]> = { georgian: ['ქართული', 'kat', 'geo', 'ka'] };

/**
 * The option of the TUI's subtitle chooser that `preference` means: 0 ("No subtitles") for 'off',
 * the first option in that language, or null to ask ('ask', or the language isn't offered).
 */
export function pickSubtitle(options: string[], preference: string): number | null {
  const pref = preference.trim().toLowerCase();
  if (!pref || pref === 'ask') return null;
  if (pref === 'off') return 0;
  const label = (o: string) => o.trim().toLowerCase();
  const exact = options.findIndex((o, i) => i > 0 && (label(o) === pref || (SUBTITLE_ALIASES[pref] ?? []).includes(label(o))));
  if (exact > 0) return exact;
  // "Portuguese" also takes "Portuguese (BR)"; "English" takes "English SDH".
  const loose = options.findIndex((o, i) => i > 0 && (label(o).startsWith(`${pref} `) || label(o).startsWith(`${pref}(`)));
  return loose > 0 ? loose : null;
}

const matchNorm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Index of the result that is `ref` (same title; same or adjacent year), or -1. */
export function matchTitle(items: ResultItem[], ref: { title: string; year?: string; subjectId?: string }): number {
  if (ref.subjectId) {
    const i = items.findIndex((x) => x.subjectId === ref.subjectId);
    if (i >= 0) return i;
  }
  const want = matchNorm(ref.title);
  const same = items.map((x, i) => ({ x, i })).filter(({ x }) => matchNorm(x.title) === want);
  if (!same.length) return -1;
  if (!ref.year) return same[0].i;
  const y = Number(ref.year);
  const exact = same.find(({ x }) => Number(x.year) === y);
  if (exact) return exact.i;
  const near = same.find(({ x }) => Math.abs(Number(x.year) - y) <= 1);
  return near ? near.i : -1;
}

const emptyView = (label: string, provider: string | null): ResultsView => ({
  key: `${provider ?? '?'}|search|${label}|`,
  source: 'search',
  label,
  provider,
  total: 0,
  items: [],
});

/** Keys that act as shortcuts while the TUI's search box is empty (verified on v0.1.26). */
const UNSAFE_FIRST = /^[gGcCrRqQ?\s]$/;

/** Looser versions of a query that found nothing: "squid game 2" → "squid game". */
export function relaxQuery(query: string): string[] {
  const q = query.trim().replace(/\s+/g, ' ');
  const out: string[] = [];
  const stripped = q
    .replace(/\b(season|part|vol(?:ume)?|chapter|episode|ep)\s*\d+\b/gi, '')
    .replace(/\bs\d{1,2}(e\d{1,3})?\b/gi, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/\s+(\d{1,2}|ii|iii|iv)$/i, '')
    .replace(/[\s:\-–]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped && stripped.toLowerCase() !== q.toLowerCase()) out.push(stripped);
  const beforeColon = (stripped || q).split(/\s*:\s*/)[0];
  if (beforeColon && beforeColon.length >= 3 && beforeColon.toLowerCase() !== (stripped || q).toLowerCase()) out.push(beforeColon);
  const words = (stripped || q).split(' ');
  if (words.length >= 3) out.push(words.slice(0, -1).join(' '));
  return [...new Set(out)].filter((x) => x.length >= 2).slice(0, 3);
}

interface ResultsContext {
  /** Identity of the list (source, kind, label) — what the GUI refers to when opening item N. */
  key: string;
  source: 'search' | 'browse';
  label: string;
  browseIndex?: number;
  view: ResultsView;
}

interface DetailsContext {
  /** The list the title was opened from, to reopen it if the TUI moves away. */
  listKey: string;
  index: number;
  title: string;
  /** Cache id of the source the title came from (moviebox, fourkhdhub, …). */
  provider?: string;
  year?: string;
  baseInfo: DetailsInfo | null;
  info: DetailsInfo | null;
  audioIndex: number | null;
  current: { season: number; episode: number } | null;
  captions: DetailsView['captions'];
}

export class Driver extends EventEmitter {
  private chain: Promise<unknown> = Promise.resolve();
  /** The result list the TUI is showing (or showed last). */
  private results: ResultsContext | null = null;
  /** Recent lists by key: search-as-you-type must not change what the visible page opens. */
  private lists = new Map<string, ResultsContext>();
  private details: DetailsContext | null = null;
  /** Discover categories per source (MovieBox and Addons have them; 4KHDHub and Dramachi don't). */
  private categoriesBySource = new Map<string, BrowseCategory[]>();
  /** Last source label read from the TUI's search box (e.g. `MovieBox`, `4KHDHub`). */
  private source: string | null = null;
  /** Number of operations in flight; the details watcher stays quiet while one runs. */
  private busy = 0;
  private watchTimer: NodeJS.Timeout | null = null;
  /** The subtitle question the GUI is showing (the TUI's chooser stays open until it answers). */
  private offered: SubtitleChoice | null = null;
  /** What the TUI's subtitle chooser is for: the last play or download this driver started. */
  private pickerPurpose: SubtitleChoice['purpose'] = 'play';

  constructor(
    private session: EngineSession,
    private readonly cache: CacheIndex,
    /** The subtitle setting (a language, 'off' or 'ask'), read when the TUI asks. */
    private readonly subtitlePreference: () => string = () => 'English',
  ) {
    super();
  }

  /**
   * Uses a new engine session (after a restart). Lists and the open title are
   * kept: the next action re-navigates the TUI to them.
   */
  attach(session: EngineSession): void {
    this.session = session;
  }

  /**
   * Serializes engine operations; `activity` is shown in the GUI while it runs. A subtitle chooser
   * left open (the GUI's question was abandoned) is closed first, unless the operation answers it.
   */
  private run<T>(activity: string, fn: () => Promise<T>, opts: { keepPicker?: boolean } = {}): Promise<T> {
    const p = this.chain.then(async () => {
      this.busy++;
      this.emit('activity', activity);
      try {
        if (!opts.keepPicker) await this.closePicker();
        return await fn();
      } finally {
        this.busy--;
        this.emit('activity', null);
      }
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Forget navigation context. */
  reset(): void {
    this.results = null;
    this.details = null;
    this.lists.clear();
  }

  private get s(): Screen {
    return this.session.screen();
  }

  private key(k: string, times = 1) {
    return this.session.key(k, times);
  }

  // ── Navigation primitives ────────────────────────────────────────────────

  /**
   * Brings the TUI to its streaming home screen. Only there is the search box
   * guaranteed to take typing: on a result list or the "No results" screen,
   * letters are hotkeys (d = download, c = clear, q = quit…). Esc walks back:
   * details → list → search box → home.
   */
  private async toSearchInput(): Promise<void> {
    for (let i = 0; i < 12; i++) {
      const kind = classify(this.s);
      if (kind === 'home') {
        this.source = this.currentProvider() ?? this.source;
        return;
      }
      if (kind === 'unknown') {
        // Between screens (and once at startup, for its size overlay) the TUI draws nothing known: wait before pressing keys.
        const known = await this.session.waitFor('the engine screen', (x) => classify(x) !== 'unknown', 1500).then(() => true, () => false);
        if (!known) await this.key('esc');
      } else if (kind === 'tv') {
        await this.key('ctrl+s');
        const left = await this.session.waitFor('streaming mode', (x) => classify(x) !== 'tv', 3000).then(() => true, () => false);
        if (!left) await this.key('esc');
      } else if (kind === 'searching') {
        await this.session.waitFor('search to finish', (x) => classify(x) !== 'searching', 40000);
      } else {
        await this.key('esc');
      }
    }
    throw new Error('The engine did not return to its search screen. Open the engine console to see what it is showing.');
  }

  /**
   * Types into the empty search box. While it is empty some keys are
   * shortcuts, not text (g/G jump, c clears, r refreshes, ? opens help, space
   * resumes — and q quits the TUI). Once it holds one character everything is
   * text, so type from the first safe character, press Home, then type the start.
   */
  private async typeQuery(text: string): Promise<void> {
    if (text.startsWith('/')) return this.session.type(text); // slash commands want the palette
    const chars = Array.from(text);
    const i = chars.findIndex((ch) => !UNSAFE_FIRST.test(ch));
    if (i === 0) return this.session.type(text);
    if (i > 0) {
      await this.session.type(chars.slice(i).join(''));
      await this.key('home');
      await this.session.type(chars.slice(0, i).join(''));
      return;
    }
    // Every character is a shortcut (e.g. "gr"): start from a placeholder and remove it.
    await this.session.type('x');
    await this.key('home');
    await this.session.type(text);
    await this.key('end');
    await this.key('backspace');
  }

  /** Runs a slash command or query from the home screen's search box. */
  private async submit(text: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      await this.toSearchInput();
      await this.key('ctrl+u');
      if (classify(this.s) === 'home') break;
      // Something drew over the home screen (an overlay, a popup): find the search box once more.
      if (attempt > 0) throw new Error('The engine left its search screen unexpectedly.');
    }
    await this.typeQuery(text);
    const want = asScreenText(text);
    await this.session.waitFor(
      `“${text}” in the search box`,
      (s) => {
        const shown = parseInput(s)?.text;
        if (inputMatches(shown, text)) return true;
        // Too long for the box: only the start shows. Accept it once the TUI has drawn all of the typing.
        const head = inputHead(shown);
        return Boolean(head && head.length >= 8 && want.startsWith(head) && this.session.quietFor() >= 150);
      },
      3000,
    );
    await this.key('enter');
  }

  /** Presses `key` and waits until `read` reports a different value (or a short timeout). */
  private async pressAndWatch<T>(key: string, times: number, read: () => T): Promise<void> {
    const before = read();
    await this.key(key, times);
    await this.session.waitFor('the selection to move', () => read() !== before, 1200).catch(() => undefined);
  }

  private async waitForList(what: string, timeoutMs = 45000): Promise<ResultsScreen> {
    return this.session.waitFor(
      what,
      (s) => {
        if (classify(s) !== 'results') return null;
        const r = parseResults(s);
        return r && (r.total !== null || r.message) ? r : null;
      },
      timeoutMs,
    );
  }

  /** Reads every card of the current list, paging through it if it doesn't fit. */
  private async collectCards(first: ResultsScreen): Promise<Card[]> {
    const total = first.total ?? first.cards.length;
    const byIndex = new Map<number, Card>();
    first.cards.forEach((c, i) => byIndex.set(i, c));
    let paged = false;
    for (let guard = 0; byIndex.size < total && guard < 15; guard++) {
      await this.pressAndWatch('pgdn', 1, () => parseResults(this.s)?.selected);
      paged = true;
      const r = parseResults(this.s);
      if (!r || r.selected === null) break;
      const hi = r.cards.findIndex((c) => c.highlighted);
      const offset = r.selected - (hi >= 0 ? hi : r.cards.length - 1);
      const before = byIndex.size;
      r.cards.forEach((c, i) => byIndex.set(offset + i, c));
      if (byIndex.size === before && r.selected >= total - 1) break;
    }
    if (paged) await this.key('home');
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  }

  private toItems(cards: Card[]): ResultItem[] {
    return cards.map((c, index) => {
      const meta = parseCardMeta(c.meta);
      const subject = this.cache.findSubject(c.title, meta.year, meta.type, providerId(meta.provider));
      return {
        index,
        title: c.title,
        year: meta.year,
        type: meta.type,
        rating: meta.rating ?? (subject ? this.cache.rating(subject.provider, subject.id) : undefined),
        provider: meta.provider,
        episodeTag: meta.episodeTag,
        subjectId: subject?.id,
        cover: subject?.cover,
        badges: subject && /\[CAM\]/i.test(subject.title) ? ['CAM'] : undefined,
      };
    });
  }

  private async moveSelection(target: number): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = parseResults(this.s);
      if (!r?.listFocused || r.selected === null) throw new Error('The engine’s result list is not focused.');
      const diff = target - r.selected;
      if (diff === 0) return;
      await this.pressAndWatch(diff > 0 ? 'down' : 'up', Math.abs(diff), () => parseResults(this.s)?.selected);
    }
    throw new Error(`Could not move the engine’s selection to item ${target + 1}.`);
  }

  /** After results load, the TUI prefetches details (ratings) in the background. */
  private enrichLater(ctx: ResultsContext) {
    for (const delay of [1500, 4000]) {
      setTimeout(() => {
        if (this.results !== ctx) return;
        let changed = false;
        const items = ctx.view.items.map((it) => {
          if (it.rating && it.cover) return it;
          const subject = this.cache.findSubject(it.title, it.year, it.type, providerId(it.provider));
          const rating = it.rating ?? (subject ? this.cache.rating(subject.provider, subject.id) : undefined);
          const cover = it.cover ?? subject?.cover;
          if (rating === it.rating && cover === it.cover) return it;
          changed = true;
          return { ...it, rating, cover, subjectId: it.subjectId ?? subject?.id };
        });
        if (changed) {
          ctx.view = { ...ctx.view, items };
          this.emit('results', ctx.view);
        }
      }, delay);
    }
  }

  private async loadList(source: ResultsContext['source'], label: string, browseIndex?: number): Promise<ResultsView> {
    let r = await this.waitForList(`results for “${label}”`);
    await this.session.settle();
    r = parseResults(this.s) ?? r;
    const cards = r.total ? await this.collectCards(r) : [];
    const provider = providerFromLabel(r.input.label) ?? this.source;
    const key = `${provider ?? '?'}|${source}|${label}|${browseIndex ?? ''}`;
    const view: ResultsView = {
      key,
      source,
      label,
      provider,
      total: r.total ?? cards.length,
      items: this.toItems(cards),
      message: r.message,
    };
    const ctx: ResultsContext = { key, source, label, browseIndex, view };
    this.results = ctx;
    this.lists.delete(key);
    this.lists.set(key, ctx);
    while (this.lists.size > 30) this.lists.delete(this.lists.keys().next().value!);
    this.enrichLater(ctx);
    return view;
  }

  /** True if the TUI shows this list with the list (not the search box) focused. */
  private showsListFocused(ctx: ResultsContext): boolean {
    const s = this.s;
    if (classify(s) !== 'results') return false;
    const r = parseResults(s);
    if (!r?.listFocused || r.total !== ctx.view.total) return false;
    // Search lists keep the query in the box; Discover lists show "<label> · N items".
    return ctx.source === 'search' ? inputMatches(r.input.text, ctx.label) : r.input.text.startsWith(ctx.label);
  }

  /** Makes sure the TUI shows `ctx` (re-running its search or category if needed), list focused. */
  private async ensureResults(ctx: ResultsContext | null = this.results): Promise<void> {
    if (!ctx) throw new Error('Search for something first.');
    if (classify(this.s) === 'details') {
      await this.key('esc');
      await this.session.waitFor('result list', (s) => classify(s) === 'results', 4000).catch(() => undefined);
    }
    if (this.showsListFocused(ctx)) {
      this.results = ctx;
      return;
    }
    if (ctx.view.provider && this.source && ctx.view.provider !== this.source) {
      throw new Error(`This list came from ${ctx.view.provider}, but the active source is ${this.source}. Switch back or search again.`);
    }
    if (ctx.source === 'search') {
      await this.submit(ctx.label);
      await this.waitForList(`results for “${ctx.label}”`);
    } else {
      await this.openBrowseCategory(ctx.browseIndex ?? 0);
      await this.waitForList(`“${ctx.label}”`);
    }
    await this.session.settle();
    this.results = ctx;
  }

  // ── Details helpers ──────────────────────────────────────────────────────

  private detailsScreen(): DetailsScreen {
    const d = parseDetails(this.s);
    if (!d) throw new Error('The engine is not showing a title’s details.');
    return d;
  }

  private pane(name: PaneName): Pane | undefined {
    return this.detailsScreen().panes.find((p) => p.name === name);
  }

  private async focusPane(name: PaneName): Promise<void> {
    for (let i = 0; i < 6; i++) {
      const d = this.detailsScreen();
      if (!d.panes.some((p) => p.name === name)) throw new Error(`This title has no ${name.toLowerCase()} list.`);
      if (d.panes.find((p) => p.focused)?.name === name) return;
      await this.key('tab');
    }
    throw new Error(`Could not focus the ${name.toLowerCase()} list.`);
  }

  private rowsOf(pane: Pane) {
    return pane.rows.filter((r) => r.text && !/^[│\s]*$/.test(r.text));
  }

  /** Moves the highlight in Audio/Seasons/Episodes to the row matching `match`. */
  private async moveInPane(name: PaneName, targetPos: number, positionOf: (text: string) => number | null): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const pane = this.pane(name);
      if (!pane) throw new Error(`This title has no ${name.toLowerCase()} list.`);
      const hi = this.rowsOf(pane).find((r) => r.highlighted);
      const current = hi ? positionOf(hi.text) : null;
      if (current === null) throw new Error(`Could not read the ${name.toLowerCase()} selection.`);
      const diff = targetPos - current;
      if (diff === 0) return;
      await this.pressAndWatch(diff > 0 ? 'down' : 'up', Math.abs(diff), () => {
        const p = parseDetails(this.s)?.panes.find((x) => x.name === name);
        return p ? this.rowsOf(p).find((r) => r.highlighted)?.text : undefined;
      });
    }
    throw new Error(`Could not select that ${name.toLowerCase().replace(/s$/, '')}.`);
  }

  private async moveStream(index: number): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const pane = this.pane('Streams');
      if (!pane) throw new Error('No streams are listed.');
      if (pane.pos === null) {
        // A pane with a single release shows no "· 1/1" position marker.
        if (parseStreamRows(pane).rows.length === 1 && index === 0) return;
        throw new Error('No streams are listed.');
      }
      const diff = index - pane.pos;
      if (diff === 0) return;
      await this.pressAndWatch(diff > 0 ? 'down' : 'up', Math.abs(diff), () => parseDetails(this.s)?.panes.find((x) => x.name === 'Streams')?.pos);
    }
    throw new Error('Could not select that stream.');
  }

  private streamsStatus(d: DetailsScreen): { status: StreamsStatus; message?: string; pane?: Pane } {
    const pane = d.panes.find((p) => p.name === 'Streams');
    if (!pane) return { status: 'idle' };
    const { rows, message } = parseStreamRows(pane);
    if (rows.length) return { status: 'ready', pane };
    if (message && /Loading streams/i.test(message)) return { status: 'loading', message, pane };
    if (message && /Choose an audio/i.test(message)) return { status: 'choose-audio', message, pane };
    if (message) return { status: 'empty', message, pane };
    // Several audio tracks and a blank Streams pane: the TUI waits for a track (it doesn't always say so).
    const audio = d.panes.find((p) => p.name === 'Audio');
    if (audio && this.rowsOf(audio).length > 1) return { status: 'choose-audio', pane };
    return { status: 'idle', pane };
  }

  private streamsSignature(s: Screen): string {
    const d = parseDetails(s);
    if (!d) return '';
    const { status, message, pane } = this.streamsStatus(d);
    const first = pane ? parseStreamRows(pane).rows[0] : undefined;
    return `${status}|${message ?? ''}|${first?.release ?? ''}|${first?.size ?? ''}`;
  }

  /**
   * Waits for the Streams pane to react to the last key and then finish
   * loading. Right after a key press the previous result is still on screen.
   */
  private async settleStreams(before: string, timeoutMs = 4000): Promise<void> {
    await this.session
      .waitFor('streams to react', (s) => this.streamsSignature(s) !== before, 2500)
      .catch(() => undefined); // same result as before (e.g. cached) is fine
    // MovieBox answers in a second; Dramachi takes ~20 s and 4KHDHub up to a
    // minute. Don't hold the GUI: the details watcher delivers them when ready.
    await this.session
      .waitFor('streams to load', (s) => {
        const d = parseDetails(s);
        return d && this.streamsStatus(d).status !== 'loading';
      }, timeoutMs)
      .catch(() => undefined);
  }

  /** Before acting on a release: wait (long) for the list, and fail clearly if there is none. */
  private async streamsReady(timeoutMs = 150000): Promise<void> {
    const d = await this.session.waitFor('streams to load', (s) => {
      const x = parseDetails(s);
      return x && this.streamsStatus(x).status !== 'loading' ? x : null;
    }, timeoutMs);
    const st = this.streamsStatus(d);
    if (st.status !== 'ready') throw new Error(st.message ?? 'This title has no streams to choose from.');
  }

  /**
   * Keeps the GUI's details page current while the TUI is still filling it in
   * (slow sources add the synopsis, rating and streams up to a minute later).
   */
  private watchDetails(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    const ctx = this.details;
    const started = Date.now();
    let last = '';
    const stop = () => {
      if (this.watchTimer) clearInterval(this.watchTimer);
      this.watchTimer = null;
    };
    this.watchTimer = setInterval(() => {
      if (this.details !== ctx || !ctx || Date.now() - started > 180000) return stop();
      if (this.busy) return; // an operation is moving through screens right now
      const view = this.peekDetails();
      if (!view) return;
      const sig = JSON.stringify([view.state.streamsStatus, view.state.streamsMessage, view.streams.map((x) => x.release), view.info?.description, view.info?.rating, view.info?.cover]);
      if (sig !== last) {
        last = sig;
        this.emit('details', view);
      }
      if (view.state.streamsStatus !== 'loading' && ctx.info) stop();
    }, 1500);
  }

  private seasonList(): number[] {
    const fromInfo = this.details?.info?.seasons.map((s) => s.season);
    if (fromInfo?.length) return fromInfo;
    const pane = this.pane('Seasons');
    return pane ? this.rowsOf(pane).map((r) => Number(/(\d+)/.exec(r.text)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n)) : [];
  }

  private highlightedNumber(name: PaneName): number | null {
    const pane = this.pane(name);
    const hi = pane && this.rowsOf(pane).find((r) => r.highlighted);
    const m = hi && /(\d+)/.exec(hi.text);
    return m ? Number(m[1]) : null;
  }

  private buildView(): DetailsView {
    const ctx = this.details;
    if (!ctx) throw new Error('No title is open.');
    const d = this.detailsScreen();
    const { status, message, pane } = this.streamsStatus(d);
    const parsed = pane ? parseStreamRows(pane).rows : [];

    let current = ctx.current;
    const tag = parsed.map((r) => /S(\d+)E(\d+)/i.exec(r.release ?? '')).find(Boolean);
    if (tag) current = { season: Number(tag[1]), episode: Number(tag[2]) };
    if (status === 'ready') ctx.current = current;

    // Slow sources write their details cache after the screen appears.
    if (!ctx.info) {
      const late = this.cache.findDetails(ctx.title, { year: ctx.year, provider: ctx.provider });
      if (late) {
        ctx.info = late;
        ctx.baseInfo ??= late;
      }
    }
    const info = ctx.info;
    const cached = info && status === 'ready' ? this.cache.streams(info, current?.season, current?.episode) : null;
    const used = new Set<number>();
    const streams: StreamOption[] = parsed.map((row, index) => {
      // The cache lists releases in screen order; fall back to resolution when counts differ.
      let ci = cached && cached.length === parsed.length ? index : (cached?.findIndex((c, i) => !used.has(i) && c.resolution === row.resolution) ?? -1);
      if (ci < 0 && cached && index < cached.length && !used.has(index)) ci = index;
      const c = ci >= 0 && cached ? cached[ci] : undefined;
      if (ci >= 0) used.add(ci);
      const release = c?.release ?? row.release;
      return {
        index,
        resolution: resolutionOf(release, row.resolution),
        size: row.size,
        sizeBytes: c?.sizeBytes,
        tags: mediaTags(release) ?? (row.tags && row.tags !== '-' ? row.tags : undefined),
        source: row.source,
        release,
        codec: c?.codec,
        audio: c?.audio,
        season: c?.season,
        episode: c?.episode,
      };
    });

    const audioPane = d.panes.find((p) => p.name === 'Audio');
    const state: DetailsState = {
      title: d.title,
      meta: d.meta,
      panes: d.panes.map((p) => p.name),
      focus: d.panes.find((p) => p.focused)?.name ?? null,
      audioLabels: audioPane ? this.rowsOf(audioPane).map((r) => r.text) : [],
      selectedAudio: ctx.audioIndex,
      streamsStatus: status,
      streamsMessage: message,
      favorite: d.favorite,
    };
    return { index: ctx.index, info: info ?? this.infoFromScreen(d), state, streams, current, captions: ctx.captions };
  }

  /** Fallback when no details cache matched: what the screen shows. */
  private infoFromScreen(d: DetailsScreen): DetailsInfo {
    const seasonPane = d.panes.find((p) => p.name === 'Seasons');
    const episodePane = d.panes.find((p) => p.name === 'Episodes');
    const hiSeason = seasonPane && this.rowsOf(seasonPane).find((r) => r.highlighted);
    const season = Number(/(\d+)/.exec(hiSeason?.text ?? '')?.[1] ?? 1);
    const episodes = episodePane
      ? this.rowsOf(episodePane).map((r) => ({ season, episode: Number(/(\d+)/.exec(r.text)?.[1] ?? 0) })).filter((e) => e.episode > 0)
      : [];
    const metaTokens = d.meta.split(/\s{2,}/);
    const [synopsis, ...extra] = d.description.replace(/\s*\.\.\.\s*\[i: More\]/, '…').split(/\s+(?=(?:Genre|Director|Cast):)/);
    const field = (name: string) => {
      const v = extra.find((e) => e.startsWith(name + ':'))?.slice(name.length + 1).trim();
      return v && fixMojibake(v);
    };
    return {
      subjectId: '',
      provider: this.details?.provider ?? '',
      title: fixMojibake(d.title),
      kind: metaTokens.some((t) => /series/i.test(t)) ? 'series' : 'movie',
      year: metaTokens.find((t) => /^\d{4}$/.test(t)),
      rating: metaTokens.find((t) => t.startsWith('★'))?.replace('★', '').trim(),
      description: synopsis && !/^No description available/i.test(synopsis) ? fixMojibake(synopsis) : undefined,
      director: field('Director'),
      cast: field('Cast'),
      languages: metaTokens.find((t) => t.startsWith('Audio:'))?.slice(6).trim(),
      tags: field('Genre')?.split(/,\s*/) ?? [],
      seasons: seasonPane ? this.rowsOf(seasonPane).map((r) => ({ season: Number(/(\d+)/.exec(r.text)?.[1] ?? 0), episodes: [] as typeof episodes })).map((s) => (s.season === season ? { ...s, episodes } : s)) : [],
      audio: [],
    };
  }

  /**
   * Details cache for the title just opened. A file written since `newerThan`
   * is the subject the TUI actually opened (a title can exist as an original
   * and as dubs); otherwise the best title match.
   */
  private async waitForInfo(
    title: string,
    opts: { year?: string; subjectId?: string; provider?: string; newerThan?: number },
    timeoutMs = 6000,
  ): Promise<DetailsInfo | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const info = this.cache.findDetails(title, opts);
      if (info && (!opts.subjectId || info.subjectId === opts.subjectId)) return info;
      await sleep(250);
    }
    if (opts.subjectId) return null;
    return this.cache.findDetails(title, { ...opts, newerThan: undefined });
  }

  /** Re-opens the current title if the TUI has moved away from it (console use, restart). */
  private async ensureDetails(): Promise<void> {
    const ctx = this.details;
    if (!ctx) throw new Error('Open a title first.');
    const d = parseDetails(this.s);
    if (d && d.title === ctx.title) return;
    const { audioIndex, current } = ctx;
    const list = this.lists.get(ctx.listKey);
    if (!list) throw new Error('Open the title again from its list.');
    await this.ensureResults(list);
    await this.openAt(ctx.index, list);
    if (audioIndex !== null) await this.applyAudio(audioIndex);
    if (current) {
      await this.applySeason(current.season);
      await this.applyEpisode(current.episode);
    }
  }

  /**
   * Presses Enter until the screen reacts. Right after a list draws, the TUI
   * can still be finishing its fetch and drops keys, so verify and retry.
   */
  private async enterUntil(what: string, reacted: (s: Screen) => boolean): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.key('enter');
      const ok = await this.session.waitFor(what, (s) => reacted(s), 2500).then(() => true, () => false);
      if (ok) return;
      await sleep(300);
    }
    throw new Error(`The engine did not respond while ${what}.`);
  }

  private logSize(): number {
    try {
      return fs.statSync(TUI_LOG()).size;
    } catch {
      return 0;
    }
  }

  private logSince(offset: number): string {
    try {
      const fd = fs.openSync(TUI_LOG(), 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size <= offset) return '';
        const buf = Buffer.alloc(Math.min(size - offset, 64 * 1024));
        fs.readSync(fd, buf, 0, buf.length, offset);
        return buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /**
   * Presses Enter (or `key`) on a release, channel or history entry and sees playback start,
   * confirmed through the TUI's log (`launching player: …`). For MovieBox titles the TUI first
   * looks up subtitles (up to 15 s) and, if there are any, asks which to load: that is answered
   * from the subtitle setting or handed to the GUI. Retries the key only if nothing at all
   * happened, so the player is never started twice.
   */
  private async pressPlay(key = 'enter'): Promise<void> {
    await this.session.idle(200, 1500);
    this.pickerPurpose = 'play';
    for (let attempt = 0; attempt < 2; attempt++) {
      const mark = this.logSize();
      const before = this.s.text();
      await this.key(key);
      let outcome = await this.awaitPlayback(mark, 4000);
      if (outcome === 'waiting' && this.s.text() === before) continue; // the key got lost
      if (outcome === 'waiting') outcome = await this.awaitPlayback(mark, 20000); // still looking up subtitles
      if (outcome === 'picker' && (await this.answerPicker()) === 'answered') await this.awaitPlayback(mark, 20000);
      return; // errors arrive as the TUI's own toasts
    }
    throw new Error('The engine did not start the player. Open the engine console to see what it is showing.');
  }

  /** Waits until the player launches, the TUI reports an error, or its subtitle chooser opens. */
  private async awaitPlayback(mark: number, timeoutMs: number): Promise<'launched' | 'error' | 'picker' | 'waiting'> {
    const started = Date.now();
    for (;;) {
      const log = this.logSince(mark);
      if (/launching player/i.test(log)) return 'launched';
      // Only the player's own failures: other sources log unrelated errors in the background.
      if (/ERROR \[[^\]]*(?:playback|player)[^\]]*\]/.test(log)) return 'error';
      if (parseSubtitlePicker(this.s)) return 'picker';
      if (Date.now() - started >= timeoutMs) return 'waiting';
      await sleep(150);
    }
  }

  // ── Subtitle chooser ─────────────────────────────────────────────────────

  /** Every option of the open subtitle chooser, scrolling through it when it is longer than its box. */
  private async readSubtitleOptions(): Promise<string[]> {
    const first = parseSubtitlePicker(this.s);
    if (!first) return [];
    if (first.rows.length >= first.total) return first.rows.slice(0, first.total);
    // A window of rows: from the top, the highlight moves down to the last row, then the list scrolls under it.
    const options: string[] = [];
    await this.movePicker(0);
    const top = parseSubtitlePicker(this.s);
    if (!top) return [];
    top.rows.forEach((r, i) => (options[i] = r));
    for (let i = top.rows.length; i < top.total; i++) {
      await this.movePicker(i);
      const p = parseSubtitlePicker(this.s);
      if (!p || p.selected !== i) break;
      options[i] = p.rows[p.rows.length - 1];
    }
    return options.filter((o) => o !== undefined);
  }

  /** Moves the chooser's highlight to option `index`. */
  private async movePicker(index: number): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const p = parseSubtitlePicker(this.s);
      if (!p) throw new Error('The engine closed its subtitle choice.');
      const diff = index - p.selected;
      if (diff === 0) return;
      await this.pressAndWatch(diff > 0 ? 'down' : 'up', Math.abs(diff), () => parseSubtitlePicker(this.s)?.selected);
    }
    throw new Error(`Could not move to subtitle option ${index + 1}.`);
  }

  /** Picks option `index` (0 = no subtitles) and waits for the chooser to close. */
  private async confirmPicker(index: number): Promise<void> {
    await this.movePicker(index);
    await this.key('enter');
    await this.session.waitFor('the subtitle choice to close', (s) => !parseSubtitlePicker(s), 4000);
  }

  /**
   * Answers the open chooser from the subtitle setting, or asks the GUI (the setting is 'ask', or
   * the title has no subtitles in that language). The chooser then stays open until `chooseSubtitle`.
   */
  private async answerPicker(): Promise<'answered' | 'asked' | 'none'> {
    if (!parseSubtitlePicker(this.s)) return 'none';
    const options = await this.readSubtitleOptions();
    const choice = pickSubtitle(options, this.subtitlePreference());
    if (choice !== null && choice < options.length) {
      await this.confirmPicker(choice);
      return 'answered';
    }
    this.offered = { purpose: this.pickerPurpose, title: this.details?.title ?? '', options };
    this.emit('subtitles', this.offered);
    return 'asked';
  }

  /** Closes a chooser nobody is going to answer (the GUI moved on): Esc cancels that play or download. */
  private async closePicker(): Promise<void> {
    if (this.offered) {
      this.offered = null;
      this.emit('subtitles', null);
    }
    if (!parseSubtitlePicker(this.s)) return;
    await this.key('esc');
    await this.session.waitFor('the subtitle choice to close', (s) => !parseSubtitlePicker(s), 3000).catch(() => undefined);
  }

  /** The GUI's answer to the subtitle question: option `index`, or -1 to cancel the play or download. */
  chooseSubtitle(index: number): Promise<void> {
    return this.run(
      index < 0 ? 'Cancelling' : this.offered?.purpose === 'download' ? 'Starting download' : 'Starting playback',
      async () => {
        const offered = this.offered;
        this.offered = null;
        this.emit('subtitles', null);
        if (!parseSubtitlePicker(this.s)) throw new Error('The engine is no longer waiting for a subtitle choice.');
        if (index < 0) {
          await this.key('esc');
          return;
        }
        const mark = this.logSize();
        await this.confirmPicker(index);
        if (offered?.purpose !== 'download') await this.awaitPlayback(mark, 20000);
      },
      { keepPicker: true },
    );
  }

  /**
   * Called by the screen monitor: a chooser that opened after the operation that caused it
   * stopped waiting (slow subtitle lookups) is answered here.
   */
  noticePicker(): void {
    if (this.busy || this.offered || !parseSubtitlePicker(this.s)) return;
    void this.run('Choosing subtitles', () => this.answerPicker(), { keepPicker: true }).catch(() => undefined);
  }

  private async openAt(index: number, list: ResultsContext): Promise<void> {
    await this.moveSelection(index);
    const item = list.view.items[index];
    const openedAt = Date.now();
    await this.enterUntil('opening the title', (s) => classify(s) !== 'results' || !parseResults(s)?.listFocused);
    const d = await this.session.waitFor('the title’s details', (s) => {
      const x = parseDetails(s);
      return x?.title ? x : null;
    }, 25000);
    const year = item?.year;
    const provider = providerId(item?.provider ?? this.source);
    // MovieBox writes details at once; slower sources later (picked up by buildView).
    const info = await this.waitForInfo(d.title, { year, provider, newerThan: openedAt - 1000 }, provider === 'moviebox' ? 4000 : 1500);
    this.details = { listKey: list.key, index, title: d.title, provider, year, baseInfo: info, info, audioIndex: null, current: null, captions: [] };
  }

  /**
   * Titles with several audio tracks open with "Choose an audio track"; pick
   * the original so Play works at once (other tracks stay one click away).
   */
  /** A title with several audio tracks shows no streams until one is chosen: take Original, else English. */
  private async preferOriginalAudio(): Promise<void> {
    const d = parseDetails(this.s);
    if (!d || this.streamsStatus(d).status !== 'choose-audio') return;
    const audio = d.panes.find((p) => p.name === 'Audio');
    const rows = audio ? this.rowsOf(audio).map((r) => r.text.trim()) : [];
    let index = rows.findIndex((t) => /^original/i.test(t));
    if (index < 0) index = rows.findIndex((t) => /^english$/i.test(t));
    if (index < 0) return; // the person chooses
    const before = this.streamsSignature(this.s);
    await this.applyAudio(index);
    await this.settleStreams(before);
  }

  private async applyAudio(index: number): Promise<void> {
    const ctx = this.details!;
    await this.focusPane('Audio');
    await this.moveInPane('Audio', index, (text) => {
      const rows = this.rowsOf(this.pane('Audio')!);
      const i = rows.findIndex((r) => r.text === text);
      return i >= 0 ? i : null;
    });
    await this.key('enter');
    ctx.audioIndex = index;
    ctx.current = null;
    const subjectId = ctx.baseInfo?.audio[index]?.subjectId;
    if (subjectId) ctx.info = (await this.waitForInfo(ctx.title, { subjectId, provider: ctx.provider }, 10000)) ?? ctx.baseInfo;
  }

  private async applySeason(season: number): Promise<void> {
    const list = this.seasonList();
    await this.focusPane('Seasons');
    await this.moveInPane('Seasons', list.indexOf(season), (text) => {
      const n = Number(/(\d+)/.exec(text)?.[1] ?? NaN);
      const i = list.indexOf(n);
      return i >= 0 ? i : null;
    });
    await this.key('enter');
  }

  private async applyEpisode(episode: number): Promise<void> {
    const ctx = this.details!;
    const season = this.highlightedNumber('Seasons') ?? ctx.current?.season ?? 1;
    const list = ctx.info?.seasons.find((s) => s.season === season)?.episodes.map((e) => e.episode) ?? [];
    const pos = (n: number) => (list.length ? list.indexOf(n) : n - 1);
    await this.focusPane('Episodes');
    await this.moveInPane('Episodes', pos(episode), (text) => {
      const n = Number(/(\d+)/.exec(text)?.[1] ?? NaN);
      const i = pos(n);
      return Number.isNaN(n) || i < 0 ? null : i;
    });
    await this.key('enter');
    ctx.current = { season, episode };
  }

  // ── Public operations ────────────────────────────────────────────────────

  /** True if the TUI is still showing this context's result list. */
  private showsList(ctx: ResultsContext): boolean {
    const s = this.s;
    if (classify(s) !== 'results') return false;
    const r = parseResults(s);
    return Boolean(r && inputMatches(r.input.text, ctx.label) && r.total === ctx.view.total);
  }

  /**
   * Searches through the TUI. MovieBox matches words literally, so when nothing
   * comes back the query is relaxed (season numbers, years, the last word) and
   * the view says which query actually matched.
   */
  search(query: string, opts: { relax?: boolean } = {}): Promise<ResultsView> {
    this.suggestSeq++; // a real search supersedes queued search-as-you-type requests
    return this.run(`Searching for “${query}”`, async () => {
      const current = this.results;
      if (current?.source === 'search' && current.label === query && this.showsList(current)) return current.view;
      await this.submit(query);
      const view = await this.loadList('search', query);
      if (view.items.length || opts.relax === false) return view;
      for (const alt of relaxQuery(query)) {
        await this.submit(alt);
        const relaxed = await this.loadList('search', alt);
        if (relaxed.items.length) {
          relaxed.requested = query;
          return relaxed;
        }
      }
      return view;
    });
  }

  private suggestSeq = 0;

  /**
   * Search-as-you-type: only the newest request runs; older ones that are
   * still queued resolve to null without touching the engine.
   */
  searchLatest(query: string): Promise<ResultsView | null> {
    const seq = ++this.suggestSeq;
    return this.run(`Searching for “${query}”`, async () => {
      if (seq !== this.suggestSeq) return null;
      const current = this.results;
      if (current?.source === 'search' && current.label === query && this.showsList(current)) return current.view;
      await this.submit(query);
      return this.loadList('search', query);
    });
  }

  browseCategories(): Promise<BrowseCategory[]> {
    const known = this.source ? this.categoriesBySource.get(this.source) : undefined;
    if (known) return Promise.resolve(known);
    return this.run('Loading categories', async () => {
      await this.toSearchInput();
      const source = this.source ?? 'unknown';
      const cached = this.categoriesBySource.get(source);
      if (cached) return cached;
      await this.submit('/browse');
      // Sources without Discover lists answer with a status line instead of the menu.
      const s = await this.session
        .waitFor('the browse menu', (x) => (classify(x) === 'browse' || /only with|not available/i.test(parseInput(x)?.text ?? '') ? x : null), 8000)
        .catch(() => null);
      const hasMenu = Boolean(s && classify(s) === 'browse');
      // Neither the menu nor "browse is only available with…": don't remember an empty answer, ask again next time.
      if (!s) throw new Error('The engine didn’t open its Discover menu.');
      let cats: BrowseCategory[] = [];
      if (hasMenu) {
        // The first redraw can hold only part of the menu: wait for all N rows of "Browse · i/N".
        const complete = await this.session
          .waitFor('the whole browse menu', (x) => {
            const n = Number(/╭ Browse · \d+\/(\d+)/.exec(x.text())?.[1] ?? 0);
            const rows = this.parseBrowseMenu(x);
            return n > 0 && rows.length >= n ? rows : null;
          }, 3000)
          .catch(() => null);
        cats = complete ?? this.parseBrowseMenu(this.s);
      }
      if (hasMenu) await this.key('esc');
      this.categoriesBySource.set(source, cats);
      return cats;
    });
  }

  private parseBrowseMenu(s: Screen): BrowseCategory[] {
    // The menu floats over the home screen, so read only inside its own columns.
    const cats: BrowseCategory[] = [];
    const top = s.grid.findIndex((row) => row.includes('╭ Browse · '));
    if (top < 0) return cats;
    const x0 = s.grid[top].indexOf('╭ Browse · ');
    const x1 = s.grid[top].indexOf('╮', x0);
    for (let y = top + 1; y < s.rows; y++) {
      const cell = s.slice(y, x0, x1 + 1);
      if (cell.startsWith('╰')) break;
      const m = /^│\s*\[([^\]]+)\]\s+(.+?)\s*│$/.exec(cell);
      if (m) cats.push({ index: cats.length, group: m[1], label: m[2] });
    }
    return cats;
  }

  private async openBrowseCategory(index: number): Promise<string> {
    await this.submit('/browse');
    await this.session.waitFor('the browse menu', (x) => classify(x) === 'browse', 8000);
    const menuPos = () => {
      const m = /╭ Browse · (\d+)\/(\d+)/.exec(this.s.text());
      return m ? Number(m[1]) - 1 : null;
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const at = menuPos();
      if (at === null) break;
      const diff = index - at;
      if (diff === 0) break;
      await this.pressAndWatch(diff > 0 ? 'down' : 'up', Math.abs(diff), menuPos);
    }
    const cats = this.parseBrowseMenu(this.s);
    if (this.source) this.categoriesBySource.set(this.source, cats);
    await this.key('enter');
    return cats[index]?.label ?? 'Browse';
  }

  browse(index: number): Promise<ResultsView> {
    return this.run('Loading category', async () => {
      const label = await this.openBrowseCategory(index);
      return this.loadList('browse', label, index);
    });
  }

  /** Opens item `index` of the list `key` (the list the GUI shows; defaults to the TUI's current one). */
  open(index: number, key?: string): Promise<DetailsView> {
    const list = (key && this.lists.get(key)) || this.results;
    const title = list?.view.items[index]?.title ?? 'title';
    return this.run(`Opening ${title}`, async () => {
      if (!list) throw new Error('Search for something first.');
      await this.ensureResults(list);
      await this.openAt(index, list);
      if (this.streamsStatus(this.detailsScreen()).status === 'loading') await this.settleStreams('');
      await this.preferOriginalAudio();
      this.watchDetails();
      return this.buildView();
    });
  }

  /**
   * Finds a title on the active source and opens it, as one engine operation
   * (used for history, favorites, suggestions and IMDb lists).
   */
  openTitle(ref: { title: string; year?: string; subjectId?: string }): Promise<{ results: ResultsView; details: DetailsView | null }> {
    this.suggestSeq++;
    return this.run(`Opening ${ref.title}`, async () => {
      const queries = [ref.title, ...relaxQuery(ref.title)];
      let list: ResultsContext | null = null;
      let index = -1;
      for (const q of queries) {
        const current = this.results;
        if (current?.source === 'search' && current.label === q && this.showsList(current)) list = current;
        else {
          await this.submit(q);
          await this.loadList('search', q);
          list = this.results;
        }
        index = list ? matchTitle(list.view.items, ref) : -1;
        if (index >= 0) break;
      }
      if (!list || index < 0) return { results: list?.view ?? emptyView(ref.title, this.source), details: null };
      await this.ensureResults(list);
      await this.openAt(index, list);
      if (this.streamsStatus(this.detailsScreen()).status === 'loading') await this.settleStreams('');
      await this.preferOriginalAudio();
      this.watchDetails();
      return { results: list.view, details: this.buildView() };
    });
  }

  /** Current details as the TUI shows them right now (no navigation). */
  peekDetails(): DetailsView | null {
    try {
      return this.details && parseDetails(this.s)?.title === this.details.title ? this.buildView() : null;
    } catch {
      return null;
    }
  }

  selectAudio(index: number): Promise<DetailsView> {
    return this.run('Switching audio track', async () => {
      await this.ensureDetails();
      const before = this.streamsSignature(this.s);
      await this.applyAudio(index);
      await this.settleStreams(before);
      this.watchDetails();
      return this.buildView();
    });
  }

  selectSeason(season: number): Promise<DetailsView> {
    return this.run(`Loading season ${season}`, async () => {
      await this.ensureDetails();
      const before = this.streamsSignature(this.s);
      await this.applySeason(season);
      await this.settleStreams(before);
      this.watchDetails();
      return this.buildView();
    });
  }

  selectEpisode(season: number, episode: number): Promise<DetailsView> {
    return this.run(`Loading S${season}E${episode}`, async () => {
      await this.ensureDetails();
      const before = this.streamsSignature(this.s);
      if (this.highlightedNumber('Seasons') !== season && this.pane('Seasons')) await this.applySeason(season);
      await this.applyEpisode(episode);
      await this.settleStreams(before);
      this.watchDetails();
      return this.buildView();
    });
  }

  play(streamIndex: number): Promise<DetailsView> {
    return this.run('Starting playback', async () => {
      await this.ensureDetails();
      await this.streamsReady();
      await this.focusPane('Streams');
      await this.moveStream(streamIndex);
      const started = Date.now();
      await this.pressPlay();
      this.collectCaptions(started);
      return this.buildView();
    });
  }

  /** The TUI fetches subtitles while launching the player; pick them up once written. */
  private collectCaptions(since: number) {
    const ctx = this.details;
    for (const delay of [2500, 6000]) {
      setTimeout(() => {
        if (this.details !== ctx || !ctx) return;
        const captions = this.cache.captionsSince(since - 1000);
        if (captions && captions.length !== ctx.captions.length) {
          ctx.captions = captions;
          const view = this.peekDetails();
          if (view) this.emit('details', view);
        }
      }, delay);
    }
  }

  download(scope: DownloadScope, target: number): Promise<DetailsView> {
    return this.run('Starting download', async () => {
      await this.ensureDetails();
      if (scope === 'stream') {
        await this.streamsReady();
        await this.focusPane('Streams');
        await this.moveStream(target);
      } else if (scope === 'episode') {
        await this.applyEpisodeHighlightOnly(target);
      } else {
        const list = this.seasonList();
        await this.focusPane('Seasons');
        await this.moveInPane('Seasons', list.indexOf(target), (text) => {
          const i = list.indexOf(Number(/(\d+)/.exec(text)?.[1] ?? NaN));
          return i >= 0 ? i : null;
        });
      }
      this.pickerPurpose = 'download';
      const panelBefore = parseDownloadPanel(this.s)?.length ?? 0;
      await this.key('d');
      // MovieBox looks up subtitles first and asks which to save with the video (not for whole seasons).
      if (scope !== 'season') {
        const s = await this.session
          .waitFor('the download to start', (x) => (parseSubtitlePicker(x) || (parseDownloadPanel(x)?.length ?? 0) > panelBefore ? x : null), 15000)
          .catch(() => null);
        if (s && parseSubtitlePicker(s)) await this.answerPicker();
      }
      await sleep(500);
      return this.buildView();
    });
  }

  private async applyEpisodeHighlightOnly(episode: number) {
    const ctx = this.details!;
    const season = this.highlightedNumber('Seasons') ?? ctx.current?.season ?? 1;
    const list = ctx.info?.seasons.find((s) => s.season === season)?.episodes.map((e) => e.episode) ?? [];
    const pos = (n: number) => (list.length ? list.indexOf(n) : n - 1);
    await this.focusPane('Episodes');
    await this.moveInPane('Episodes', pos(episode), (text) => {
      const n = Number(/(\d+)/.exec(text)?.[1] ?? NaN);
      return Number.isNaN(n) ? null : pos(n);
    });
  }

  toggleFavorite(): Promise<DetailsView> {
    return this.run('Updating favorites', async () => {
      await this.ensureDetails();
      const before = this.detailsScreen().favorite;
      await this.key('f');
      await this.session.waitFor('favorite to toggle', (s) => parseDetails(s)?.favorite !== before, 4000).catch(() => undefined);
      return this.buildView();
    });
  }

  cancelDownloads(): Promise<void> {
    return this.run('Cancelling downloads', async () => {
      const kind = classify(this.s);
      const listFocused = kind === 'results' && parseResults(this.s)?.listFocused;
      if (kind !== 'details' && !listFocused) {
        throw new Error('Downloads can be cancelled while a title or result list is open in the engine.');
      }
      await this.key('x');
    });
  }

  /** Opens the TUI's history list and runs `action` on the matching entry. */
  private async onHistoryEntry(entry: HistoryEntry, action: 'p' | 'delete'): Promise<void> {
    await this.submit('/history');
    const r = await this.waitForList('watch history', 8000);
    const cards = r.total ? await this.collectCards(r) : [];
    const tag = entry.season && entry.episode ? `S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}` : undefined;
    const idx = cards.findIndex((c) => {
      const meta = parseCardMeta(c.meta);
      return c.title === entry.title && (!tag || meta.episodeTag === tag);
    });
    if (idx < 0) throw new Error(`“${entry.title}” is not in the engine’s history list.`);
    this.results = null;
    this.details = null;
    await this.moveSelection(idx);
    if (action === 'p') await this.pressPlay('p');
    else await this.key(action);
  }

  resume(entry: HistoryEntry): Promise<void> {
    return this.run(`Resuming ${entry.title}`, async () => {
      await this.onHistoryEntry(entry, 'p');
    });
  }

  removeFromHistory(entry: HistoryEntry): Promise<void> {
    return this.run('Removing from history', async () => {
      await this.onHistoryEntry(entry, 'delete');
      await sleep(400);
    });
  }

  // ── Live TV ──────────────────────────────────────────────────────────────

  /**
   * Switches the TUI to TV mode and returns to its channel search screen, the
   * only place typing goes into the search box (same rule as streaming).
   */
  private async toTvInput(): Promise<void> {
    for (let i = 0; i < 12; i++) {
      const s = this.s;
      const kind = classify(s);
      const r = parseResults(s);
      const showingList = Boolean(r && (r.cards.length || r.total !== null || r.message));
      if (kind === 'tv' && !showingList) return;
      if (kind === 'home') {
        await this.key('ctrl+t');
        await this.session.waitFor('TV mode', (x) => ['tv', 'tv-playlists'].includes(classify(x)), 6000);
      } else if (kind === 'searching') {
        await this.session.waitFor('search to finish', (x) => classify(x) !== 'searching', 40000);
      } else {
        await this.key('esc'); // channel lists, popups and streaming screens all step back with Esc
      }
    }
    throw new Error('The engine did not switch to Live TV. Open the engine console to see what it is showing.');
  }

  private async submitTv(text: string): Promise<void> {
    await this.toTvInput();
    await this.key('ctrl+u');
    await this.typeQuery(text);
    await this.session.waitFor(`“${text}” in the channel search`, (s) => inputMatches(parseInput(s)?.text, text), 3000);
    await this.key('enter');
  }

  tvAddPlaylist(source: string): Promise<void> {
    return this.run('Adding playlist', async () => {
      this.results = null;
      this.details = null;
      await this.submitTv('/config');
      await this.session.waitFor('the playlist manager', (s) => classify(s) === 'tv-playlists', 6000);
      // `+ Add playlist` is the last row of the manager.
      await this.key('end');
      await this.key('enter');
      await this.session.waitFor('the add-playlist prompt', (s) => s.includes('Add TV Playlist'), 4000);
      await this.session.type(source);
      await this.key('enter');
      await this.session.waitFor('the playlist to load', (s) => !s.includes('Add TV Playlist') && !/[⠁-⣿]/.test(s.text()), 60000);
      await this.key('esc');
    });
  }

  /** Removes playlist `index` (tv_config.json order) in the TUI's manager: its rows are the playlists, then "+ Add". */
  tvRemovePlaylist(index: number): Promise<void> {
    return this.run('Removing playlist', async () => {
      this.results = null;
      this.details = null;
      await this.submitTv('/config');
      await this.session.waitFor('the playlist manager', (s) => classify(s) === 'tv-playlists', 6000);
      await this.key('home');
      if (index > 0) await this.key('down', index);
      await this.key('d');
      await this.session.idle(200, 3000);
      await this.key('esc');
    });
  }

  tvPlay(name: string, group?: string): Promise<void> {
    return this.run(`Tuning to ${name}`, async () => {
      this.results = null;
      this.details = null;
      await this.submitTv(name);
      const r = await this.session.waitFor(
        `channels matching “${name}”`,
        (s) => {
          const x = parseResults(s);
          return x?.listFocused ? x : null;
        },
        20000,
      );
      const cards = r.total ? await this.collectCards(r) : [];
      const shownName = asScreenText(name);
      let idx = cards.findIndex((c) => c.title === shownName && (!group || c.meta[0] === group));
      if (idx < 0) idx = cards.findIndex((c) => c.title === shownName);
      if (idx < 0) throw new Error(`The engine has no channel called “${name}”.`);
      await this.moveSelection(idx);
      await this.pressPlay();
    });
  }

  /** Returns the engine to streaming mode (after Live TV). */
  leaveTv(): Promise<void> {
    return this.run('Leaving Live TV', () => this.toSearchInput());
  }

  private currentProvider(): string | null {
    return providerFromLabel(parseInput(this.s)?.label ?? '');
  }

  /** Presses Ctrl+P until `name` is the active source. The TUI remembers the choice. */
  private async cycleTo(name: string, maxPresses = 10): Promise<boolean> {
    for (let i = 0; i <= maxPresses; i++) {
      if (this.currentProvider()?.toLowerCase() === name.toLowerCase()) return true;
      if (i === maxPresses) break;
      await this.key('ctrl+p');
      await sleep(150);
    }
    return false;
  }

  setProvider(name: string): Promise<string | null> {
    return this.run(`Switching to ${name}`, async () => {
      await this.toSearchInput();
      await this.key('ctrl+u');
      const ok = await this.cycleTo(name);
      this.results = null;
      this.details = null;
      this.source = this.currentProvider();
      if (!ok) throw new Error(`The engine has no source called ${name}.`);
      return this.source;
    });
  }

  private providerList: string[] | null = null;

  /** Settings changed which sources are enabled: read them (and their Discover lists) again. */
  forgetSources(): void {
    this.providerList = null;
    this.categoriesBySource.clear();
  }

  /**
   * Reads the source list by cycling Ctrl+P once around and stopping where it
   * started, so the user's chosen source is left as it was. Cached per session.
   */
  listProviders(): Promise<string[]> {
    if (this.providerList) return Promise.resolve(this.providerList);
    return this.run('Reading sources', async () => {
      await this.toSearchInput();
      await this.key('ctrl+u');
      const start = this.currentProvider();
      if (!start) return [];
      const list = [start];
      for (let i = 0; i < 10; i++) {
        await this.key('ctrl+p');
        await sleep(150);
        const p = this.currentProvider();
        if (p === start) break;
        if (p && !list.includes(p)) list.push(p);
      }
      if (this.currentProvider() !== start) await this.cycleTo(start);
      this.providerList = list;
      return list;
    });
  }
}
