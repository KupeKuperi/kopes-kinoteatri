// Subtitles for the phone: the engine downloads them as SRT (or VTT); Safari reads WebVTT.
import fs from 'node:fs';

/** SRT → WebVTT (cue numbers dropped, commas in times made dots); WebVTT passes through. */
export function toWebVtt(text: string): string {
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (body.startsWith('WEBVTT')) return body + '\n';
  const cues = body
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');
      const at = lines.findIndex((l) => l.includes('-->'));
      if (at < 0) return '';
      const times = lines[at].replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2').replace(/(\d+:\d{2}:\d{2}\.\d)(?!\d)/g, '$100').replace(/(\d+:\d{2}:\d{2}\.\d{2})(?!\d)/g, '$10');
      const cue = lines.slice(at + 1).join('\n').trim();
      return cue ? `${times}\n${cue}` : '';
    })
    .filter(Boolean);
  // X-TIMESTAMP-MAP lines the cues up with the video's own clock (it starts at 0) inside HLS.
  return `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n${cues.join('\n\n')}\n`;
}

/** Reads a subtitle file the engine downloaded (it deletes it once the player is done). */
export function readSubtitles(file: string): string | null {
  try {
    const raw = fs.readFileSync(file);
    // Mostly UTF-8; older SRTs can be Windows-1252, which decodes as latin1 closely enough.
    const utf8 = raw.toString('utf8');
    return toWebVtt(utf8.includes('\uFFFD') ? raw.toString('latin1') : utf8);
  } catch {
    return null;
  }
}
