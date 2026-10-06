// Keystroke encoding for the TUI's pseudo-terminal.
//
// On Windows the TUI (crossterm) re-maps control characters through the
// *foreground window's keyboard layout*: with a non-Latin layout active, a raw
// Ctrl+U (0x15) arrives as a letter of that layout instead of Ctrl+U. ConPTY's
// win32-input-mode lets us send the exact key event, and crossterm uses a
// printable u_char verbatim, so Ctrl+<letter> is sent as `letter + Ctrl held`.

const SCAN: Record<string, number> = {
  a: 0x1e, b: 0x30, c: 0x2e, d: 0x20, e: 0x12, f: 0x21, g: 0x22, h: 0x23, i: 0x17, j: 0x24, k: 0x25, l: 0x26, m: 0x32,
  n: 0x31, o: 0x18, p: 0x19, q: 0x10, r: 0x13, s: 0x1f, t: 0x14, u: 0x16, v: 0x2f, w: 0x11, x: 0x2d, y: 0x15, z: 0x2c,
};
const LEFT_CTRL_PRESSED = 0x08;

const NAMED: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
  delete: '\x1b[3~',
  backspace: '\x7f',
  space: ' ',
};

export type KeyName = keyof typeof NAMED | `ctrl+${string}`;

function win32Ctrl(letter: string): string {
  const vk = letter.toUpperCase().charCodeAt(0);
  const uc = letter.charCodeAt(0);
  const sc = SCAN[letter];
  return `\x1b[${vk};${sc};${uc};1;${LEFT_CTRL_PRESSED};1_\x1b[${vk};${sc};${uc};0;${LEFT_CTRL_PRESSED};1_`;
}

/** A lone ESC byte is ambiguous in VT input (ConPTY may fold it into an Alt sequence). */
const WIN32_ESC = '\x1b[27;1;27;1;0;1_\x1b[27;1;27;0;0;1_';

export function encodeKey(key: string): string {
  if (key === 'esc' && process.platform === 'win32') return WIN32_ESC;
  const named = NAMED[key];
  if (named) return named;
  const ctrl = /^ctrl\+([a-z])$/.exec(key);
  if (ctrl) {
    const letter = ctrl[1];
    return process.platform === 'win32' ? win32Ctrl(letter) : String.fromCharCode(letter.charCodeAt(0) - 96);
  }
  return key; // a literal character
}

/**
 * Re-encodes raw input typed into the engine console (xterm.js) so control
 * keys survive the same keyboard-layout problem.
 */
export function encodeConsoleInput(data: string): string {
  if (process.platform !== 'win32') return data;
  let out = '';
  for (const ch of data) {
    const code = ch.charCodeAt(0);
    // Ctrl+A..Ctrl+Z, except Tab (9), Enter (13) and Backspace (8) which are keys of their own.
    if (code >= 1 && code <= 26 && code !== 8 && code !== 9 && code !== 13) out += win32Ctrl(String.fromCharCode(code + 96));
    else out += ch;
  }
  return out;
}
