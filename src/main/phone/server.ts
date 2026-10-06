// Phone access: a phone on the same network opens the app in its browser. This server sends it the
// window's own screens (the built renderer), answers its calls with the desktop window's handlers
// (only those a phone may use), streams the engine's events, posters, and the plays relayed to it.
// A phone is paired by opening the address in the QR code once: the key in it becomes a cookie.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CHANNELS, PHONE_CHANNELS } from '@shared/channels';
import type { EngineEvent, PhoneInfo } from '@shared/types';
import { cachedImage } from '../images';
import type { Relay } from './relay';

export type Handler = (...args: any[]) => unknown;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const same = (a: string | null | undefined, b: string) => {
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

/** A phone may change only its subtitle choice in Settings. */
const onlySubtitles = (args: unknown[]) => {
  const patch = args[0] as { tui?: unknown; gui?: Record<string, unknown> } | undefined;
  return !!patch && !patch.tui && !!patch.gui && Object.keys(patch.gui).every((k) => k === 'subtitles');
};

/** The page a phone sees before it is paired. */
const PAIR_PAGE = `<!doctype html><html lang="ka"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>კოპეს კინოთეატრი</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#160d12;color:#f4eadf;font:16px/1.5 system-ui,sans-serif;padding:24px;box-sizing:border-box}
main{max-width:420px}h1{font-size:28px;margin:0 0 12px;color:#ffc65c}p{color:#a8939c;margin:0 0 14px}</style></head>
<body><main><h1>კოპეს კინოთეატრი</h1><p>ამ ტელეფონის დასაკავშირებლად კომპიუტერზე გახსენი პარამეტრები → ტელეფონი და კამერით დაასკანერე QR კოდი.</p>
<p>To connect this phone, open Settings → Phone in Kope's Kinoteatri on the computer and scan the QR code with the camera.</p></main></body></html>`;

/** Network names that never reach a phone (virtual adapters). */
const VIRTUAL = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|vboxnet|utun|llw|awdl|bridge|Loopback|Bluetooth/i;

/** Addresses of this computer a phone could open, best guess first. */
export function localAddresses(): Array<{ address: string; label: string }> {
  const out: Array<{ address: string; label: string; rank: number }> = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || VIRTUAL.test(name)) continue;
      const [x, y] = a.address.split('.').map(Number);
      const tailscale = x === 100 && y >= 64 && y <= 127;
      const lan = x === 10 || (x === 192 && y === 168) || (x === 172 && y >= 16 && y <= 31);
      if (!lan && !tailscale) continue;
      const wifi = /wi-?fi|wlan|wireless|en0/i.test(name);
      // 192.168.56.x is VirtualBox's host-only network (Windows calls it plain "Ethernet 2").
      const virtualBox = x === 192 && y === 168 && a.address.split('.')[2] === '56';
      out.push({ address: a.address, label: tailscale ? 'Tailscale' : name, rank: virtualBox ? 4 : tailscale ? 3 : wifi ? 0 : x === 192 ? 1 : 2 });
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(({ address, label }) => ({ address, label }));
}

export class PhoneServer {
  private server: http.Server | null = null;
  private clients = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;
  private port = 0;
  error: string | null = null;

  constructor(
    private readonly opts: {
      /** The built window (index.html and assets). */
      rendererDir: string;
      handlers: Map<string, Handler>;
      relay: Relay;
      key: () => string;
      /** Where to listen; tests use 127.0.0.1 so no firewall prompt appears. */
      host?: string;
    },
  ) {}

  get running(): boolean {
    return this.server !== null;
  }

