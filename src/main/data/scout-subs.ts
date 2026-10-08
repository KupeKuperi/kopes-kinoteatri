// Automatic subtitles ("Find elsewhere"): a play that starts without subtitles in your language
// gets some from OpenSubtitles.com. The engine starts the video player itself; while this is on,
// its VLC and mpv are the app's stand-ins (phone/bridge.ts), and the subtitle file goes onto that
// command line. Files are kept under the app's own folder (scout-subs), never in Downloads.
//
// OpenSubtitles needs an API key (free with an account) for every request; without signing in it
// allows a few downloads a day, so a search runs when a play starts and the download (the part that
// counts) only once the player is starting without subtitles of its own.
import fs from 'node:fs';
import path from 'node:path';
import { autoSubtitleLanguage, DEFAULT_SCOUT } from '@shared/scout';
import type { GuiSettings, Toast } from '@shared/types';
import type { PlayerLaunch } from '../phone/launch';

const API = 'https://api.opensubtitles.com/api/v1';
const DAY = 24 * 3600 * 1000;
/** A kept file is used again for this long. */
const KEEP = 30 * DAY;
/** How long a starting player waits for the subtitle before it plays without. */
const WAIT_MS = 8000;
/** A request that takes longer than this is given up. */
const REQUEST_MS = 7000;

/** OpenSubtitles' codes for the subtitle setting's languages (comma-separated where it has several). */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en', arabic: 'ar', bengali: 'bn', chinese: 'zh-cn,zh-tw', czech: 'cs', danish: 'da', dutch: 'nl',
  filipino: 'tl', finnish: 'fi', french: 'fr', georgian: 'ka', german: 'de', greek: 'el', hebrew: 'he', hindi: 'hi',
  hungarian: 'hu', indonesian: 'id', italian: 'it', japanese: 'ja', korean: 'ko', malay: 'ms', norwegian: 'no',
  persian: 'fa', polish: 'pl', portuguese: 'pt-br,pt-pt', romanian: 'ro', russian: 'ru', spanish: 'es', swedish: 'sv',
  tamil: 'ta', telugu: 'te', thai: 'th', turkish: 'tr', ukrainian: 'uk', urdu: 'ur', vietnamese: 'vi',
};

/** What is being played. */
export interface PlayRequest {
  title: string;
  year?: string;
  /** `movie` | `series`. */
  kind: string;
  season?: number;
  episode?: number;
  /** Subtitle languages the source itself has for it (when known). */
  sourceLanguages?: string[];
}

interface SubtitleAttributes {
  language?: string;
  download_count?: number;
  from_trusted?: boolean;
  hearing_impaired?: boolean;
  machine_translated?: boolean;
  ai_translated?: boolean;
  files?: Array<{ file_id?: number; file_name?: string }>;
}

/** Why there is no subtitle: none found, the key refused, today's downloads used up, or no answer. */
type Miss = 'none' | 'key' | 'quota' | 'network';
class SubtitleMiss extends Error {
  constructor(readonly reason: Miss) {
    super(reason);
  }
}

