// Engine installer check against fake releases (no real download): fetch serves locally built
// archives + SHA256SUMS, and the program is installed into a temp folder.
//   npx esbuild probe/install-engine-test.ts --bundle --platform=node --format=cjs --packages=external --outfile=probe/out/install-engine-test.cjs
//   node probe/out/install-engine-test.cjs <temp dir> <windows .zip> <macOS .tar.gz> <the program's original bytes>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { installEngine } from '../src/main/tools';

const [tmp, zipPath, tarPath, originalPath] = process.argv.slice(2);
const original = fs.readFileSync(originalPath);

const fakeFetch = (asset: string, archive: Buffer, good: boolean) => async (url: string) => {
  const sha = crypto.createHash('sha256').update(archive).digest('hex');
  if (url.endsWith('/SHA256SUMS')) return new Response(`${good ? sha : '0'.repeat(64)}  ${asset}\nabc  other.zip\n`);
  if (url.endsWith(`/${asset}`)) return new Response(archive);
  return new Response('not found', { status: 404 });
};

const check = async (label: string, platform: NodeJS.Platform, asset: string, archivePath: string) => {
  const archive = fs.readFileSync(archivePath);
  const dir = path.join(tmp, label);
  try {
    await installEngine(fakeFetch(asset, archive, false), () => undefined, { platform, arch: 'arm64', dir });
    console.log(`${label}: BAD, a wrong checksum installed anyway`);
  } catch (e) {
    console.log(`${label}: wrong checksum → ${(e as Error).message} | written: ${fs.existsSync(dir) && fs.readdirSync(dir).length > 0}`);
  }
  const steps: string[] = [];
  const exe = await installEngine(fakeFetch(asset, archive, true), (s) => steps.push(s), { platform, arch: 'arm64', dir });
  console.log(`${label}: installed ${path.basename(exe)} | same bytes: ${Buffer.compare(fs.readFileSync(exe), original) === 0} | steps: ${steps.join(' → ')}`);
};

const main = async () => {
  await check('windows', 'win32', 'MovieBox_Windows_arm64.zip', zipPath);
  await check('macos', 'darwin', 'MovieBox_macOS_Universal.tar.gz', tarPath);
};

void main();
