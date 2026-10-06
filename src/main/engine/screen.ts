// Immutable snapshot of the TUI's terminal plus the parsers that turn its
// screens into structured data. Every parser here is tied to moviebox-tui's
// layout (verified against v0.1.26); keep them defensive.
import type { Terminal } from '@xterm/headless';
import type { ActiveDownload, PaneName, Toast } from '@shared/types';

/** Placeholder for the trailing cell of a wide (CJK, emoji) character. */
const WIDE_TAIL = '\u0000';

export class Screen {
  /** One string per row, exactly one UTF-16 unit per cell (wide-char tails = WIDE_TAIL). */
  readonly grid: string[];
  /** Per-row bitmap: 1 where a non-blank cell has a non-default background. */
  readonly bg: Uint8Array[];
  readonly cols: number;
  readonly rows: number;

  constructor(term: Terminal) {
    const buf = term.buffer.active;
    const cell = buf.getNullCell();
    this.cols = term.cols;
    this.rows = term.rows;
    this.grid = [];
    this.bg = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      let row = '';
      const bg = new Uint8Array(term.cols);
      for (let x = 0; x < term.cols; x++) {
        if (!line) { row += ' '; continue; }
        line.getCell(x, cell);
        const chars = cell.getChars();
        const w = cell.getWidth();
        // Astral characters (emoji) are two UTF-16 units; collapse to one unit so indices stay cell-aligned.
        row += w === 0 ? WIDE_TAIL : chars ? (chars.length > 1 ? '□' : chars) : ' ';
        if (chars.trim() && !cell.isBgDefault()) bg[x] = 1;
      }
      this.grid.push(row);
      this.bg.push(bg);
    }
  }

  /** Display text for a row (wide-char placeholders removed). */
  line(y: number): string {
    return (this.grid[y] ?? '').replaceAll(WIDE_TAIL, '');
  }

  slice(y: number, x0: number, x1: number): string {
    return (this.grid[y] ?? '').slice(x0, x1).replaceAll(WIDE_TAIL, '');
  }

  hasBg(y: number, x0: number, x1: number): boolean {
    const row = this.bg[y];
    if (!row) return false;
    for (let x = Math.max(0, x0); x < Math.min(x1, row.length); x++) if (row[x]) return true;
    return false;
  }

  text(): string {
    return this.grid.map((_, y) => this.line(y).trimEnd()).join('\n');
  }

  includes(s: string): boolean {
    return this.grid.some((row) => row.includes(s));
  }
}

// ── Classification ─────────────────────────────────────────────────────────

export type ScreenKind =
  | 'help'
  | 'settings'
  | 'browse'
  | 'tv-playlists'
  | 'tv'
  | 'home'
  | 'searching'
  | 'details'
  | 'results'
  | 'unknown';

const PANE_TITLE = /╭ (› )?(Audio|Seasons|Episodes|Streams)\b(?: \((\d+)\))?(?: · (\d+)\/(\d+))?/g;

export function classify(s: Screen): ScreenKind {
  const t = s.text();
  if (/╭ Help · /.test(t)) return 'help';
  if (t.includes('╭ Settings & Preferences')) return 'settings';
  if (/╭ Browse · \d+\/\d+/.test(t)) return 'browse';
  if (t.includes('╭ TV Playlists')) return 'tv-playlists';
  if (t.includes('[Ctrl+S] Stream')) return 'tv';
  if (t.includes('Discover Categories')) return 'home';
  if (/Searching for “/.test(t)) return 'searching';
  if (/╭ (› )?(Audio|Seasons|Episodes|Streams)\b/.test(t)) return 'details';
  if (/^\s*❯ /m.test(t)) return 'results';
  // While the box holds text a suggestion list covers the Discover panel; the boxed prompt under the logo is still home.
  if (/│ ❯ /.test(t) && /\bv\d+\.\d+\.\d+\b/.test(t)) return 'home';
  return 'unknown';
}

/** Spinner line (`⠴  Loading streams...`) if the TUI is busy. */
export function spinnerText(s: Screen): string | null {
  for (let y = 0; y < s.rows; y++) {
    const m = /[⠁-⣿]\s+(.+?)\s*(?:│|$)/.exec(s.line(y));
    if (m) return m[1].trim();
  }
  return null;
}

// ── Home / input line ──────────────────────────────────────────────────────

