// Packages the built app (out/) into a standalone Windows app: dist/KopesKinoteatri-win32-x64/KopesKinoteatri.exe.
// Run via `npm run package` (which builds first).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Only out/ (the compiled app), package.json and production dependencies ship.
const SKIP = [
  /^\/(src|probe|docs|scripts|build|dist|dist-next|\.github|\.git)(\/|$)/,
  /^\/(tsconfig[^/]*|electron\.vite\.config\.ts|electron-builder\.yml|README\.md|LICENSE|\.gitignore|\.gitattributes)$/,
  /\.pdb$/,
];

// The production dependency tree, as npm resolves it (the renderer's libraries are bundled into out/).
function productionDirs() {
  let stdout;
  try {
    stdout = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8' });
  } catch (e) {
    stdout = e.stdout ?? ''; // npm exits non-zero for extraneous packages but still lists the tree
  }
  return stdout
    .split(/\r?\n/)
    .map((p) => path.relative(root, p.trim()).split(path.sep).join('/'))
    .filter((p) => p.startsWith('node_modules/'))
    .map((p) => '/' + p);
}
const prod = productionDirs();
const isProduction = (file) => prod.some((d) => file === d || file.startsWith(d + '/') || d.startsWith(file + '/'));
const skip = (file) => SKIP.some((re) => re.test(file)) || (file.startsWith('/node_modules/') && !isProduction(file));
console.log(`Production dependencies: ${prod.map((d) => d.replace('/node_modules/', '')).join(', ')}`);

const [appDir] = await packager({
  dir: root,
  // PACKAGE_OUT lets a new build be staged next to a copy that is still running.
  out: process.env.PACKAGE_OUT ? path.resolve(root, process.env.PACKAGE_OUT) : path.join(root, 'dist'),
  name: 'KopesKinoteatri',
  executableName: 'KopesKinoteatri',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  prune: false, // done by `skip` below, from npm's own dependency tree
  icon: path.join(root, 'build', 'icon.ico'),
  appVersion: pkg.version,
  win32metadata: {
    ProductName: "Kope's Kinoteatri",
    FileDescription: "Kope's Kinoteatri",
    InternalName: 'KopesKinoteatri',
    CompanyName: 'KupeKuperi',
  },
  // The terminal library loads native .node files, OpenConsole.exe and a worker
  // script from disk, so it must live outside the asar archive.
  asar: { unpackDir: 'node_modules/@lydell' },
  ignore: skip,
});

// Chromium's UI translations (~48 MB) are unused by this app; keep the en-US fallback only.
const locales = path.join(appDir, 'locales');
for (const f of fs.readdirSync(locales)) if (f !== 'en-US.pak') fs.rmSync(path.join(locales, f));

console.log(`Packaged: ${path.join(appDir, 'KopesKinoteatri.exe')}`);