type Found = { file: string } | { fileId: number; fileName: string; base: string };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class AutoSubtitles {
  private pending: { at: number; language: string; search: Promise<Found | Miss> } | null = null;

  constructor(
    private readonly dir: string,
    private readonly fetchFn: Fetch,
    private readonly gui: () => GuiSettings,
    /** IMDb id for a title, or null. */
    private readonly imdbId: (title: string, year?: string, kind?: string) => Promise<string | null>,
    private readonly notify: (toast: Omit<Toast, 'id'>) => void,
    private readonly userAgent: string,
  ) {}

  /** The language to fetch, or null while automatic subtitles are off. */
  language(): string | null {
    const gui = this.gui();
    return autoSubtitleLanguage({ ...DEFAULT_SCOUT, ...gui.scout }, gui.subtitles);
  }

  /** On: the engine's players must be the stand-ins. */
  wanted(): boolean {
    return this.language() !== null;
  }

  /** A play is starting: look for subtitles meanwhile (nothing is downloaded yet). */
  prepare(play: PlayRequest | null): void {
    this.pending = null;
    const language = this.language();
    const codes = language && LANGUAGE_CODES[language.toLowerCase()];
    if (!play?.title || !language || !codes) return;
    // The source has that language: the engine loads it (or asks), nothing to add.
    if (play.sourceLanguages?.some((l) => l.toLowerCase().startsWith(language.toLowerCase()))) return;
    const search = this.search(play, codes).catch((e: unknown) => (e instanceof SubtitleMiss ? e.reason : 'network'));
    this.pending = { at: Date.now(), language, search };
  }

  /**
   * The engine is starting its player: the arguments with a subtitle file added, or null to start
   * it as asked (it has the source's subtitles, nothing was looked up, or nothing came in time).
   */
  async attach(launch: PlayerLaunch, args: string[]): Promise<string[] | null> {
    const pending = this.pending;
    this.pending = null;
    // Not for this play (the engine took minutes, or this launch came from elsewhere).
    if (!pending || Date.now() - pending.at > 5 * 60_000) return null;
    if (launch.subFile) return null;
    type Outcome = { file: string } | { miss: Miss };
    const outcome: Promise<Outcome> = pending.search
      .then(async (found): Promise<Outcome> => (typeof found === 'string' ? { miss: found } : { file: 'file' in found ? found.file : await this.download(found) }))
      .catch((e: unknown) => ({ miss: e instanceof SubtitleMiss ? e.reason : 'network' }));
    // Never hold the player up for long: without an answer in time it plays without.
    const result = await Promise.race([outcome, sleep(WAIT_MS).then((): Outcome => ({ miss: 'network' }))]);
    if ('miss' in result) {
      this.tell(result.miss);
      return null;
    }
    this.notify({ kind: 'info', title: 'Subtitles added', message: 'Subtitles from OpenSubtitles load into the player.' });
    // Before the stream, with the player's other options (VLC and mpv both read --sub-file=).
    const at = args.findIndex((a) => !a.startsWith('-'));
    const option = `--sub-file=${result.file}`;
    return at < 0 ? [...args, option] : [...args.slice(0, at), option, ...args.slice(at)];
  }

  /** Files kept, and their size. */
  cacheInfo(): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    for (const name of this.cached()) {
      files++;
      bytes += fs.statSync(path.join(this.dir, name)).size;
    }
    return { files, bytes };
  }

  clearCache(): { files: number; bytes: number } {
    for (const name of this.cached()) fs.rmSync(path.join(this.dir, name), { force: true });
    return this.cacheInfo();
  }

  // ── OpenSubtitles ─────────────────────────────────────────────────────────

  private cached(): string[] {
    try {
      return fs.readdirSync(this.dir).filter((n) => /\.(srt|vtt|ass|ssa|sub)$/i.test(n));
    } catch {
      return [];
    }
  }

  private headers(): Record<string, string> {
    const key = this.gui().scout?.openSubtitlesKey.trim() ?? '';
    return { 'Api-Key': key, 'User-Agent': this.userAgent, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, headers: this.headers(), signal: AbortSignal.timeout(REQUEST_MS) });
    } catch {
      throw new SubtitleMiss('network');
    }
    if (res.status === 401 || res.status === 403) throw new SubtitleMiss('key');
    if (res.status === 406 || res.status === 429) throw new SubtitleMiss('quota');
    if (!res.ok) throw new SubtitleMiss('network');
    return res;
  }

  private async search(play: PlayRequest, codes: string): Promise<Found> {
    const imdb = await this.imdbId(play.title, play.year, play.kind).catch(() => null);
    const series = /series|tv/i.test(play.kind);
    const episode = series && play.season && play.episode ? play : null;
    const name = imdb ?? `${slug(play.title)}-${play.year ?? ''}`;
    const base = `${name}${episode ? `-s${episode.season}e${episode.episode}` : ''}.${codes.replace(/,/g, '+')}`;
    const kept = this.cached().find((n) => n.startsWith(`${base}.`));
    if (kept && Date.now() - fs.statSync(path.join(this.dir, kept)).mtimeMs < KEEP) return { file: path.join(this.dir, kept) };

    // OpenSubtitles wants the parameters sorted, in lowercase (it redirects otherwise).
    const params: Record<string, string> = { languages: codes };
    const number = imdb ? String(Number(imdb.slice(2))) : null;
    if (episode && number) Object.assign(params, { parent_imdb_id: number, season_number: String(episode.season), episode_number: String(episode.episode) });
    else if (number) params.imdb_id = number;
    else {
      params.query = play.title.toLowerCase();
      if (play.year) params.year = play.year;
      if (episode) Object.assign(params, { type: 'episode', season_number: String(episode.season), episode_number: String(episode.episode) });
      else params.type = series ? 'episode' : 'movie';
    }
    const query = Object.keys(params)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(params[k]).replace(/%2C/g, ',')}`)
      .join('&');
    const res = await this.request(`${API}/subtitles?${query}`);
    const { data } = (await res.json()) as { data?: Array<{ attributes?: SubtitleAttributes }> };
    const wanted = codes.split(',');
    // People's subtitles before machine translations, trusted uploaders first, then the most downloaded.
    const rank = (a: SubtitleAttributes) => [a.machine_translated || a.ai_translated ? 0 : 1, a.from_trusted ? 1 : 0, a.hearing_impaired ? 0 : 1, a.download_count ?? 0];
    const best = (data ?? [])
      .map((d) => d.attributes ?? {})
      .filter((a) => wanted.includes((a.language ?? '').toLowerCase()) && a.files?.[0]?.file_id)
      .sort((a, b) => compare(rank(b), rank(a)))[0];
    if (!best) throw new SubtitleMiss('none');
    const file = best.files![0];
    return { fileId: file.file_id!, fileName: file.file_name ?? '', base };
  }

  /** Downloads a found subtitle into the folder (this is what counts against the daily limit). */
  private async download(found: { fileId: number; fileName: string; base: string }): Promise<string> {
    const res = await this.request(`${API}/download`, { method: 'POST', body: JSON.stringify({ file_id: found.fileId }) });
    const { link, remaining } = (await res.json()) as { link?: string; remaining?: number };
    if (!link) throw new SubtitleMiss(remaining !== undefined && remaining <= 0 ? 'quota' : 'none');
    let text: string;
    try {
      const file = await this.fetchFn(link, { signal: AbortSignal.timeout(REQUEST_MS) });
      if (!file.ok) throw new Error(String(file.status));
      text = await file.text();
    } catch {
      throw new SubtitleMiss('network');
    }
    if (!text.trim()) throw new SubtitleMiss('none');
    const ext = /\.(srt|vtt|ass|ssa|sub)$/i.exec(found.fileName)?.[0].toLowerCase() ?? '.srt';
    fs.mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, `${found.base}${ext}`);
    fs.writeFileSync(target, text);
    return target;
  }

  private tell(reason: Miss) {
    const message: Record<Miss, string> = {
      none: "OpenSubtitles has none in your language for this title. Find subtitles on the title's page lists other sites.",
      key: 'OpenSubtitles refused the API key. Check it in Settings → Find elsewhere.',
      quota: "Today's OpenSubtitles downloads are used up. There are more tomorrow.",
      network: "OpenSubtitles didn't answer in time. The video plays without subtitles.",
    };
    this.notify({ kind: 'warning', title: 'No subtitles added', message: message[reason] });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'title';

/** Score tuples, position by position. */
function compare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