export interface InputLine {
  y: number;
  /** Text after the `❯ ` prompt, without the right-hand label. */
  text: string;
  /** Right-hand label: `Item 2 of 6`, `3 results`, `[MovieBox · Ctrl+P]`, … */
  label: string;
}

export function parseInput(s: Screen): InputLine | null {
  for (let y = 0; y < s.rows; y++) {
    const line = s.line(y);
    const i = line.indexOf('❯ ');
    if (i < 0) continue;
    const rest = line.slice(i + 2).replace(/│\s*$/, '').trimEnd();
    const parts = rest.split(/\s{3,}/);
    const label = parts.length > 1 ? parts[parts.length - 1].trim() : '';
    const text = (parts.length > 1 ? parts.slice(0, -1).join('   ') : rest).trim();
    return { y, text, label };
  }
  return null;
}

/** `[MovieBox · Ctrl+P]` → `MovieBox`; the addons source shows a bare `[Addons]`. */
export function providerFromLabel(label: string): string | null {
  const m = /^\[([^\]·]+?)\s*(?:·\s*Ctrl\+P\s*)?\]$/.exec(label.trim());
  return m ? m[1].trim() : null;
}

// ── Result lists (search, browse, history, favorites) ──────────────────────

export interface Card {
  y: number;
  title: string;
  meta: string[];
  /** Right-aligned extras on the title row (a channel's quality). */
  badges: string[];
  highlighted: boolean;
}

export interface ResultsScreen {
  input: InputLine;
  /** 0-based index of the selected card, when the list has focus. */
  selected: number | null;
  total: number | null;
  listFocused: boolean;
  cards: Card[];
  message?: string;
}

export function parseResults(s: Screen): ResultsScreen | null {
  const input = parseInput(s);
  if (!input) return null;
  let selected: number | null = null;
  let total: number | null = null;
  let listFocused = false;
  // `Item 2 of 6`, or for long lists `Item 1 of 73 • Page 1/4`.
  const item = /^Item (\d+) of (\d+)(?:\s*•\s*Page \d+\/\d+)?$/.exec(input.label);
  const count = /^(\d+) results?$/.exec(input.label);
  if (item) {
    selected = Number(item[1]) - 1;
    total = Number(item[2]);
    listFocused = true;
  } else if (count) {
    total = Number(count[1]);
    listFocused = total > 0;
    if (total === 1) selected = 0;
  }

  const cards: Card[] = [];
  let current: Card | null = null;
  let message: string | undefined;
  for (let y = input.y + 1; y < s.rows; y++) {
    // Long lists draw a scrollbar (▲ █ │ ▼) in the last column; it is not card text.
    const raw = s.line(y).replace(/\s+[▲▼█│║▐▌░▒▓■┃]\s*$/, '');
    const content = raw.trim();
    if (!content) continue;
    if (/^No results for /.test(content) || /^No (favorites|history)/i.test(content)) {
      message = content;
      continue;
    }
    if (content.startsWith('[ ') || content.startsWith('╭') || content.startsWith('│') || content.startsWith('╰')) continue;
    if (!/^ {3}\S/.test(raw)) continue;
    if (!current) {
      // Live TV cards end their title row with a right-aligned quality badge: "1TV (720p)      720p".
      const [title, ...badges] = content.split(/\s{3,}/);
      current = { y, title, meta: [], badges, highlighted: s.hasBg(y, 0, s.cols - 4) };
      continue;
    }
    current.meta.push(...content.split(/\s{2,}/));
    // A card ends with its provider tag (`[MovieBox]`) or, for live TV, `TV Channel`.
    if (/\[[^\]]+\]$/.test(content) || /\sTV Channel$/.test(content)) {
      cards.push(current);
      current = null;
    }
  }
  if (current) cards.push(current);
  return { input, selected, total, listFocused, cards, message };
}

export interface CardMeta {
  rating?: string;
  year?: string;
  type?: string;
  episodeTag?: string;
  provider?: string;
}

export function parseCardMeta(meta: string[]): CardMeta {
  const out: CardMeta = {};
  for (const token of meta) {
    const t = token.trim();
    let m: RegExpExecArray | null;
    if ((m = /^★\s*([\d.]+)$/.exec(t))) out.rating = m[1];
    else if (/^\d{4}$/.test(t)) out.year = t;
    else if (/^S\d+E\d+$/i.test(t)) out.episodeTag = t.toUpperCase();
    else if ((m = /^\[([^\]]+)\]$/.exec(t))) out.provider = m[1];
    else if (t && !out.type) out.type = t;
  }
  return out;
}

