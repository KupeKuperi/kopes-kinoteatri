// MovieBox streams are DASH (a manifest plus fragmented-MP4 segments). An iPhone plays HLS, not
// DASH, so the phone gets HLS playlists written from the manifest; the segments themselves are
// relayed unchanged. Handles what VOD manifests use: SegmentTemplate with or without a
// SegmentTimeline ($Number$ / $Time$ addressing), BaseURL, one period.

// ── A small XML reader (manifests are plain, machine-written XML) ───────────

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k] ?? _;
  });

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const clean = xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, '');
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  for (let m = tag.exec(clean); m; m = tag.exec(clean)) {
    const top = stack[stack.length - 1];
    top.text += decode(clean.slice(last, m.index));
    last = tag.lastIndex;
    if (m[5] !== undefined) {
      top.text += m[5];
      continue;
    }
    const name = m[2].includes(':') ? m[2].slice(m[2].indexOf(':') + 1) : m[2];
    if (m[1]) {
      // Closing tag: pop back to the matching element.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of m[3].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const key = a[1].includes(':') && !a[1].startsWith('xmlns') ? a[1].slice(a[1].indexOf(':') + 1) : a[1];
      attrs[key] = decode(a[2] ?? a[3] ?? '');
    }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    top.children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

const child = (n: XmlNode | undefined, name: string) => n?.children.find((c) => c.name === name);
const children = (n: XmlNode | undefined, name: string) => n?.children.filter((c) => c.name === name) ?? [];

/** ISO 8601 durations as manifests write them (PT3H48M18.4S, P1DT2H). */
export function isoSeconds(v?: string): number {
  const m = v ? /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v.trim()) : null;
  if (!m) return 0;
  const [d, h, min, s] = m.slice(1).map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

// ── Manifest → renditions ────────────────────────────────────────────────

export interface Segment {
  url: string;
  /** Seconds. */
  duration: number;
}

export interface Rendition {
  id: string;
  type: 'video' | 'audio';
  bandwidth: number;
  /** As the manifest writes it ("hev1", "avc1.640028", "mp4a.40.2"); may be incomplete. */
  codecs: string;
  width?: number;
  height?: number;
  frameRate?: number;
  lang?: string;
  label?: string;
  init?: string;
  segments: Segment[];
}

export interface DashManifest {
  duration: number;
  renditions: Rendition[];
}

const join = (base: string, rel?: string) => (rel ? new URL(rel.trim(), base).href : base);

function frameRate(v?: string): number | undefined {
  if (!v) return undefined;
  const [a, b] = v.split('/').map(Number);
  const r = b ? a / b : a;
  return Number.isFinite(r) && r > 0 ? r : undefined;
}

/** Fills a SegmentTemplate URL: $RepresentationID$, $Bandwidth$, $Number%05d$, $Time$, $$. */
function fill(template: string, rep: { id: string; bandwidth: number }, number: number, time: number): string {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (_, key: string, width?: string) => {
    if (key === '') return '$';
    const value = key === 'RepresentationID' ? rep.id : String(key === 'Number' ? number : key === 'Time' ? time : rep.bandwidth);
    return width && key !== 'RepresentationID' ? value.padStart(Number(width), '0') : value;
  });
}

