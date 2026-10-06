// Checks the Georgian dictionary against the code: every t('…') / tn('…') key the renderer uses
// must have a Georgian entry, and JSX text that never went through t() is listed for review.
// Usage: node probe/i18n-check.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../src/renderer/src');
const dictSource = fs.readFileSync(path.join(root, 'lib/i18n-ka.ts'), 'utf8');

// Keys of the KA object: 'x': …, "x": … or bare identifiers.
const keys = new Set();
const keyRe = /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_][\w]*))\s*:/gm;
for (const m of dictSource.matchAll(keyRe)) {
  const raw = m[1] ?? m[2] ?? m[3];
  keys.add(raw.replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1'));
}

const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|ts)$/.test(e.name) && !e.name.startsWith('i18n')) files.push(p);
  }
};
walk(root);

let missing = 0;
const untranslated = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file);
  // t('…') / tn('…') with a literal first argument (single, double or back-quoted without ${}).
  for (const m of src.matchAll(/\bt[n]?\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$]*)`)/g)) {
    const key = (m[1] ?? m[2] ?? m[3]).replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1');
    if (!keys.has(key)) {
      missing++;
      console.log(`MISSING  ${rel}: ${JSON.stringify(key)}`);
    }
  }
  // Text between JSX tags that looks like English words and isn't an expression.
  for (const m of src.matchAll(/>\s*([A-Z][a-z]+(?:[ ,.'’:;-]+[A-Za-z]+)+[.?!]?)\s*</g)) untranslated.push(`${rel}: ${m[1]}`);
  // Attributes with English text.
  for (const m of src.matchAll(/\b(title|placeholder|aria-label|label|hint|note)="([A-Z][^"]{2,})"/g)) {
    // Settings' Group and PathField translate their title, note and label themselves.
    if (rel.endsWith('Settings.tsx') && ['title', 'note', 'label'].includes(m[1])) {
      if (!keys.has(m[2])) {
        missing++;
        console.log(`MISSING  ${rel}: ${JSON.stringify(m[2])}`);
      }
    } else untranslated.push(`${rel}: ${m[1]}="${m[2]}"`);
  }
}
// Constant tables that are translated at render time (labels passed through t()).
for (const [file, re] of [
  ['components/Sidebar.tsx', /label: '([^']+)'/g],
  ['components/Shortcuts.tsx', /\['([^']+)', \[|, '([^']+)'\]/g],
  ['screens/Home.tsx', /(?:label|eyebrow): '([^']+)'/g],
  ['screens/Settings.tsx', /^\s+(?:\w+|'[^']+'): '([^']+)',$/gm],
]) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  for (const m of src.matchAll(re)) {
    const key = m[1] ?? m[2];
    if (key && !keys.has(key) && !/^(MovieBox|4KHDHub)$/.test(key)) {
      missing++;
      console.log(`MISSING  ${file} (table): ${JSON.stringify(key)}`);
    }
  }
}
console.log(untranslated.length ? `\nJSX text not passed through t():\n  ${untranslated.join('\n  ')}` : '\nNo untranslated JSX text found.');
console.log(`\n${keys.size} dictionary entries, ${missing} missing.`);
process.exit(missing ? 1 : 0);
