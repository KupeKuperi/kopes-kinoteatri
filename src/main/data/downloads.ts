// Lists what the TUI has downloaded into its folder: finished videos (with the subtitles saved
// beside them) and unfinished ones, whose many yt-dlp pieces are grouped into one entry.
import fs from 'node:fs';
import path from 'node:path';
import type { DownloadFile } from '@shared/types';

const VIDEO = /\.(mp4|mkv|webm|m4v|mov|avi|ts)$/i;
/**
 * Suffix of a piece of an unfinished download: X.mp4.part, X.f2.mp4.part-Frag12.part, X.f2.mp4.ytdl
 * (yt-dlp), X.mkv.part + X.mkv.part.json (the TUI's own resumable downloader), …
 */
const PIECE_SUFFIX = /\.(?:part(?:-Frag\d+(?:\.part)?)?|part\.json|ytdl|tmp|download|partial)$/i;
/** yt-dlp's per-format infix ("X.f2.mp4", "X.fhls-1080p.mp4"); it always holds a digit. */
const FORMAT_ID = /\.f(?=[\w-]*\d)[\w-]+(\.\w+)$/;
/** Subtitles the TUI saves next to a video: "X.en.srt". */
const SUBTITLE = /^(.*)\.([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.(?:srt|vtt|ass)$/i;

/** The file an unfinished download will become ("X.mp4"), or null if `name` isn't a piece of one. */
export function finalName(name: string): string | null {
  if (!PIECE_SUFFIX.test(name)) return null;
  const video = name.replace(PIECE_SUFFIX, '').replace(FORMAT_ID, '$1');
  return VIDEO.test(video) ? video : null;
}

export function listDownloads(root: string, depth = 6): DownloadFile[] {
  const finished = new Map<string, DownloadFile>();
  const unfinished = new Map<string, DownloadFile>();
  const subtitles = new Map<string, Set<string>>();
  const walk = (dir: string, level: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (level < depth) walk(p, level + 1);
        continue;
      }
      const sub = SUBTITLE.exec(e.name);
      if (sub) {
        const key = path.join(dir, sub[1]);
        subtitles.set(key, (subtitles.get(key) ?? new Set()).add(sub[2].toLowerCase()));
        continue;
      }
      const final = finalName(e.name);
      if (!final && !VIDEO.test(e.name)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue; // removed meanwhile
      }
      if (final) {
        const key = path.join(dir, final);
        const g = unfinished.get(key) ?? { name: final, path: key, size: 0, modified: 0, partial: true, pieces: 0 };
        g.size += st.size;
        g.modified = Math.max(g.modified, st.mtimeMs);
        g.pieces = (g.pieces ?? 0) + 1;
        unfinished.set(key, g);
      } else {
        finished.set(p, { name: e.name, path: p, size: st.size, modified: st.mtimeMs, partial: false });
      }
    }
  };
  walk(root, 1);
  const out = [...finished.values(), ...[...unfinished.values()].filter((u) => !finished.has(u.path))];
  for (const f of out) {
    const langs = subtitles.get(f.path.replace(/\.[^.\\/]+$/, ''));
    if (langs?.size) f.subtitles = [...langs];
  }
  return out.sort((a, b) => b.modified - a.modified);
}

/**
 * Deletes the pieces of the unfinished download `target` ("…\X.mp4" as listed) and nothing else,
 * then the folders it leaves empty (up to, not including, the download folder `root`).
 */
export function deleteUnfinished(target: string, root: string): number {
  const dir = path.dirname(target);
  const name = path.basename(target);
  let removed = 0;
  for (const e of fs.readdirSync(dir)) {
    if (finalName(e) !== name) continue;
    fs.rmSync(path.join(dir, e), { force: true });
    removed++;
  }
  const top = path.resolve(root);
  for (let d = path.resolve(dir); d.startsWith(top + path.sep); d = path.dirname(d)) {
    try {
      if (fs.readdirSync(d).length) break;
      fs.rmdirSync(d);
    } catch {
      break;
    }
  }
  return removed;
}
