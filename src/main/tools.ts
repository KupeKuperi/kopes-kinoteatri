// Sets up what the app needs on a computer that doesn't have it yet: the moviebox-tui engine (its
// official GitHub release, checksum-verified) and VLC / yt-dlp (winget on Windows, Homebrew on a
// Mac, or their download page when there's no package manager).
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const ENGINE_REPO = 'mesamirh/MovieBox-Tui';

type Fetch = (url: string) => Promise<Response>;

/** Where the engine's own installers put it (install.ps1 / install.sh), and where this app installs it. */
export function engineDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Programs', 'MovieBox-Tui', 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

let pathCache: { at: number; value: string } | null = null;
let loginShellPath: string | null | undefined;

/** PATH as the user's login shell sets it. A Mac app opened from the Dock gets only /usr/bin:/bin:… */
function shellPath(): string {
  if (loginShellPath !== undefined) return loginShellPath ?? '';
  loginShellPath = null;
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-l', '-c', 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    loginShellPath = /__PATH__([\s\S]*?)__PATH__/.exec(out)?.[1] ?? null;
  } catch {
    /* the fixed folders below still apply */
  }
  return loginShellPath ?? '';
}

/** Windows' PATH from the registry (user + machine), so tools installed after the app started count. */
function registryPath(): string[] {
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
  return [
    ...read('HKCU\\Environment').split(';'),
    ...read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment').split(';'),
    path.join(local, 'Microsoft', 'WinGet', 'Links'),
  ];
}

/**
 * PATH for finding tools and for the engine: as the system has it now, not as it was when this app
 * started, so tools installed meanwhile are found without a restart. Includes the engine's folder.
 */
export function currentPath(): string {
  if (pathCache && Date.now() - pathCache.at < 5000) return pathCache.value;
  const own = process.env.PATH ?? process.env.Path ?? '';
  const home = os.homedir();
  const parts =
    process.platform === 'win32'
      ? [...own.split(';'), ...registryPath(), engineDir()]
      : [
          ...own.split(':'),
          ...shellPath().split(':'),
          // Homebrew (Apple Silicon, Intel), the engine's install.sh folder, cargo, and the system.
          '/opt/homebrew/bin',
          '/opt/homebrew/sbin',
          '/usr/local/bin',
          engineDir(),
          path.join(home, '.cargo', 'bin'),
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ];
  const seen = new Set<string>();
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const value = parts
    .map((p) => p.trim())
    .filter((p) => p && !seen.has(norm(p)) && seen.add(norm(p)))
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

/** The bytes of the regular file called `name` inside a tar archive (ustar, GNU long names). */
export function untarEntry(tar: Buffer, name: string): Buffer {
  let p = 0;
  let longName: string | null = null;
  while (p + 512 <= tar.length) {
    const header = tar.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break; // end of the archive
    const field = (start: number, len: number) => header.toString('utf8', start, start + len).replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0x30); // NUL: an old-style regular file
    const prefix = field(345, 155);
    const entry = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const data = tar.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0[\s\S]*$/, ''); // the next entry's full name
      continue;
    }
    if (type === '0' && entry.split('/').pop() === name) return Buffer.from(data);
  }
  throw new Error(`${name} is not in the archive.`);
}

async function download(fetchFn: Fetch, url: string): Promise<Buffer> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The release file for a system, as the engine's own installers pick it. */
export function engineAsset(platform: NodeJS.Platform, arch: string): string | null {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64';
  if (platform === 'win32') return `MovieBox_Windows_${cpu}.zip`;
  if (platform === 'darwin') return 'MovieBox_macOS_Universal.tar.gz';
  if (platform === 'linux') return `MovieBox_Linux_${cpu}.tar.gz`;
  return null;
}

/**
 * Installs the latest moviebox-tui from its official GitHub release the way its own install.ps1 /
 * install.sh do: archive + SHA256SUMS from the release, checksum checked before anything is
 * written, the program put where they put it. Returns the program's path.
 */