  async start(port: number): Promise<void> {
    if (this.server && this.port === port) return;
    this.stop();
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(e instanceof Error ? e.message : String(e));
      });
    });
    // A play can stay on one connection for hours.
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, this.opts.host ?? '0.0.0.0', () => resolve());
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.error = code === 'EADDRINUSE' ? `Port ${port} is used by another program.` : `The phone server could not start (${code ?? String(e)}).`;
      return;
    }
    this.error = null;
    this.server = server;
    this.port = port;
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n');
    }, 20_000);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
  }

  info(enabled: boolean, port: number): PhoneInfo {
    const key = this.opts.key();
    return {
      enabled,
      port,
      urls: localAddresses().map(({ address, label }) => ({ url: `http://${address}:${port}/?k=${key}`, label })),
      error: enabled ? this.error : null,
      watching: this.opts.relay.active ? 1 : 0,
    };
  }

  /** Engine events for every open phone (the console stream stays on the computer). */
  broadcast(event: EngineEvent): void {
    if (event.type === 'console-data' || !this.clients.size) return;
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of this.clients) c.write(line);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://phone');
    const p = url.pathname;
    const key = this.opts.key();
    const cookie = /(?:^|;\s*)kk=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const fromLink = same(url.searchParams.get('k'), key);
    const paired = fromLink || same(cookie, key);

    // The app's code, fonts and icons are the same for everyone.
    if (p.startsWith('/assets/') || p === '/apple-touch-icon.png' || p === '/icon-512.png') return this.file(res, p);
    if (p === '/' || p === '/index.html') {
      if (!paired) return this.send(res, 401, TYPES['.html'], PAIR_PAGE);
      // Kept for a year; the address keeps its key too, so "Add to Home Screen" opens paired.
      if (fromLink) res.setHeader('set-cookie', `kk=${key}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
      return this.index(res, key);
    }
    if (p === '/manifest.webmanifest') return this.manifest(res, paired ? key : null);
    if (!paired) return this.send(res, 401, 'application/json', JSON.stringify({ ok: false, error: 'This phone is not paired. Scan the QR code again.' }));

    if (p === '/api/events') return this.events(req, res);
    if (p.startsWith('/api/call/') && req.method === 'POST') return this.call(req, res, decodeURIComponent(p.slice('/api/call/'.length)));
    if (p.startsWith('/img/')) {
      const image = await cachedImage(decodeURIComponent(p.slice('/img/'.length)));
      image.headers.forEach((value, name) => res.setHeader(name, value));
      res.writeHead(image.status);
      return res.end(Buffer.from(await image.arrayBuffer()));
    }
    if (p.startsWith('/watch/')) return this.opts.relay.handle(req, res, p.slice('/watch/'.length));
    this.send(res, 404, 'text/plain', 'Not found.');
  }

  private send(res: http.ServerResponse, status: number, type: string, body: string | Buffer) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  }

  private file(res: http.ServerResponse, p: string) {
    const root = path.resolve(this.opts.rendererDir);
    const file = path.resolve(root, '.' + decodeURIComponent(p));
    if (!file.startsWith(root + path.sep)) return this.send(res, 403, 'text/plain', 'No.');
    fs.readFile(file, (err, data) => {
      if (err) return this.send(res, 404, 'text/plain', 'Not found.');
      // Built assets carry a content hash in their names: they never change.
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'max-age=86400' });
      res.end(data);
    });
  }

  /** The window's index.html, made to behave as a phone app (full screen from the home screen). */
  private index(res: http.ServerResponse, key: string) {
    let html: string;
    try {
      html = fs.readFileSync(path.join(this.opts.rendererDir, 'index.html'), 'utf8');
    } catch {
      return this.send(res, 500, 'text/plain', 'The app files are missing.');
    }
    const head = [
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
      '<meta name="apple-mobile-web-app-title" content="კინოთეატრი">',
      '<meta name="theme-color" content="#160D12">',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
      `<link rel="manifest" href="/manifest.webmanifest?k=${key}">`,
    ].join('');
    html = html
      .replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')
      .replace('</head>', `${head}</head>`);
    this.send(res, 200, TYPES['.html'], html);
  }

  private manifest(res: http.ServerResponse, key: string | null) {
    const manifest = {
      name: "Kope's Kinoteatri",
      short_name: 'კინოთეატრი',
      start_url: key ? `/?k=${key}` : '/',
      display: 'standalone',
      background_color: '#160D12',
      theme_color: '#160D12',
      icons: [
        { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    };
    this.send(res, 200, TYPES['.webmanifest'], JSON.stringify(manifest));
  }

  private events(req: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  private async call(req: http.IncomingMessage, res: http.ServerResponse, channel: string) {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) return this.send(res, 413, 'text/plain', 'Too large.');
    }
    let args: unknown[] = [];
    try {
      const parsed = body ? JSON.parse(body) : [];
      args = Array.isArray(parsed) ? parsed : [];
    } catch {
      return this.send(res, 400, 'text/plain', 'Bad request.');
    }
    const allowed = PHONE_CHANNELS.has(channel) || (channel === CHANNELS.saveSettings && onlySubtitles(args));
    const fn = this.opts.handlers.get(channel);
    if (!allowed || !fn) return this.send(res, 403, 'application/json', JSON.stringify({ ok: false, error: 'Not available on a phone.' }));
    try {
      const value = await fn(...args);
      this.send(res, 200, 'application/json', JSON.stringify({ ok: true, value: value ?? null }));
    } catch (e) {
      this.send(res, 200, 'application/json', JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
  }
}
