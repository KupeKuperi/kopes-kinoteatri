// Decode moviebox-tui MBC1 cache files (magic + msgpack [version, expiresAt, payload]).
// Usage: node probe/decode.mjs <file...>   — long strings are truncated.
import { decode } from '@msgpack/msgpack';
import fs from 'node:fs';

const trunc = (v) => {
  if (typeof v === 'string') return v.length > 70 ? v.slice(0, 70) + '…' : v;
  if (typeof v === 'bigint') return v.toString() + 'n';
  if (Array.isArray(v)) return v.map(trunc);
  if (v instanceof Uint8Array) return `<bin ${v.length}>`;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trunc(x)]));
  return v;
};
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f);
  console.log('=====', f.split(/[\\/]/).slice(-2).join('/'), 'magic=', buf.subarray(0, 4).toString());
  const v = decode(buf.subarray(4), { useBigInt64: true });
  console.log(JSON.stringify(trunc(v), null, 1).slice(0, 4000));
}