export function parseMpd(xml: string, mpdUrl: string): DashManifest {
  const mpd = child(parseXml(xml), 'MPD');
  if (!mpd) throw new Error('The stream manifest could not be read.');
  if (mpd.attrs.type === 'dynamic') throw new Error('Live DASH streams cannot play on a phone yet.');
  const period = child(mpd, 'Period');
  if (!period) throw new Error('The stream manifest has no content.');
  const total = isoSeconds(period.attrs.duration) || isoSeconds(mpd.attrs.mediaPresentationDuration);
  const mpdBase = join(mpdUrl, child(mpd, 'BaseURL')?.text);
  const periodBase = join(mpdBase, child(period, 'BaseURL')?.text);

  const renditions: Rendition[] = [];
  for (const set of children(period, 'AdaptationSet')) {
    const setBase = join(periodBase, child(set, 'BaseURL')?.text);
    const setTemplate = child(set, 'SegmentTemplate');
    for (const rep of children(set, 'Representation')) {
      const mime = rep.attrs.mimeType ?? set.attrs.mimeType ?? '';
      const kind = set.attrs.contentType ?? mime.split('/')[0];
      if (kind !== 'video' && kind !== 'audio') continue;
      const own = child(rep, 'SegmentTemplate');
      if (!own && !setTemplate) throw new Error('This stream uses a manifest layout a phone cannot play yet.');
      const t = { ...(setTemplate?.attrs ?? {}), ...(own?.attrs ?? {}) };
      const timeline = child(own, 'SegmentTimeline') ?? child(setTemplate, 'SegmentTimeline');
      const base = join(setBase, child(rep, 'BaseURL')?.text);
      const r = { id: rep.attrs.id ?? String(renditions.length), bandwidth: Number(rep.attrs.bandwidth ?? 0) };
      const timescale = Number(t.timescale ?? 1) || 1;
      const startNumber = Number(t.startNumber ?? 1);
      const segments: Segment[] = [];
      if (!t.media) throw new Error('The stream manifest names no segments.');
      if (timeline) {
        const items = children(timeline, 'S');
        let time = 0;
        let number = startNumber;
        items.forEach((s, i) => {
          if (s.attrs.t !== undefined) time = Number(s.attrs.t);
          const d = Number(s.attrs.d);
          let repeat = Number(s.attrs.r ?? 0);
          if (repeat < 0) {
            // Repeat until the next entry's start, or the end of the period.
            const nextStart = items[i + 1]?.attrs.t !== undefined ? Number(items[i + 1].attrs.t) : total * timescale;
            repeat = Math.max(0, Math.ceil((nextStart - time) / d) - 1);
          }
          for (let k = 0; k <= repeat; k++) {
            segments.push({ url: join(base, fill(t.media, r, number, time)), duration: d / timescale });
            time += d;
            number++;
          }
        });
      } else {
        const d = Number(t.duration);
        if (!d || !total) throw new Error('The stream manifest has no segment timing.');
        const count = Math.ceil((total * timescale) / d);
        for (let i = 0; i < count; i++) {
          const duration = Math.min(d, total * timescale - i * d) / timescale;
          segments.push({ url: join(base, fill(t.media, r, startNumber + i, i * d)), duration });
        }
      }
      renditions.push({
        id: r.id,
        type: kind,
        bandwidth: r.bandwidth,
        codecs: rep.attrs.codecs ?? set.attrs.codecs ?? '',
        width: Number(rep.attrs.width ?? set.attrs.width) || undefined,
        height: Number(rep.attrs.height ?? set.attrs.height) || undefined,
        frameRate: frameRate(rep.attrs.frameRate ?? set.attrs.frameRate),
        lang: set.attrs.lang ?? rep.attrs.lang,
        label: child(set, 'Label')?.text.trim() || child(rep, 'Label')?.text.trim() || undefined,
        init: t.initialization ? join(base, fill(t.initialization, r, startNumber, 0)) : undefined,
        segments,
      });
    }
  }
  if (!renditions.some((r) => r.type === 'video')) throw new Error('The stream manifest has no video.');
  return { duration: total, renditions };
}

