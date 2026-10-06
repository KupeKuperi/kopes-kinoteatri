// What the engine hands its video player: moviebox-tui starts VLC or mpv with the stream (often
// through its own local relay on 127.0.0.1), the HTTP headers the source wants, a subtitle file
// it downloaded, and where to resume (src/player.rs: vlc_command, mpv_command).

export interface PlayerLaunch {
  /** Which player the engine meant to start: 'vlc' or 'mpv'. */
  player: string;
  /** The stream (an http URL). */
  url: string;
  /** Headers the source wants with every request (Referer, User-Agent, Cookie …). */
  headers: Record<string, string>;
  /** Subtitles the engine downloaded for this play (a local .srt or .vtt). */
  subFile?: string;
  /** Seconds to resume at. */
  start: number;
}

/** Reads the arguments of a VLC or mpv command line as the engine builds them; null without a stream. */
export function parseLaunch(player: string, args: string[]): PlayerLaunch | null {
  const headers: Record<string, string> = {};
  let subFile: string | undefined;
  let start = 0;
  let url: string | undefined;
  for (const raw of args) {
    if (!raw.startsWith('--')) {
      if (/^https?:\/\//i.test(raw)) url = raw;
      continue;
    }
    // IINA passes mpv's options as --mpv-<name>.
    const arg = raw.startsWith('--mpv-') ? `--${raw.slice(6)}` : raw;
    const eq = arg.indexOf('=');
    if (eq < 0) continue;
    const name = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (name) {
      case 'http-referrer': // VLC
      case 'referrer': // mpv
        headers.Referer = value;
        break;
      case 'http-user-agent':
      case 'user-agent':
        headers['User-Agent'] = value;
        break;
      case 'http-header-fields': {
        // mpv: one "Name: value" per option.
        const colon = value.indexOf(':');
        if (colon > 0) headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
        break;
      }
      case 'sub-file':
      case 'sub-files':
        subFile = value;
        break;
      case 'start-time': // VLC
      case 'start': // mpv
        start = Math.max(0, Number.parseFloat(value.replace(/^\+/, '')) || 0);
        break;
    }
  }
  return url ? { player, url, headers, subFile, start } : null;
}
