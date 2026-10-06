// The phone's half of a play. The engine resolves the stream and starts its "player" (the
// stand-in in bridge.ts); when a phone asked for that play, the stream is relayed to the phone in
// a form Safari plays: HLS playlists written from a DASH manifest, an HLS stream with its links
// pointed back here, or the video file itself (with seeking). Every request goes to the URL the
// engine gave its player, with the headers it gave it; for most sources that is the engine's own
// relay on 127.0.0.1, which adds what the source needs. Nothing here finds or unlocks streams.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { Readable } from 'node:stream';
import type { PhoneSession } from '@shared/types';
import type { LaunchDecision } from './bridge';
import { languageTag, masterPlaylist, mediaPlaylist, parseMpd, subtitlePlaylist, type DashManifest, type HlsPaths, type Rendition } from './dash';
import type { PlayerLaunch } from './launch';
import { codecString, hvc1 } from './mp4';
import { readSubtitles } from './subs';

type Kind = 'dash' | 'hls' | 'file';

interface Session {
  id: string;
  view: PhoneSession;
  launch: PlayerLaunch;
  kind: Kind;
  dash?: Promise<DashManifest>;
  codecs: Map<string, string>;
  inits: Map<string, Promise<Buffer>>;
  /** HLS: the links its playlists were rewritten from (only those are relayed). */
  allowed: Set<string>;
  vtt: string | null;
  /** Last request or word from the phone. */
  seen: number;
  opened: boolean;
  /** Last request to the engine's relay (it quits after 10 idle minutes). */
  upstream: number;
  /** What the subtitle track is called on the phone. */
  subtitleName: string;
  release: () => void;
}

/** No requests and no word from the phone for this long: it has gone, so the engine is let go. */
const IDLE_MS = 15 * 60_000;
/** The phone never opened the stream. */
const UNOPENED_MS = 3 * 60_000;
const KEEPALIVE_MS = 4 * 60_000;

const b64 = (s: string) => Buffer.from(s).toString('base64url');
/** Subtitle setting (an English language name) → language code, for the phone's subtitle menu. */
const LANGUAGE_CODES: Record<string, string> = {
  English: 'en', Georgian: 'ka', Russian: 'ru', Spanish: 'es', French: 'fr', German: 'de', Italian: 'it', Portuguese: 'pt', Turkish: 'tr',
  Ukrainian: 'uk', Arabic: 'ar', Hindi: 'hi', Japanese: 'ja', Korean: 'ko', Chinese: 'zh', Polish: 'pl', Dutch: 'nl', Greek: 'el', Hebrew: 'he',
  Persian: 'fa', Indonesian: 'id', Malay: 'ms', Thai: 'th', Vietnamese: 'vi', Bengali: 'bn', Tamil: 'ta', Telugu: 'te', Urdu: 'ur', Czech: 'cs',
  Danish: 'da', Finnish: 'fi', Hungarian: 'hu', Norwegian: 'no', Romanian: 'ro', Swedish: 'sv', Filipino: 'fil',
};
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString();

export class Relay extends EventEmitter {
  private sessions = new Map<string, Session>();
  private waiting: { device: string; title: string; live: boolean; until: number; ticket: number; subtitles?: string } | null = null;
  private tickets = 0;
  private timer: NodeJS.Timeout | null = null;

  /**
   * A phone asked for a play: the engine's next player launch is that phone's. `subtitles` names
   * the subtitle language the engine is likely to load (the subtitle setting).
   */
  expect(device: string, title: string, live = false, subtitles?: string): number {
    const ticket = ++this.tickets;
    this.waiting = { device, title, live, until: Date.now() + 10 * 60_000, ticket, subtitles };
    return ticket;
  }

  /** That play is over without a launch (it failed, say): stop waiting for it. */
  cancelExpect(ticket: number): void {
    if (this.waiting?.ticket === ticket) this.waiting = null;
  }

  get active(): boolean {
    return this.sessions.size > 0;
  }

