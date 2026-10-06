// Locates the installed moviebox-tui binary and other external tools.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BinaryInfo } from '@shared/types';
import { currentPath } from './tools';

const EXE = process.platform === 'win32' ? '.exe' : '';

function knownLocations(): string[] {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  if (process.platform === 'win32') {
    return [
      path.join(local, 'Programs', 'MovieBox-Tui', 'bin', 'moviebox-tui.exe'),
      path.join(home, '.cargo', 'bin', 'moviebox-tui.exe'),
      path.join(home, 'scoop', 'shims', 'moviebox-tui.exe'),
    ];
  }
  return [
    path.join(home, '.local', 'bin', 'moviebox-tui'),
    path.join(home, '.cargo', 'bin', 'moviebox-tui'),
    '/opt/homebrew/bin/moviebox-tui',
    '/usr/local/bin/moviebox-tui',
    '/usr/bin/moviebox-tui',
  ];
}

/** Resolves an executable on PATH without spawning a shell. */
export function which(name: string): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';') : [''];
  // PATH as it is now: a tool installed while the app runs is found without a restart.
  for (const dir of currentPath().split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + (name.toLowerCase().endsWith(ext.toLowerCase()) ? '' : ext.toLowerCase()));
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

function readVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /moviebox-tui\s+v?([\w.\-+]+)/i.exec(stdout);
      resolve(m ? m[1] : stdout.trim() || null);
    });
  });
}

export async function detectBinary(override?: string): Promise<BinaryInfo | null> {
  // For development: preview the first-run screen on a computer that has the engine.
  if (process.env.KINOTEATRI_SIMULATE_NO_ENGINE === '1') return null;
  const candidates: Array<[string, BinaryInfo['source']]> = [];
  if (override?.trim()) candidates.push([override.trim(), 'override']);
  const onPath = which('moviebox-tui' + EXE);
  if (onPath) candidates.push([onPath, 'path']);
  for (const p of knownLocations()) candidates.push([p, 'known-location']);

  for (const [p, source] of candidates) {
    if (!fs.existsSync(p)) continue;
    const version = await readVersion(p);
    if (version) return { path: p, version, source };
  }
  return null;
}

export function detectPlayers(paths: { vlc?: string | null; mpv?: string | null; iina?: string | null }) {
  const pick = (configured: string | null | undefined, ...fallbacks: Array<string | null>) => {
    for (const p of [configured ?? null, ...fallbacks]) if (p && fs.existsSync(p)) return p;
    return null;
  };
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  return {
    vlc: pick(paths.vlc, which('vlc'), path.join(pf, 'VideoLAN', 'VLC', 'vlc.exe'), path.join(pf86, 'VideoLAN', 'VLC', 'vlc.exe'), '/Applications/VLC.app/Contents/MacOS/VLC'),
    mpv: pick(paths.mpv, which('mpv'), path.join(os.homedir(), 'scoop', 'apps', 'mpv', 'current', 'mpv.exe')),
    iina: pick(paths.iina, which('iina-cli'), '/Applications/IINA.app/Contents/MacOS/iina-cli'),
  };
}
