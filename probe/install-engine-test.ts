// Engine installer check against a fake release (no real download): LOCALAPPDATA points at a temp
// folder, fetch serves a locally built zip + SHA256SUMS.
//   npx esbuild probe/install-engine-test.ts --bundle --platform=node --format=cjs --packages=external --outfile=probe/out/install-engine-test.cjs && node probe/out/install-engine-test.cjs <temp dir> <zip>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [tmp, zipPath] = process.argv.slice(2);
process.env.LOCALAPPDATA = path.join(tmp, 'Local');

const main = async () => {
  const { installEngine, engineDir } = await import('../src/main/tools');
  const zip = fs.readFileSync(zipPath);
  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  const asset = `MovieBox_Windows_${process.arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
  const fakeFetch = (good: boolean) => async (url: string) => {
    if (url.endsWith('/SHA256SUMS')) return new Response(`${good ? sha : '0'.repeat(64)}  ${asset}\nabc  other.zip\n`);
    if (url.endsWith(`/${asset}`)) return new Response(zip);
    return new Response('not found', { status: 404 });
  };
  const steps: string[] = [];
  try {
    await installEngine(fakeFetch(false), (s) => steps.push(s));
    console.log('BAD: a wrong checksum installed anyway');
  } catch (e) {
    console.log('wrong checksum →', (e as Error).message, '| written:', fs.existsSync(path.join(engineDir(), 'moviebox-tui.exe')));
  }
  const exe = await installEngine(fakeFetch(true), (s) => steps.push(s));
  console.log('installed to', exe, '| same bytes:', Buffer.compare(fs.readFileSync(exe), fs.readFileSync(path.join(path.dirname(zipPath), 'moviebox-tui.exe'))) === 0);
  console.log('steps:', [...new Set(steps)].join(' → '));
};

void main();
