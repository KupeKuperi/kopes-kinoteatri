// Startup race check: asks for the Discover categories the moment the TUI first draws, the way the
// GUI does, then runs a long search. Build + run:
//   npx esbuild probe/startup-test.ts --bundle --platform=node --format=cjs --packages=external --outfile=probe/out/startup-test.cjs && node probe/out/startup-test.cjs
import { detectBinary } from '../src/main/binary';
import { CacheIndex } from '../src/main/data/cacheIndex';
import { Driver } from '../src/main/engine/driver';
import { classify } from '../src/main/engine/screen';
import { EngineSession } from '../src/main/engine/session';
import { cacheDir } from '../src/main/paths';

const screenOf = (session: EngineSession) =>
  session
    .screen()
    .text()
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .join('\n');

const main = async () => {
  const bin = await detectBinary();
  if (!bin) process.exit(1);
  const session = new EngineSession(bin.path);
  const t0 = Date.now();
  session.trace = (line) => console.log(`  [${Date.now() - t0} ms] ${line}`);
  const driver = new Driver(session, new CacheIndex(cacheDir()));
  session.start();
  await session.waitFor('start', (s) => classify(s) !== 'unknown', 20000);
  console.log(`first screen: ${classify(session.screen())} after ${Date.now() - t0} ms`);
  try {
    const cats = await driver.browseCategories();
    console.log('categories:', cats.map((c) => c.label).join(' | ') || '(none)');
  } catch (e) {
    console.log('categories FAILED:', (e as Error).message);
    console.log(screenOf(session));
  }
  const query = process.env.Q ?? 'The Lord of the Rings: The Fellowship of the Ring';
  try {
    const r = await driver.search(query);
    console.log(`search "${query}": ${r.total} → ${r.items.map((i) => `${i.title} (${i.year})`).join(' | ')}`);
  } catch (e) {
    console.log('search FAILED:', (e as Error).message);
    console.log(screenOf(session));
  }
  await session.stop();
  process.exit(0);
};

void main();
