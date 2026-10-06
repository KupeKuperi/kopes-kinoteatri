// electron-builder afterPack hook (macOS): makes the terminal library's helper executable and signs
// the app ad hoc. Without an Apple Developer ID there is no real signature; an ad-hoc one still
// lets macOS run the app after "Open Anyway", while an unsigned Apple Silicon app is "damaged".
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function walk(dir, visit) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, visit);
    else visit(p);
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked');
  // node-pty starts shells through `spawn-helper`, which loses its executable bit in some installs.
  if (fs.existsSync(unpacked)) {
    walk(unpacked, (p) => {
      if (path.basename(p) === 'spawn-helper') fs.chmodSync(p, 0o755);
    });
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${path.basename(app)}`);
};
