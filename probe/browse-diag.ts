// Opens each /browse category through the driver and records what the TUI
// actually selected, the list it shows, and which homepage cache it wrote.
import fs from 'node:fs';
import path from 'node:path';
import { detectBinary } from '../src/main/binary';
import { CacheIndex } from '../src/main/data/cacheIndex';
import { readTuiConfigRaw, setActiveMode } from '../src/main/data/config';
import { Driver } from '../src/main/engine/driver';
import { classify, parseInput } from '../src/main/engine/screen';
import { EngineSession } from '../src/main/engine/session';
import { dataDir } from '../src/main/paths';

const homeDir = path.join(dataDir(), 'moviebox', 'homepage');
const files = () => (fs.existsSync(homeDir) ? fs.readdirSync(homeDir).map((f) => `${f}@${fs.statSync(path.join(homeDir, f)).mtimeMs | 0}`) : []);

const main = async () => {
  const bin = await detectBinary();
  if (!bin) throw new Error('no binary');
  const mode = readTuiConfigRaw()?.active_mode as string;
  const session = new EngineSession(bin.path);
  const driver = new Driver(session, new CacheIndex(dataDir()));
  // Log the browse menu's selection line every time the driver presses a key in it.
  session.trace = (l) => {
    const m = /╭ Browse · (\d+)\/(\d+)/.exec(session.screen().text());
    if (m) console.log(`    ${l}  → menu at ${m[1]}/${m[2]}`);
  };
  session.start();
  await session.waitFor('start', (s) => classify(s) !== 'unknown', 20000);
  try {
    const cats = await driver.browseCategories();
    console.log('categories:', cats.map((c) => `${c.index}:${c.label}`).join(' | '));
    for (const c of cats) {
      const before = new Set(files());
      const t = Date.now();
      const view = await driver.browse(c.index);
      const header = parseInput(session.screen());
      const written = files().filter((f) => !before.has(f));
      console.log(`\n=== ${c.index} ${c.label}: ${view.items.length} items in ${Date.now() - t} ms; TUI header "${header?.text}" [${header?.label}]; cache written: ${written.join(', ') || 'none'}`);
      console.log('   ' + view.items.slice(0, 6).map((i) => `${i.title} (${i.year}${i.rating ? ' ★' + i.rating : ''})${i.cover ? '' : ' [no poster]'}`).join(' | '));
      console.log(`   posters: ${view.items.filter((i) => i.cover).length}/${view.items.length}`);
    }
  } finally {
    await session.stop();
    if (mode) setActiveMode(mode);
  }
};
void main();
