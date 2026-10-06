// Sets up what the app needs on a computer that doesn't have it yet: the moviebox-tui engine
// (its official GitHub release, checksum-verified) and, through winget, VLC and yt-dlp.
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ENGINE_REPO = 'mesamirh/MovieBox-Tui';

type Fetch = (url: string) => Promise<Response>;

/** Where the engine's official installer puts it, and where this app installs it. */
export function engineDir(): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Programs', 'MovieBox-Tui', 'bin');
}

let pathCache: { at: number; value: string } | null = null;

/**
 * PATH as Windows has it now, not as it was when this app started: tools installed meanwhile
 * (winget links, VLC, yt-dlp) are found without restarting. Elsewhere it is just this process's PATH.
 */
export function currentPath(): string {
  const own = process.env.PATH ?? process.env.Path ?? '';
  if (process.platform !== 'win32') return own;
  if (pathCache && Date.now() - pathCache.at < 5000) return pathCache.value;
  const read = (key: string) => {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const raw = /Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(out)?.[1]?.trim() ?? '';
      return raw.replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m);
    } catch {
      return '';
    }
  };
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const parts = [
    ...own.split(path.delimiter),
    ...read('HKCU\\Environment').split(';'),
    ...read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment').split(';'),
    path.join(local, 'Microsoft', 'WinGet', 'Links'),
    engineDir(),
  ];
  const seen = new Set<string>();
  const value = parts
    .map((p) => p.trim())
    .filter((p) => p && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    .join(path.delimiter);
  pathCache = { at: Date.now(), value };
  return value;
}

/** The bytes of the file called `name` inside a zip archive (stored or deflated). */
export function unzipEntry(zip: Buffer, name: string): Buffer {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('The download is not a zip archive.');
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip archive is damaged.');
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    if (entry.split('/').pop()?.toLowerCase() === name.toLowerCase()) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`The zip archive uses an unsupported compression (${method}).`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} is not in the archive.`);
}

async function download(fetchFn: Fetch, url: string): Promise<Buffer> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Installs the latest moviebox-tui from its official GitHub release, the same way its own
 * install.ps1 does (archive + SHA256SUMS from the release, checksum checked before anything is
 * written), into the folder the engine is looked for. Returns the program's path.
 */
export async function installEngine(fetchFn: Fetch, progress: (step: string) => void): Promise<string> {
  if (process.platform !== 'win32') throw new Error(`Install moviebox-tui with its own installer: https://github.com/${ENGINE_REPO}`);
  const asset = `MovieBox_Windows_${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
  const base = `https://github.com/${ENGINE_REPO}/releases/latest/download`;
  progress('Downloading moviebox-tui from GitHub…');
  const [zip, sums] = await Promise.all([download(fetchFn, `${base}/${asset}`), download(fetchFn, `${base}/SHA256SUMS`)]);
  progress('Checking the download…');
  const line = sums
    .toString('utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().split(/\s+/).pop()?.replace(/^\*/, '') === asset);
  const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
  const actual = crypto.createHash('sha256').update(zip).digest('hex');
  if (!expected) throw new Error('The release has no checksum for this download, so it was not installed.');
  if (expected !== actual) throw new Error('The download does not match its published checksum, so it was not installed.');
  progress('Installing…');
  const exe = unzipEntry(zip, 'moviebox-tui.exe');
  const dir = engineDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'moviebox-tui.exe');
  const tmp = `${target}.download`;
  fs.writeFileSync(tmp, exe);
  fs.renameSync(tmp, target);
  return target;
}

/** Tools the app can install through winget, Windows' own package manager. */
export const WINGET_TOOLS = {
  vlc: { id: 'VideoLAN.VLC', name: 'VLC' },
  'yt-dlp': { id: 'yt-dlp.yt-dlp', name: 'yt-dlp' },
} as const;
export type WingetTool = keyof typeof WINGET_TOOLS;

/** Runs `winget install` for `tool`. VLC installs for all users, so Windows asks for permission. */
export function installWithWinget(tool: WingetTool): Promise<void> {
  const pkg = WINGET_TOOLS[tool];
  if (!pkg) return Promise.reject(new Error('Unknown tool.'));
  if (process.platform !== 'win32') return Promise.reject(new Error(`Install ${pkg.name} with your system's package manager.`));
  return new Promise((resolve, reject) => {
    execFile(
      'winget',
      ['install', '--id', pkg.id, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
      { windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: currentPath() } },
      (err, stdout, stderr) => {
        pathCache = null; // the tool may have added itself to PATH
        const out = `${stdout}\n${stderr}`;
        if (!err || /already installed|no newer package versions/i.test(out)) return resolve();
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(new Error(`winget (App Installer) isn't on this computer. Install ${pkg.name} from its website instead.`));
        }
        if (/cancel/i.test(out)) return reject(new Error(`The ${pkg.name} installation was cancelled.`));
        const last = out
          .split(/\r?\n/)
          .map((l) => l.replace(/[█▒░\-\\|/]+\s*$/, '').trim())
          .filter((l) => l && !/^[\s█▒░\-\\|/]*$/.test(l))
          .pop();
        reject(new Error(last ? `winget: ${last}` : `winget could not install ${pkg.name}.`));
      },
    );
  });
}
