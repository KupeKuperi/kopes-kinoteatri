// Acts as a phone against a running app with phone access on: pairs, searches, opens a title,
// plays it "on the phone" and fetches what the phone's player would (playlists, init, a segment).
// Usage: node probe/phone-test.mjs <port> <key> [query]
const [port, key, query = 'The Lord of the Rings: The Fellowship of the Ring'] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (m) => {
  console.log('FAIL', m);
  process.exit(1);
};

const unpaired = await fetch(`${base}/`);
log('unpaired page', unpaired.status, (await unpaired.text()).includes('QR') ? '(pairing page)' : '');
const first = await fetch(`${base}/?k=${key}`);
const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';
const html = await first.text();
log('paired page', first.status, 'cookie', cookie ? 'set' : 'MISSING', html.includes('apple-touch-icon') ? 'phone tags ok' : 'no phone tags');
if (!cookie) fail('no cookie');

const call = async (channel, ...args) => {
  const r = await fetch(`${base}/api/call/${encodeURIComponent(channel)}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(`${channel}: ${j.error}`);
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
const waitFor = async (what, test, ms) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const e = events.find(test);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`no ${what} in ${ms / 1000}s (events: ${events.map((e) => e.type).join(',')})`);
};

const noCookie = await fetch(`${base}/api/call/app:status`, { method: 'POST', body: '[]' });
log('call without pairing →', noCookie.status);
const forbidden = await fetch(`${base}/api/call/engine:restart`, { method: 'POST', headers: { cookie }, body: '[]' });
log('engine:restart from a phone →', forbidden.status);
const img = await fetch(`${base}/img/${encodeURIComponent('https://images.metahub.space/poster/medium/tt0120737/img')}`, { headers: { cookie } });
log('poster through /img →', img.status, img.headers.get('content-type'), (await img.arrayBuffer()).byteLength, 'bytes');

const { status } = await call('app:status');
log('engine', status.state, status.provider);
const results = await call('search', query);
log('search', results.total, 'results; first', results.items[0]?.title, results.items[0]?.year);
const details = await call('details:open', 0, results.key);
log('details', details.state.title, '·', details.streams.length, 'streams', details.streams.map((s) => s.resolution).join(' '));
if (!details.streams.length) fail('no streams');

const device = 'test-phone-1';
const started = Date.now();
const play = call('phone:play', device, details.streams.length - 1, details.state.title).catch((e) => log('phone:play failed', e.message));
const ev = await waitFor('phone-play', (e) => e.type === 'phone-play' && e.payload.device === device, 120000);
const s = ev.payload;
log(`phone-play after ${((Date.now() - started) / 1000).toFixed(1)}s:`, JSON.stringify(s));
await play;

const get = async (path, opts = {}) => {
  const r = await fetch(base + path, { headers: { cookie, ...(opts.headers ?? {}) } });
  return r;
};
if (s.kind === 'hls') {
  const master = await (await get(s.src)).text();
  log('master playlist:\n' + master);
  const variant = master.split('\n').find((l) => l && !l.startsWith('#'));
  const audio = /TYPE=AUDIO[^\n]*URI="([^"]+)"/.exec(master)?.[1];
  for (const pl of [variant, audio].filter(Boolean)) {
    const media = await (await get(pl)).text();
    const lines = media.split('\n');
    const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(media)?.[1];
    const segs = lines.filter((l) => l && !l.startsWith('#'));
    log(`${pl}: ${segs.length} segments, ends ${lines.includes('#EXT-X-ENDLIST') ? 'with ENDLIST' : 'open (live)'}`);
    if (map) {
      const init = Buffer.from(await (await get(map)).arrayBuffer());
      log(`  init ${init.length} bytes, ${init.includes(Buffer.from('hvc1')) ? 'hvc1' : init.includes(Buffer.from('hev1')) ? 'hev1 (NOT relabelled)' : 'no hevc box'}`);
    }
    const t = Date.now();
    const seg = await get(segs[0]);
    const bytes = (await seg.arrayBuffer()).byteLength;
    log(`  first segment ${seg.status} ${seg.headers.get('content-type')} ${bytes} bytes in ${Date.now() - t} ms`);
  }
  if (/TYPE=SUBTITLES/.test(master)) {
    const vtt = await (await get(`/watch/${s.id}/subs.vtt`)).text();
    log('subtitles:', vtt.split('\n').slice(0, 6).join(' | '));
  }
} else {
  const r = await get(s.src, { headers: { range: 'bytes=0-1023' } });
  log('file', r.status, r.headers.get('content-type'), r.headers.get('content-range'), (await r.arrayBuffer()).byteLength, 'bytes');
}
await call('phone:progress', s.id, 12, false);
await call('phone:stop', s.id);
await waitFor('phone-end', (e) => e.type === 'phone-end' && e.payload.id === s.id, 10000);
const gone = await get(s.src);
log('after stop, the stream answers', gone.status);
ac.abort();
log('DONE');
