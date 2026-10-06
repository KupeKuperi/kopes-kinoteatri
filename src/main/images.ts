// `mbimg://` protocol: serves poster and channel-logo URLs through a disk cache
// so grids paint instantly on repeat visits and the renderer never needs
// direct network access.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, net, protocol } from 'electron';

export const IMAGE_SCHEME = 'mbimg';

export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Posters and channel logos come from the internet; never let a playlist point the app at the local network. */
function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  // IPv6 literals: unique-local (fc00::/7) and link-local (fe80::/10).
  if (!m) return host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:'));
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };

let cacheDir: string | null = null;

/** A poster or logo from the internet, through the disk cache (the window's mbimg:// and the phone's /img/). */
export async function cachedImage(target: string): Promise<Response> {
  if (!/^https?:\/\//i.test(target) || isPrivateHost(target)) return new Response(null, { status: 400 });
  if (!cacheDir) {
    cacheDir = path.join(app.getPath('userData'), 'image-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const ext = /\.(jpe?g|png|webp|gif|svg)(?:$|\?)/i.exec(target)?.[1]?.toLowerCase() ?? 'jpg';
  const file = path.join(cacheDir, crypto.createHash('sha1').update(target).digest('hex') + '.' + ext);
  const headers = { 'content-type': TYPES[ext] ?? 'image/jpeg', 'cache-control': 'max-age=604800' };
  try {
    return new Response(await fs.promises.readFile(file), { headers });
  } catch {
    /* not cached yet */
  }
  try {
    const res = await net.fetch(target, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return new Response(null, { status: res.status });
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_IMAGE_BYTES) return new Response(null, { status: 413 });
    // Write to a temp name first so a crash can't leave a truncated image in the cache.
    const tmp = `${file}.${process.pid}.tmp`;
    void fs.promises
      .writeFile(tmp, body)
      .then(() => fs.promises.rename(tmp, file))
      .catch(() => fs.promises.rm(tmp, { force: true }).catch(() => undefined));
    return new Response(body, { headers: { ...headers, 'content-type': res.headers.get('content-type') ?? headers['content-type'] } });
  } catch {
    return new Response(null, { status: 502 });
  }
}

export function handleImageScheme(): void {
  // mbimg://img/<encodeURIComponent(url)>
  protocol.handle(IMAGE_SCHEME, (request) => cachedImage(decodeURIComponent(new URL(request.url).pathname.slice(1))));
}
