// Probe harness: runs moviebox-tui in a hidden pty, replays a scenario of
// keystrokes and dumps the rendered screen after each step.
// Usage: node probe/probe.mjs probe/scenarios/<name>.json
import { spawn } from '@lydell/node-pty';
import xtermHeadless from '@xterm/headless';
import fs from 'node:fs';
import path from 'node:path';

const { Terminal } = xtermHeadless;
// The engine where its own installer puts it (override with MOVIEBOX_TUI=<path>).
const BIN = process.env.MOVIEBOX_TUI ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'MovieBox-Tui', 'bin', 'moviebox-tui.exe');
const COLS = Number(process.env.COLS ?? 160), ROWS = Number(process.env.ROWS ?? 48);

const scenarioPath = process.argv[2];
const steps = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const outDir = path.join(path.dirname(scenarioPath), '..', 'out', path.basename(scenarioPath, '.json'));
fs.mkdirSync(outDir, { recursive: true });

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const pty = spawn(BIN, [], {
  name: 'xterm-256color', cols: COLS, rows: ROWS,
  env: { ...process.env, MOVIEBOX_NO_IMAGE: '1', MOVIEBOX_IMAGE_PROTOCOL: 'none', TERM: 'xterm-256color' },
});
let raw = '';
let cursorVisible = true;
pty.onData((d) => {
  raw += d;
  // DECTCEM: the TUI shows the cursor only inside a focused text input.
  const show = d.lastIndexOf('\x1b[?25h'), hide = d.lastIndexOf('\x1b[?25l');
  if (show !== hide) cursorVisible = show > hide;
  term.write(d);
});
// xterm answers terminal queries (DA, cursor position) — forward them back to the app.
term.onData((d) => pty.write(d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Rows whose cells carry a non-default background are marked with '█▌' so the
// highlighted (selected) row is visible in the dump.
const screen = () => {
  const b = term.buffer.active; const lines = [];
  const cell = b.getNullCell();
  for (let i = 0; i < ROWS; i++) {
    const line = b.getLine(b.viewportY + i);
    if (!line) { lines.push(''); continue; }
    let bg = 0, inv = 0, bold = 0;
    for (let x = 0; x < COLS; x++) {
      line.getCell(x, cell);
      if (!cell.getChars().trim()) continue;
      if (!cell.isBgDefault()) bg++;
      if (cell.isInverse()) inv++;
      if (cell.isBold()) bold++;
    }
    const tag = (bg > 3 ? 'B' : '.') + (inv > 3 ? 'I' : '.') + (bold > 3 ? 'b' : '.');
    lines.push(tag + ' ' + line.translateToString(true));
  }
  return lines.join('\n');
};
const KEYS = { enter: '\r', esc: '\x1b', tab: '\t', 'shift+tab': '\x1b[Z', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~', bs: '\x7f', space: ' ',
  'ctrl+s': '\x13', 'ctrl+t': '\x14', 'ctrl+p': '\x10', 'ctrl+u': '\x15', 'ctrl+w': '\x17', 'ctrl+c': '\x03' };

// win32-input-mode: CSI Vk;Sc;Uc;Kd;Cs;Rc _  — exact key events, layout-independent.
// Uc carries the plain Latin letter: crossterm re-maps control chars (< 0x20)
// through the foreground keyboard layout, but uses printable u_char verbatim.
const W32 = { 'ctrl+u': [0x55, 0x16, 0x75], 'ctrl+t': [0x54, 0x14, 0x74], 'ctrl+s': [0x53, 0x1f, 0x73], 'ctrl+p': [0x50, 0x19, 0x70], 'ctrl+w': [0x57, 0x11, 0x77] };
const w32 = ([vk, sc, uc], cs = 0x08) => `\x1b[${vk};${sc};${uc};1;${cs};1_\x1b[${vk};${sc};${uc};0;${cs};1_`;
if (process.env.W32) {
  for (const [k, v] of Object.entries(W32)) KEYS[k] = w32(v);
  KEYS.esc = w32([0x1b, 0x01, 0x1b], 0);
}

let n = 0;
for (const s of steps) {
  if (s.wait) await sleep(s.wait);
  if (s.until) {
    const re = new RegExp(s.until); const t = Date.now();
    while (!re.test(screen()) && Date.now() - t < (s.timeout ?? 15000)) await sleep(150);
    if (!re.test(screen())) console.log(`!! timeout waiting for /${s.until}/`);
    await sleep(300);
  }
  if (s.type) { for (const ch of s.type) { pty.write(ch); await sleep(25); } }
  if (s.key) { for (let i = 0; i < (s.repeat ?? 1); i++) { pty.write(KEYS[s.key] ?? s.key); await sleep(80); } }
  if (s.dump) {
    n++;
    const f = path.join(outDir, `${String(n).padStart(2, '0')}-${s.dump}.txt`);
    const cur = `[cursor ${cursorVisible ? 'VISIBLE' : 'hidden'} at x=${term.buffer.active.cursorX} y=${term.buffer.active.cursorY}]`;
    fs.writeFileSync(f, cur + '\n' + screen());
    console.log(`--- ${s.dump} ${cur}\n${screen().split('\n').filter((l) => l.trim()).join('\n')}\n`);
  }
}
fs.writeFileSync(path.join(outDir, 'raw.log'), raw);
pty.write('\x03');
await sleep(500);
try { pty.kill(); } catch {}
process.exit(0);
