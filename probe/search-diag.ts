// Diagnoses search: timing of every engine step, and whether the text that
// reaches the TUI's search box is exactly what was typed.
// Build + run: npx esbuild probe/search-diag.ts --bundle --platform=node --format=cjs --packages=external --outfile=probe/out/search-diag.cjs && node probe/out/search-diag.cjs
import { detectBinary } from '../src/main/binary';
import { CacheIndex } from '../src/main/data/cacheIndex';
import { readTuiConfigRaw, setActiveMode } from '../src/main/data/config';
import { Driver } from '../src/main/engine/driver';
import { classify, parseInput } from '../src/main/engine/screen';
import { EngineSession } from '../src/main/engine/session';
import { cacheDir } from '../src/main/paths';

const QUERIES = (process.env.QUERIES ?? 'Breaking Bad|the boys|Spider-Man: No Way Home|squid game 2|one piece').split('|');

const main = async () => {
  const bin = await detectBinary();
  if (!bin) throw new Error('no binary');
  const mode = readTuiConfigRaw()?.active_mode as string;
  const session = new EngineSession(bin.path);
  const t0 = Date.now();
  session.trace = (l) => console.log(`  [${String(Date.now() - t0).padStart(6)}] ${l}`);
  const driver = new Driver(session, new CacheIndex(cacheDir()));
  session.start();
  await session.waitFor('start', (s) => classify(s) !== 'unknown', 20000);
  try {
    for (const q of QUERIES) {
      console.log(`\n=== search "${q}"`);
      const start = Date.now();
      try {
        const r = await driver.search(q);
        const box = parseInput(session.screen())?.text;
        console.log(`  → ${r.items.length} results in ${Date.now() - start} ms; TUI box: "${box}" ${box === q ? 'MATCH' : 'MISMATCH'}`);
        console.log(`  → ${r.items.slice(0, 5).map((i) => `${i.title} (${i.year})`).join(', ')}`);
      } catch (e) {
        console.log(`  ✗ ${String(e)} after ${Date.now() - start} ms`);
        console.log(session.screen().text().split('\n').filter((l) => l.trim()).slice(0, 6).join('\n'));
      }
    }
    if (process.env.BROWSE !== '0') {
      console.log('\n=== browse "Trending Now"');
      const start = Date.now();
      const r = await driver.browse(0);
      console.log(`  → ${r.items.length} items (total ${r.total}) in ${Date.now() - start} ms`);
    }
  } finally {
    await session.stop();
    if (mode) setActiveMode(mode);
  }
};
void main();