  /** From the bridge: each launch of the engine's player. */
  decide = (launch: PlayerLaunch): LaunchDecision => {
    const w = this.waiting;
    if (!w || w.until < Date.now()) return null;
    this.waiting = null;
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    const id = crypto.randomBytes(9).toString('base64url');
    const s: Session = {
      id,
      launch,
      kind: 'file',
      codecs: new Map(),
      inits: new Map(),
      allowed: new Set(),
      vtt: launch.subFile ? readSubtitles(launch.subFile) : null,
      seen: Date.now(),
      opened: false,
      upstream: Date.now(),
      subtitleName: w.subtitles ?? 'Subtitles',
      release,
      view: { id, device: w.device, title: w.title, kind: 'file', src: '', start: launch.start, live: w.live },
    };
    this.sessions.set(id, s);
    this.watch();
    void this.announce(s);
    return { phone: true, done };
  };

  /** Works out what the stream is, then tells the phone where to play it. */
  private async announce(s: Session) {
    s.kind = await this.sniff(s.launch);
    s.view.kind = s.kind === 'file' ? 'file' : 'hls';
    s.view.src = `/watch/${s.id}/${s.kind === 'file' ? 'video' : 'master.m3u8'}`;
    if (s.vtt) s.view.subtitles = `/watch/${s.id}/subs.vtt`;
    if (this.sessions.has(s.id)) this.emit('session', s.view);
  }

  private async sniff(launch: PlayerLaunch): Promise<Kind> {
    const path = new URL(launch.url).pathname.toLowerCase();
    if (path.endsWith('.mpd')) return 'dash';
    if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
    if (/\.(mp4|m4v|mov|mkv|webm|avi|ts)$/.test(path)) return 'file';
    // No telling extension (add-on links often have none): look at the first bytes.
    try {
      const res = await this.fetch(launch, launch.url, { range: 'bytes=0-511' });
      const type = res.headers.get('content-type') ?? '';
      const head = Buffer.from(await res.arrayBuffer()).subarray(0, 512).toString('latin1').trimStart();
      if (/mpegurl/i.test(type) || head.startsWith('#EXTM3U')) return 'hls';
      if (/dash\+xml/i.test(type) || /^(<\?xml[^>]*>\s*)?<MPD/i.test(head)) return 'dash';
    } catch {
      /* the phone will report what fails */
    }
    return 'file';
  }

  private fetch(launch: PlayerLaunch, url: string, opts: { range?: string; signal?: AbortSignal; method?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...launch.headers };
    if (opts.range) headers.Range = opts.range;
    return fetch(url, { method: opts.method ?? 'GET', headers, signal: opts.signal ?? AbortSignal.timeout(30000), redirect: 'follow' });
  }

  /** The phone is still watching (it reports every few seconds, also while paused). */
  touch(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.seen = Date.now();
  }

  /** The phone is done: let the engine's player stand-in exit (the engine notes how far it got). */
  end(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.release();
    this.emit('ended', id);
  }

  /** Ends every phone play, then gives the engine a moment to notice its player stopped. */
  async endAll(): Promise<void> {
    if (!this.sessions.size) return;
    for (const id of [...this.sessions.keys()]) this.end(id);
    await new Promise((r) => setTimeout(r, 900));
  }

