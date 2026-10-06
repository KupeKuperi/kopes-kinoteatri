// How long does the TUI's startup size overlay ("110 × 80") last? Logs each change of screen kind.
//   npx esbuild probe/overlay-timing.ts --bundle --platform=node --format=cjs --packages=external --outfile=probe/out/overlay-timing.cjs && node probe/out/overlay-timing.cjs
import { detectBinary } from '../src/main/binary';
import { classify } from '../src/main/engine/screen';
import { EngineSession } from '../src/main/engine/session';

const main = async () => {
  const bin = await detectBinary();
  if (!bin) process.exit(1);
  const session = new EngineSession(bin.path);
  const t0 = Date.now();
  let last = '';
  session.on('render', () => {
    const s = session.screen();
    const kind = classify(s);
    const text = s.text().split('\n').map((l) => l.trim()).filter(Boolean);
    const sig = `${kind} | ${text.length} lines | ${text.length <= 2 ? text.join(' / ') : text[text.length - 1].slice(0, 60)}`;
    if (sig !== last) console.log(`[${Date.now() - t0} ms] ${sig}`);
    last = sig;
  });
  session.start();
  await new Promise((r) => setTimeout(r, Number(process.env.MS ?? 6000)));
  await session.stop();
  process.exit(0);
};

void main();