// ── Renditions → HLS ───────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', eng: 'English', ka: 'ქართული', kat: 'ქართული', geo: 'ქართული', ru: 'Русский', rus: 'Русский', hi: 'Hindi', hin: 'Hindi',
  es: 'Español', spa: 'Español', fr: 'Français', fra: 'Français', fre: 'Français', de: 'Deutsch', deu: 'Deutsch', ger: 'Deutsch', pt: 'Português', por: 'Português',
  tr: 'Türkçe', tur: 'Türkçe', uk: 'Українська', ukr: 'Українська', ar: 'العربية', ara: 'العربية', ja: '日本語', jpn: '日本語', ko: '한국어', kor: '한국어', zh: '中文', zho: '中文', chi: '中文',
};
const attr = (v: string) => v.replace(/"/g, "'");
/** HLS wants BCP 47 tags: the two-letter code where manifests write the three-letter one. */
const TWO_LETTER: Record<string, string> = {
  eng: 'en', kat: 'ka', geo: 'ka', rus: 'ru', hin: 'hi', spa: 'es', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', por: 'pt', tur: 'tr', ukr: 'uk',
  ara: 'ar', jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh', ita: 'it', tam: 'ta', tel: 'te', ben: 'bn', ind: 'id', tha: 'th', vie: 'vi', pol: 'pl',
};
export const languageTag = (lang?: string) => (lang && lang !== 'und' ? (TWO_LETTER[lang.toLowerCase()] ?? lang) : undefined);

export interface HlsPaths {
  /** URL of a rendition's media playlist. */
  playlist(r: Rendition): string;
  /** URL of a rendition's initialization segment. */
  init(r: Rendition): string;
  /** URL of segment `i` of a rendition. */
  segment(r: Rendition, i: number): string;
}

/** The master playlist: every video rendition, its audio, and the subtitles when there are some. */
export function masterPlaylist(
  d: DashManifest,
  codecs: (r: Rendition) => string,
  paths: HlsPaths,
  subtitles?: { uri: string; name: string; lang?: string },
): string {
  const video = d.renditions.filter((r) => r.type === 'video');
  const audio = d.renditions.filter((r) => r.type === 'audio');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  audio.forEach((a, i) => {
    const lang = languageTag(a.lang);
    const name = a.label ?? (a.lang && lang ? (LANGUAGE_NAMES[a.lang.toLowerCase()] ?? lang) : `Audio ${i + 1}`);
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${attr(name)}",${lang ? `LANGUAGE="${attr(lang)}",` : ''}DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${paths.playlist(a)}"`,
    );
  });
  if (subtitles) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="${attr(subtitles.name)}",${subtitles.lang ? `LANGUAGE="${attr(subtitles.lang)}",` : ''}DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="${subtitles.uri}"`,
    );
  }
  const audioBandwidth = Math.max(0, ...audio.map((a) => a.bandwidth));
  const audioCodecs = [...new Set(audio.map(codecs).filter(Boolean))];
  // The first variant is where playback starts: the one nearest 720p loads quickly and looks good.
  const order = [...video].sort((a, b) => Math.abs((a.height ?? 720) - 720) - Math.abs((b.height ?? 720) - 720));
  for (const v of order) {
    const parts = [
      `BANDWIDTH=${v.bandwidth + audioBandwidth || 1000000}`,
      v.width && v.height ? `RESOLUTION=${v.width}x${v.height}` : '',
      v.frameRate ? `FRAME-RATE=${v.frameRate.toFixed(3)}` : '',
      `CODECS="${[codecs(v), ...audioCodecs].filter(Boolean).join(',')}"`,
      audio.length ? 'AUDIO="audio"' : '',
      subtitles ? 'SUBTITLES="subs"' : '',
    ].filter(Boolean);
    lines.push(`#EXT-X-STREAM-INF:${parts.join(',')}`, paths.playlist(v));
  }
  return lines.join('\n') + '\n';
}

/** One rendition's media playlist (VOD: every segment listed, ending with ENDLIST). */
export function mediaPlaylist(r: Rendition, paths: HlsPaths): string {
  const target = Math.max(1, Math.ceil(Math.max(...r.segments.map((s) => s.duration))));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (r.init) lines.push(`#EXT-X-MAP:URI="${paths.init(r)}"`);
  r.segments.forEach((s, i) => lines.push(`#EXTINF:${s.duration.toFixed(3)},`, paths.segment(r, i)));
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/** A subtitle "playlist": the whole WebVTT file as one segment. */
export function subtitlePlaylist(uri: string, duration: number): string {
  const d = Math.max(1, Math.ceil(duration));
  return ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${d}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXTINF:${d.toFixed(3)},`, uri, '#EXT-X-ENDLIST', ''].join('\n');
}
