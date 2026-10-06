// Checks the DASH → HLS conversion on a real manifest and its init segments.
// Usage: esbuild probe/dash-test.ts --bundle --platform=node --outfile=probe/out/dash-test.cjs && node probe/out/dash-test.cjs <dir>
//   <dir> holds lotr.mpd, init0.m4s (video) and init3.m4s (audio), fetched through the engine's relay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isoSeconds, masterPlaylist, mediaPlaylist, parseMpd, parseXml, subtitlePlaylist, type Rendition } from '../src/main/phone/dash';
import { codecString, hvc1 } from '../src/main/phone/mp4';
import { toWebVtt } from '../src/main/phone/subs';

const dir = process.argv[2];
const MPD_URL = 'http://127.0.0.1:62273/https/sbcdn3.hakunaymatata.com/dash/5238552786089955104_0_0_1080_h265_555/index.mpd';

assert.equal(isoSeconds('PT3H48M18.4S'), 3 * 3600 + 48 * 60 + 18.4);
assert.equal(isoSeconds('PT0.0S'), 0);
assert.equal(isoSeconds('P1DT2H'), 26 * 3600);
assert.equal(parseXml('<a x="1&amp;2"><b>t&lt;</b><c/></a>').children[0].attrs.x, '1&2');

const d = parseMpd(fs.readFileSync(path.join(dir, 'lotr.mpd'), 'utf8'), MPD_URL);
const video = d.renditions.filter((r) => r.type === 'video');
const audio = d.renditions.filter((r) => r.type === 'audio');
console.log(`duration ${d.duration}s, ${video.length} video + ${audio.length} audio renditions`);
for (const r of d.renditions) {
  const total = r.segments.reduce((a, s) => a + s.duration, 0);
  console.log(`  ${r.type} ${r.id} ${r.width ?? ''}x${r.height ?? ''} ${r.bandwidth} ${r.codecs} lang=${r.lang ?? ''}: ${r.segments.length} segments, ${total.toFixed(1)}s, init ${r.init}`);
  console.log(`    first ${r.segments[0].url}  last ${r.segments.at(-1)!.url}`);
  assert.ok(Math.abs(total - d.duration) < 10, `${r.id}: segments cover the film`);
}
assert.equal(video[0].segments[0].url, 'http://127.0.0.1:62273/https/sbcdn3.hakunaymatata.com/dash/5238552786089955104_0_0_1080_h265_555/chunk-stream0-00001.m4s');
assert.equal(video[0].init, 'http://127.0.0.1:62273/https/sbcdn3.hakunaymatata.com/dash/5238552786089955104_0_0_1080_h265_555/init-stream0.m4s');

const v0 = fs.readFileSync(path.join(dir, 'init0.m4s'));
const a0 = fs.readFileSync(path.join(dir, 'init3.m4s'));
const vc = codecString(v0);
const ac = codecString(a0);
console.log('codecs', vc, ac);
assert.equal(vc, 'hvc1.1.6.L150.90');
assert.equal(ac, 'mp4a.40.2');
const patched = hvc1(v0);
assert.equal(patched.length, v0.length);
assert.ok(patched.includes(Buffer.from('hvc1')) && !patched.includes(Buffer.from('hev1')), 'hev1 relabelled');
assert.equal(codecString(patched), 'hvc1.1.6.L150.90');

const paths = {
  playlist: (r: Rendition) => `/watch/S/${r.type[0]}/${r.id}.m3u8`,
  init: (r: Rendition) => `/watch/S/init/${r.id}.mp4`,
  segment: (r: Rendition, i: number) => `/watch/S/seg/${r.id}/${i}.m4s`,
};
const master = masterPlaylist(d, (r) => (r.type === 'video' ? vc! : ac!), paths, { uri: '/watch/S/subs.m3u8', name: 'English', lang: 'en' });
console.log('\n' + master);
const media = mediaPlaylist(video[0], paths);
console.log(media.split('\n').slice(0, 12).join('\n') + '\n…\n' + media.split('\n').slice(-4).join('\n'));
assert.ok(master.includes('CODECS="hvc1.1.6.L150.90,mp4a.40.2"'));
assert.ok(media.includes('#EXT-X-ENDLIST') && media.includes('#EXT-X-MAP:URI="/watch/S/init/0.mp4"'));
console.log(subtitlePlaylist('/watch/S/subs.vtt', d.duration));

const vtt = toWebVtt('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:01:02,5 --> 00:01:03,25\r\nTwo\r\nlines\r\n');
console.log(vtt);
assert.ok(vtt.startsWith('WEBVTT') && vtt.includes('00:00:01.000 --> 00:00:02.500') && vtt.includes('00:01:02.500 --> 00:01:03.250'));
console.log('ALL OK');
