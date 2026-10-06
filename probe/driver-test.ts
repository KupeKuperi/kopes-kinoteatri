// Headless end-to-end check of the engine driver against the real TUI.
// Build + run: see `npm run probe:driver` (bundled with esbuild, no Electron).
import fs from 'node:fs';
import { detectBinary } from '../src/main/binary';
import { CacheIndex } from '../src/main/data/cacheIndex';
import { readTuiConfigRaw, setActiveMode } from '../src/main/data/config';
import { Driver } from '../src/main/engine/driver';
import { classify } from '../src/main/engine/screen';
import { EngineSession } from '../src/main/engine/session';
import { cacheDir, configFile } from '../src/main/paths';

const step = process.argv[2] ?? 'all';
const log = (label: string, v: unknown) => console.log(`\n=== ${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`);
const short = (o: any) => JSON.stringify(o, (k, v) => (k === 'cover' && typeof v === 'string' ? v.slice(0, 40) + '…' : v));

const main = async () => {
  const bin = await detectBinary();
  log('binary', bin);
  if (!bin) process.exit(1);
  const mode = readTuiConfigRaw()?.active_mode as string;
  const session = new EngineSession(bin.path);
  const driver = new Driver(session, new CacheIndex(cacheDir()));
  driver.on('activity', (a) => a && console.log(`  … ${a}`));
  driver.on('results', (v) => console.log(`  (enriched: ${v.items.filter((i: any) => i.rating).length} ratings)`));
  session.start();
  await session.waitFor('start', (s) => classify(s) !== 'unknown', 20000);
  try {
    const t0 = Date.now();
    const results = await driver.search(process.env.Q ?? 'dune');
    log(`search (${Date.now() - t0} ms)`, results.items.map(short).join('\n'));

    if (step === 'all' || step === 'details') {
      const t1 = Date.now();
      const view = await driver.open(Number(process.env.IDX ?? 0));
      log(`open (${Date.now() - t1} ms)`, { ...view, info: view.info && { ...view.info, seasons: view.info.seasons.map((s) => `${s.season}:${s.episodes.length}`) } });
      if (view.info?.kind === 'series' && view.state.streamsStatus !== 'choose-audio') {
        const t2 = Date.now();
        const ep = await driver.selectEpisode(view.current?.season ?? 1, 2);
        log(`episode 2 (${Date.now() - t2} ms)`, { current: ep.current, status: ep.state.streamsStatus, streams: ep.streams });
      }
      if (step === 'all') {
        const fav = await driver.toggleFavorite();
        log('favorite on', { favorite: fav.state.favorite, file: fs.readFileSync(configFile('favorites.json'), 'utf8') });
        const unfav = await driver.toggleFavorite();
        log('favorite off', { favorite: unfav.state.favorite, file: fs.readFileSync(configFile('favorites.json'), 'utf8') });
      }
    }
    if (step === 'all' || step === 'browse') {
      log('categories', await driver.browseCategories());
      log('providers', await driver.listProviders());
    }
  } catch (e) {
    log('ERROR', String(e));
    log('screen', session.screen().text().split('\n').filter((l) => l.trim()).join('\n'));
  } finally {
    await session.stop();
    if (mode) setActiveMode(mode);
  }
};
void main();
