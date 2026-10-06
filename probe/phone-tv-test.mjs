// Tunes a Live TV channel "on a phone" and fetches what its player would: the rewritten HLS
// playlists and a segment. Usage: node probe/phone-tv-test.mjs <port> <key> <channel> [group]
const [port, key, channel, group] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const first = await fetch(`${base}/?k=${key}`);
const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';
const call = async (ch, ...args) => {
  const r = await fetch(`${base}/api/call/${encodeURIComponent(ch)}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${ch}: ${j.error}`);
  return j.value;
};
const events = [];
const ac = new AbortController();
void fetch(`${base}/api/events`, { headers: { cookie }, signal: ac.signal })
  .then(async (r) => {
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const m = /^data: (.*)$/m.exec(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (m) events.push(JSON.parse(m[1]));
      }
    }
  })
  .catch(() => undefined);

const tv = await call('tv:get');
log('channels', tv.channels.length, tv.channels.slice(0, 4).map((c) => c.name).join(' | '));
const device = 'test-phone-tv';
void call('phone:tv', device, channel, group).catch((e) => log('phone:tv failed', e.message));
const t0 = Date.now();
let ev;
while (!ev && Date.now() - t0 < 60000) {
  ev = events.find((e) => e.type === 'phone-play' && e.payload.device === device);
  await new Promise((r) => setTimeout(r, 250));
}
if (!ev) {
  log('FAIL no phone-play', events.map((e) => e.type).join(','));
  process.exit(1);
}
const s = ev.payload;
log('phone-play', JSON.stringify(s));
const get = (p) => fetch(base + p, { headers: { cookie } });
const master = await (await get(s.src)).text();
log('master:\n' + master.split('\n').slice(0, 12).join('\n'));
const next = master.split('\n').find((l) => l.startsWith('/watch/'));
if (next?.endsWith('.m3u8')) {
  const media = await (await get(next)).text();
  log('variant:\n' + media.split('\n').slice(0, 10).join('\n'));
  const seg = media.split('\n').find((l) => l.startsWith('/watch/'));
  const r = await get(seg);
  log('segment', r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength, 'bytes');
} else if (next) {
  const r = await get(next);
  log('segment', r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength, 'bytes');
}
const outside = await get(`/watch/${s.id}/h/${Buffer.from('https://example.com/x.ts').toString('base64url')}`);
log('a link that is not part of the stream →', outside.status);
await call('phone:stop', s.id);
ac.abort();
log('DONE');