// ── Details screen ─────────────────────────────────────────────────────────

export interface PaneRow {
  text: string;
  /** Untrimmed text between the pane borders (keeps table columns aligned). */
  raw: string;
  highlighted: boolean;
}

export interface Pane {
  name: PaneName;
  focused: boolean;
  count: number | null;
  /** Streams pane only: `· 2/3` → pos 1 (0-based), total 3. */
  pos: number | null;
  total: number | null;
  rows: PaneRow[];
  x0: number;
  x1: number;
}

export interface DetailsScreen {
  title: string;
  meta: string;
  description: string;
  panes: Pane[];
  footer: string;
  favorite: boolean;
}

function findBoxEnd(s: Screen, y0: number, x0: number): number {
  for (let y = y0 + 1; y < s.rows; y++) if (s.grid[y][x0] === '╰') return y;
  return s.rows;
}

export function parseDetails(s: Screen): DetailsScreen | null {
  if (classify(s) !== 'details') return null;

  // Header box: the poster frame `╭──────────╮` sits inside the first box.
  let title = '';
  let meta = '';
  const desc: string[] = [];
  for (let y = 0; y < s.rows; y++) {
    const row = s.grid[y];
    const px = row.indexOf('╭──────────╮');
    if (px < 0) continue;
    const textX = px + '╭──────────╮'.length;
    const end = findBoxEnd(s, y, px);
    const outerRight = (r: number) => {
      const i = s.grid[r].lastIndexOf('│');
      return i > textX ? i : s.cols;
    };
    for (let r = y; r <= end && r < s.rows; r++) {
      const text = s.slice(r, textX, outerRight(r)).trim();
      if (r === y) title = text;
      else if (r === y + 1) meta = text;
      else if (text) desc.push(text);
    }
    break;
  }

  const panes: Pane[] = [];
  for (let y = 0; y < s.rows; y++) {
    const row = s.grid[y];
    PANE_TITLE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PANE_TITLE.exec(row))) {
      const x0 = m.index;
      const x1 = row.indexOf('╮', x0);
      if (x1 < 0) continue;
      const yEnd = findBoxEnd(s, y, x0);
      const rows: PaneRow[] = [];
      for (let r = y + 1; r < yEnd; r++) {
        const raw = s.slice(r, x0 + 1, x1);
        rows.push({ text: raw.trim(), raw, highlighted: s.hasBg(r, x0 + 1, x1) });
      }
      while (rows.length && !rows[rows.length - 1].text) rows.pop();
      panes.push({
        name: m[2] as PaneName,
        focused: Boolean(m[1]),
        count: m[3] ? Number(m[3]) : null,
        pos: m[4] ? Number(m[4]) - 1 : null,
        total: m[5] ? Number(m[5]) : null,
        rows,
        x0,
        x1,
      });
    }
  }

  let footer = '';
  for (let y = s.rows - 1; y >= 0; y--) {
    const line = s.line(y).trim();
    if (/\[Enter\]|\[Tab\]|\[f\]/.test(line)) { footer = line; break; }
  }
  return { title, meta, description: desc.join(' '), panes, footer, favorite: /\[f\] Unfavorite/.test(footer) };
}

export interface ParsedStreamRow {
  resolution: string;
  size?: string;
  tags?: string;
  source?: string;
  release?: string;
}