export async function installEngine(
  fetchFn: Fetch,
  progress: (step: string) => void,
  opts: { platform?: NodeJS.Platform; arch?: string; dir?: string } = {},
): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const asset = engineAsset(platform, opts.arch ?? process.arch);
  if (!asset) throw new Error(`Install moviebox-tui with its own installer: https://github.com/${ENGINE_REPO}`);
  const base = `https://github.com/${ENGINE_REPO}/releases/latest/download`;
  progress('Downloading moviebox-tui from GitHub…');
  const [archive, sums] = await Promise.all([download(fetchFn, `${base}/${asset}`), download(fetchFn, `${base}/SHA256SUMS`)]);
  progress('Checking the download…');
  const line = sums
    .toString('utf8')
    .split(/\r?\n/)
    .find((l) => l.trim().split(/\s+/).pop()?.replace(/^\*/, '') === asset);
  const expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (!expected) throw new Error('The release has no checksum for this download, so it was not installed.');
  if (expected !== actual) throw new Error('The download does not match its published checksum, so it was not installed.');
  progress('Installing…');
  const bin = platform === 'win32' ? 'moviebox-tui.exe' : 'moviebox-tui';
  const program = asset.endsWith('.zip') ? unzipEntry(archive, bin) : untarEntry(zlib.gunzipSync(archive), bin);
  const dir = opts.dir ?? engineDir(platform);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, bin);
  const tmp = `${target}.download`;
  fs.writeFileSync(tmp, program, { mode: 0o755 });
  fs.renameSync(tmp, target);
  if (platform !== 'win32') fs.chmodSync(target, 0o755);
  pathCache = null;
  return target;
}

/** VLC (to play) and yt-dlp (MovieBox downloads): how each system's package manager names them. */
export const TOOLS = {
  vlc: { name: 'VLC', winget: 'VideoLAN.VLC', brew: ['install', '--cask', 'vlc'], page: 'https://www.videolan.org/vlc/' },
  'yt-dlp': { name: 'yt-dlp', winget: 'yt-dlp.yt-dlp', brew: ['install', 'yt-dlp', 'ffmpeg'], page: 'https://github.com/yt-dlp/yt-dlp/wiki/Installation' },
} as const;
export type Tool = keyof typeof TOOLS;

function run(program: string, args: string[], env: NodeJS.ProcessEnv, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(program, args, { windowsHide: true, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      pathCache = null; // the tool may have added itself to PATH
      const out = `${stdout}\n${stderr}`;
      if (!err || /already installed|no newer package versions/i.test(out)) return resolve();
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error(`${path.basename(program)} isn't on this computer.`));
      if (/cancel/i.test(out)) return reject(new Error(`The ${what} installation was cancelled.`));
      const last = out
        .split(/\r?\n/)
        .map((l) => l.replace(/[█▒░\-\\|/]+\s*$/, '').trim())
        .filter((l) => l && !/^[\s█▒░\-\\|/]*$/.test(l))
        .pop();
      reject(new Error(last ? `${path.basename(program)}: ${last}` : `${what} could not be installed.`));
    });
  });
}

/**
 * Installs `tool`: winget on Windows (VLC installs for all users, so Windows asks for permission),
 * Homebrew on a Mac. Without either, its download page opens and `manual` says which.
 */
export async function installTool(tool: Tool, openUrl: (url: string) => Promise<void>): Promise<{ manual?: string }> {
  const t = TOOLS[tool];
  if (!t) throw new Error('Unknown tool.');
  const env = { ...process.env, PATH: currentPath(), HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' };
  if (process.platform === 'win32') {
    try {
      await run('winget', ['install', '--id', t.winget, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], env, t.name);
      return {};
    } catch (e) {
      if (!/isn't on this computer/.test((e as Error).message)) throw e;
    }
  } else if (process.platform === 'darwin') {
    const brew = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'].find((p) => fs.existsSync(p));
    if (brew) {
      await run(brew, [...t.brew], env, t.name);
      return {};
    }
  }
  await openUrl(t.page);
  return { manual: t.page };
}