  private watch() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const s of this.sessions.values()) {
        if (now - s.seen > (s.opened ? IDLE_MS : UNOPENED_MS)) this.end(s.id);
        else if (s.kind !== 'file' && now - s.upstream > KEEPALIVE_MS && /^http:\/\/127\.0\.0\.1[:/]/.test(s.launch.url)) {
          s.upstream = now;
          void this.fetch(s.launch, s.launch.url).then((r) => r.arrayBuffer(), () => undefined);
        }
      }
      if (!this.sessions.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, 30_000);
    this.timer.unref?.();
  }

  // ── HTTP: /watch/<session>/… ─────────────────────────────────────────────

  async handle(req: http.IncomingMessage, res: http.ServerResponse, rest: string): Promise<unknown> {
    const [id, ...parts] = rest.split('/');
    const s = this.sessions.get(id);
    if (!s) return send(res, 410, 'text/plain', 'This play has ended.');
    s.seen = Date.now();
    s.opened = true;
    const what = parts.join('/');
    try {
      if (what === 'subs.vtt') return send(res, s.vtt ? 200 : 404, 'text/vtt; charset=utf-8', s.vtt ?? '');
      if (s.kind === 'file') {
        if (what === 'video') return await this.pipe(req, res, s, s.launch.url);
      } else if (s.kind === 'hls') {
        if (what === 'master.m3u8') return await this.playlist(res, s, s.launch.url);
        if (parts[0] === 'h' && parts[1]) {
          // Links to playlists end in .m3u8 here; everything else is media.
          const isPlaylist = parts[1].endsWith('.m3u8');
          const url = unb64(parts[1].replace(/\.m3u8$/, ''));
          if (!s.allowed.has(url)) return send(res, 403, 'text/plain', 'Not part of this stream.');
          return await (isPlaylist ? this.playlist(res, s, url) : this.pipe(req, res, s, url));
        }
      } else {
        return await this.dashRoute(req, res, s, parts);
      }
      send(res, 404, 'text/plain', 'Not found.');
    } catch (e) {
      if (!res.headersSent) send(res, 502, 'text/plain', e instanceof Error ? e.message : String(e));
      else res.destroy();
    }
  }

  private paths(s: Session): HlsPaths {
    return {
      playlist: (r) => `/watch/${s.id}/${r.type === 'video' ? 'v' : 'a'}/${encodeURIComponent(r.id)}.m3u8`,
      init: (r) => `/watch/${s.id}/init/${encodeURIComponent(r.id)}.mp4`,
      segment: (r, i) => `/watch/${s.id}/seg/${encodeURIComponent(r.id)}/${i}.m4s`,
    };
  }

  private manifest(s: Session): Promise<DashManifest> {
    s.dash ??= (async () => {
      const res = await this.fetch(s.launch, s.launch.url);
      s.upstream = Date.now();
      if (!res.ok) throw new Error(`The stream answered ${res.status}.`);
      return parseMpd(await res.text(), res.url || s.launch.url);
    })();
    s.dash.catch(() => (s.dash = undefined));
    return s.dash;
  }

  /** A rendition's initialization segment, with HEVC labelled for Apple's player. */
  private init(s: Session, r: Rendition): Promise<Buffer> {
    let p = s.inits.get(r.id);
    if (!p) {
      p = (async () => {
        if (!r.init) throw new Error('No initialization segment.');
        const res = await this.fetch(s.launch, r.init);
        if (!res.ok) throw new Error(`The stream answered ${res.status}.`);
        return hvc1(Buffer.from(await res.arrayBuffer()));
      })();
      p.catch(() => s.inits.delete(r.id));
      s.inits.set(r.id, p);
    }
    return p;
  }

  /** "hev1" alone (as MovieBox writes it) isn't enough for an HLS playlist: read the real codec. */
  private async codec(s: Session, r: Rendition): Promise<string> {
    const known = s.codecs.get(r.id);
    if (known) return known;
    let codec = r.codecs.includes('.') ? r.codecs.replace(/^hev1/, 'hvc1') : '';
    if (!codec && r.init) codec = codecString(await this.init(s, r)) ?? '';
    if (!codec) codec = r.type === 'audio' ? 'mp4a.40.2' : r.codecs;
    s.codecs.set(r.id, codec);
    return codec;
  }

  private async dashRoute(req: http.IncomingMessage, res: http.ServerResponse, s: Session, parts: string[]) {
    const d = await this.manifest(s);
    const paths = this.paths(s);
    const find = (id: string) => d.renditions.find((r) => r.id === decodeURIComponent(id));
    const [what, a, b] = parts;
    if (what === 'master.m3u8') {
      await Promise.all(d.renditions.map((r) => this.codec(s, r)));
      const subs = s.vtt ? { uri: `/watch/${s.id}/subs.m3u8`, name: s.subtitleName, lang: languageTag(LANGUAGE_CODES[s.subtitleName]) } : undefined;
      return send(res, 200, 'application/vnd.apple.mpegurl', masterPlaylist(d, (r) => s.codecs.get(r.id) ?? '', paths, subs));
    }
    if (what === 'subs.m3u8') return send(res, 200, 'application/vnd.apple.mpegurl', subtitlePlaylist(`/watch/${s.id}/subs.vtt`, d.duration));
    if ((what === 'v' || what === 'a') && a) {
      const r = find(a.replace(/\.m3u8$/, ''));
      if (r) return send(res, 200, 'application/vnd.apple.mpegurl', mediaPlaylist(r, paths));
    }
    if (what === 'init' && a) {
      const r = find(a.replace(/\.mp4$/, ''));
      if (r) return send(res, 200, 'video/mp4', await this.init(s, r));
    }
    if (what === 'seg' && a && b) {
      const r = find(a);
      const seg = r?.segments[Number.parseInt(b, 10)];
      if (seg) return this.pipe(req, res, s, seg.url, 'video/mp4');
    }
    send(res, 404, 'text/plain', 'Not found.');
  }

  /** An HLS playlist with its links pointed back here (variants and renditions as playlists). */
  private async playlist(res: http.ServerResponse, s: Session, url: string) {
    const up = await this.fetch(s.launch, url);
    s.upstream = Date.now();
    const type = up.headers.get('content-type') ?? '';
    const body = Buffer.from(await up.arrayBuffer());
    if (!up.ok) return send(res, up.status, 'text/plain', body);
    const text = body.toString('utf8');
    if (!text.trimStart().startsWith('#EXTM3U')) return send(res, up.status, type || 'application/octet-stream', body);
    const base = up.url || url;
    const point = (link: string, isPlaylist: boolean) => {
      const abs = new URL(link, base).href;
      s.allowed.add(abs);
      return `/watch/${s.id}/h/${b64(abs)}${isPlaylist ? '.m3u8' : ''}`;
    };
    let variantNext = false;
    const out = text
      .split(/\r?\n/)
      .map((line) => {
        const l = line.trim();
        if (!l) return '';
        if (l.startsWith('#')) {
          variantNext = l.startsWith('#EXT-X-STREAM-INF');
          // Renditions and I-frame variants are playlists; keys and init maps are files.
          const playlistTag = l.startsWith('#EXT-X-MEDIA:') || l.startsWith('#EXT-X-I-FRAME-STREAM-INF');
          return l.replace(/URI="([^"]+)"/g, (_, u: string) => `URI="${point(u, playlistTag)}"`);
        }
        const link = point(l, variantNext || /\.m3u8?(?:$|\?)/i.test(new URL(l, base).pathname));
        variantNext = false;
        return link;
      })
      .join('\n');
    send(res, 200, 'application/vnd.apple.mpegurl', out);
  }

  /** Streams one resource from upstream to the phone, passing seeking (Range) both ways. */
  private async pipe(req: http.IncomingMessage, res: http.ServerResponse, s: Session, url: string, type?: string) {
    const abort = new AbortController();
    const stop = () => abort.abort();
    res.on('close', stop);
    const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const up = await this.fetch(s.launch, url, { range, signal: abort.signal, method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
    s.upstream = Date.now();
    const headers: Record<string, string> = {};
    for (const h of ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = up.headers.get(h);
      if (v) headers[h] = v;
    }
    const upType = up.headers.get('content-type');
    headers['content-type'] = type ?? (upType && !/octet-stream/i.test(upType) ? upType : guessType(url));
    if (!headers['accept-ranges'] && !range) headers['accept-ranges'] = 'bytes';
    res.writeHead(up.status, headers);
    if (!up.body || req.method === 'HEAD') return res.end();
    Readable.fromWeb(up.body as import('node:stream/web').ReadableStream).on('error', () => res.destroy()).pipe(res);
  }
}

function guessType(url: string): string {
  const ext = /\.(\w+)(?:$|\?)/.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  return { mp4: 'video/mp4', m4v: 'video/mp4', m4s: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', ts: 'video/mp2t', aac: 'audio/aac' }[ext ?? ''] ?? 'video/mp4';
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
