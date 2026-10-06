// Does the TUI keep writing while idle on the home screen with text in the box? Logs output chunks for 3 s.
//   npx esbuild probe/output-rate.ts --bundle --platform=node --format=cjs --packages=external --outfile=probe/out/output-rate.cjs && node probe/out/output-rate.cjs
import { detectBinary } from '../src/main/binary';
import { classify } from '../src/main/engine/screen';
import { EngineSession } from '../src/main/engine/session';

const main = async () => {
  const bin = await detectBinary();
  if (!bin) process.exit(1);
  const session = new EngineSession(bin.path);
  session.start();
  await session.waitFor('start', (s) => classify(s) !== 'unknown', 20000);
  await session.idle(250, 2500);
  await session.waitFor('home', (s) => classify(s) === 'home', 5000);
  const t0 = Date.now();
  const chunks: string[] = [];
  session.on('data', (d: string) => chunks.push(`[${Date.now() - t0} ms] ${d.length} bytes ${JSON.stringify(d.slice(0, 50))}`));
  await session.type(process.env.Q ?? 'The Lord of the Rings: The Fellowship of the Ring');
  await new Promise((r) => setTimeout(r, 3000));
  console.log(chunks.slice(-30).join('\n'));
  console.log(`${chunks.length} chunks in 3 s`);
  await session.stop();
  process.exit(0);
};

void main();