/** Splits the Streams pane table using its header row's column positions. */
export function parseStreamRows(pane: Pane): { rows: ParsedStreamRow[]; message?: string } {
  const headerIdx = pane.rows.findIndex((r) => /^RES\s+SIZE/.test(r.text));
  if (headerIdx < 0) {
    const message = pane.rows.map((r) => r.text).find((t) => t && !/^[│\s]*$/.test(t));
    return { rows: [], message: message?.replace(/^[⠁-⣿]\s*/, '') };
  }
  const header = pane.rows[headerIdx].raw;
  const cols = ['RES', 'SIZE', 'MEDIA TAGS', 'SOURCE', 'RELEASE']
    .map((name) => ({ name, at: header.indexOf(name) }))
    .filter((c) => c.at >= 0)
    .sort((a, b) => a.at - b.at);
  const rows: ParsedStreamRow[] = [];
  for (const r of pane.rows.slice(headerIdx + 1)) {
    if (!r.text) continue;
    // Data cells share the header's columns; the RES cell carries a 1-char selection gutter.
    const get = (i: number) => r.raw.slice(i === 0 ? 0 : cols[i].at, i + 1 < cols.length ? cols[i + 1].at : undefined).trim();
    const row: ParsedStreamRow = { resolution: '' };
    cols.forEach((c, i) => {
      const v = get(i);
      if (c.name === 'RES') row.resolution = v;
      if (c.name === 'SIZE') row.size = v || undefined;
      if (c.name === 'MEDIA TAGS') row.tags = v || undefined;
      if (c.name === 'SOURCE') row.source = v || undefined;
      if (c.name === 'RELEASE') row.release = v || undefined;
    });
    if (row.resolution) rows.push(row);
  }
  return { rows };
}

// ── Overlays: toasts and the download panel ────────────────────────────────

const TOAST = /╭ (✔|ℹ|✖|⚠) (SUCCESS|INFO|ERROR|WARNING) /;

// ── Subtitle chooser ────────────────────────────────────────────────────────

export interface SubtitlePicker {
  /** Option labels in the box: all of them, or a window of 14 when the list is longer. */
  rows: string[];
  /** 0-based position of the highlighted option, and how many options there are. */
  selected: number;
  total: number;
}

/** The TUI's "Subtitles · 2/5" chooser, shown before it plays or downloads a title that has captions. */
export function parseSubtitlePicker(s: Screen): SubtitlePicker | null {
  const top = s.grid.findIndex((row) => row.includes('╭ Subtitles · '));
  if (top < 0) return null;
  const m = /╭ Subtitles · (\d+)\/(\d+)/.exec(s.grid[top]);
  const x0 = s.grid[top].indexOf('╭ Subtitles · ');
  const x1 = s.grid[top].indexOf('╮', x0);
  if (!m || x1 < 0) return null;
  const rows: string[] = [];
  for (let y = top + 1; y < s.rows; y++) {
    const cell = s.slice(y, x0, x1 + 1);
    if (cell.startsWith('╰')) break;
    const r = /^│(.*)│$/.exec(cell);
    if (r && r[1].trim()) rows.push(r[1].trim());
  }
  return { rows, selected: Number(m[1]) - 1, total: Number(m[2]) };
}

export function parseToasts(s: Screen): Array<Omit<Toast, 'id'>> {
  const out: Array<Omit<Toast, 'id'>> = [];
  for (let y = 0; y < s.rows; y++) {
    const m = TOAST.exec(s.grid[y]);
    if (!m) continue;
    const x0 = m.index;
    const x1 = s.grid[y].indexOf('╮', x0);
    const yEnd = findBoxEnd(s, y, x0);
    const lines: string[] = [];
    for (let r = y + 1; r < yEnd; r++) {
      const t = s.slice(r, x0 + 1, x1 > 0 ? x1 : s.cols).replace(/│/g, '').trim();
      if (t) lines.push(t);
    }
    const kind = ({ SUCCESS: 'success', INFO: 'info', ERROR: 'error', WARNING: 'warning' } as const)[m[2] as 'SUCCESS'];
    out.push({ kind, title: lines[0] ?? m[2], message: lines.slice(1).join(' ') });
  }
  return out;
}

export function parseDownloadPanel(s: Screen): ActiveDownload[] | null {
  for (let y = 0; y < s.rows; y++) {
    const x0 = s.grid[y].indexOf('╭ ⬇ ');
    if (x0 < 0) continue;
    const yEnd = findBoxEnd(s, y, x0);
    const items: ActiveDownload[] = [];
    let label = s.line(y).replace(/^.*╭ ⬇\s*/, '').replace(/[─╮]|\[x\] Cancel/g, '').trim();
    for (let r = y + 1; r < yEnd; r++) {
      const t = s.line(r).replace(/│/g, '').trim();
      if (!t) continue;
      const m = /^(.*?)\s*(\d+(?:\.\d+)?)%\s*\[[^\]]*\]\s*(.*)$/.exec(t);
      if (m) items.push({ label: m[1] || label, percent: Number(m[2]), status: m[3], finished: /complete/i.test(m[3]) });
      else label = t;
    }
    return items;
  }
  return null;
}
