// For search results without a poster, shows what the TUI's caches hold for
// that title — to see why the lookup misses.
import fs from 'node:fs';
import path from 'node:path';
import { decode } from '@msgpack/msgpack';
import { detectBinary } from '../src/main/binary';
import { CacheIndex, normalizeTitle } from '../src/main/data/cacheIndex';
import { readTuiConfigRaw, setActiveMode } from '../src/main/data/config';
import { Driver } from '../src/main/engine/driver';
import { classify } from '../src/main/engine/screen';
import { EngineSession } from '../src/main/engine/session';
import { dataDir } from '../src/main/paths';

const QUERIES = (process.env.QUERIES ?? 'the office|dune|avatar|naruto').split('|');

// Every item in every search/homepage cache file, raw.
function allCached() {
  const out: Array<{ file: string; title: string; kind: string; year: string; cover: boolean }> = [];
  for (const sub of ['search', 'homepage']) {
    const dir = path.join(dataDir(), 'moviebox', sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      try {
        const v = decode(fs.readFileSync(path.join(dir, f)).subarray(4)) as unknown[];
        const payload = v[2] as unknown[];
        const items = (sub === 'homepage' ? payload[0] : payload) as unknown[][];
        for (const it of items) out.push({ file: `${sub}/${f}`, title: String(it[1]), kind: String(it[2]), year: String(it[3]), cover: Boolean(it[4]) });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

const main = async () => {
  const bin = await detectBinary();
  if (!bin) throw new Error('no binary');
  const mode = readTuiConfigRaw()?.active_mode as string;
  const session = new EngineSession(bin.path);
  const driver = new Driver(session, new CacheIndex(dataDir()));
  session.start();
  await session.waitFor('start', (s) => classify(s) !== 'unknown', 20000);
  try {
    for (const q of QUERIES) {
      const r = await driver.search(q);
      await new Promise((res) => setTimeout(res, 4500)); // let the TUI prefetch details
      const cached = allCached();
      // What the app shows after its delayed enrichment (posters arriving later).
      const shown = ((driver as any).results?.view?.items ?? r.items) as typeof r.items;
      console.log(`   at first: ${r.items.filter((i) => i.cover).length}/${r.items.length}, after enrichment: ${shown.filter((i) => i.cover).length}/${shown.length}`);
      const missing = shown.filter((i) => !i.cover);
      console.log(`\n=== "${q}": ${r.items.length - missing.length}/${r.items.length} posters`);
      for (const m of missing) {
        const cands = cached.filter((c) => normalizeTitle(c.title) === normalizeTitle(m.title));
        console.log(`  ✗ ${m.title} (${m.year}, ${m.type}) — cache has: ${cands.map((c) => `"${c.title}" ${c.year} ${c.kind}${c.cover ? '' : ' NO-COVER'} [${c.file.split('/')[0]}]`).join('; ') || 'nothing with that title'}`);
      }
    }
  } finally {
    await session.stop();
    if (mode) setActiveMode(mode);
  }
};
void main();
