// Reads and adjusts the initialization segment of fragmented MP4 streams for Apple's player:
// the exact codec string an HLS playlist must name, and HEVC labelled the way Apple expects.

/** Calls `visit` for every box; containers are walked into. */
function walk(buf: Buffer, start: number, end: number, visit: (type: string, body: number, end: number) => void) {
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'dinf']);
  // Sample entries: fixed fields before their child boxes (visual 78 bytes, audio 28).
  const ENTRIES: Record<string, number> = { hev1: 78, hvc1: 78, avc1: 78, avc3: 78, mp4a: 28 };
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) return;
    visit(type, at + header, at + size);
    if (CONTAINERS.has(type)) walk(buf, at + header, at + size, visit);
    else if (type === 'stsd') walk(buf, at + header + 8, at + size, visit);
    else if (type in ENTRIES) walk(buf, at + header + ENTRIES[type], at + size, visit);
    at += size;
  }
}

/** The RFC 6381 codec string for the stream's video or audio ("hvc1.1.6.L150.90", "avc1.640028", "mp4a.40.2"). */
export function codecString(init: Buffer): string | null {
  let found: string | null = null;
  walk(init, 0, init.length, (type, body) => {
    if (found) return;
    if (type === 'hvcC' && body + 13 <= init.length) {
      const b = init[body + 1];
      const space = ['', 'A', 'B', 'C'][b >> 6];
      const tier = (b >> 5) & 1 ? 'H' : 'L';
      const profile = b & 31;
      // The compatibility flags are written in reverse bit order.
      let flags = init.readUInt32BE(body + 2);
      let reversed = 0;
      for (let i = 0; i < 32; i++) {
        reversed = (reversed << 1) | (flags & 1);
        flags >>>= 1;
      }
      const constraints = [...init.subarray(body + 6, body + 12)];
      while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
      const level = init[body + 12];
      found = [`hvc1.${space}${profile}`, (reversed >>> 0).toString(16).toUpperCase(), `${tier}${level}`, ...constraints.map((c) => c.toString(16).toUpperCase())].join('.');
    } else if (type === 'avcC' && body + 4 <= init.length) {
      found = `avc1.${[1, 2, 3].map((i) => init[body + i].toString(16).padStart(2, '0')).join('')}`;
    } else if (type === 'esds') {
      // DecoderConfigDescriptor: object type 0x40 (AAC), then the audio object type in its config.
      const at = init.indexOf(Buffer.from([0x04]), body + 4);
      const objectType = at > 0 ? init[at + 2] : 0;
      if (objectType === 0x40) {
        const dsi = init.indexOf(Buffer.from([0x05]), at);
        const aot = dsi > 0 ? init[dsi + 2] >> 3 : 2;
        found = `mp4a.40.${aot || 2}`;
      } else found = 'mp4a.40.2';
    }
  });
  return found;
}

/**
 * HEVC labelled 'hev1' (parameter sets also in the stream) as 'hvc1', which Apple's player
 * requires; the decoder configuration already carries the parameter sets. A copy; others untouched.
 */
export function hvc1(init: Buffer): Buffer {
  const out = Buffer.from(init);
  walk(out, 0, out.length, (type, body) => {
    if (type === 'hev1') out.write('hvc1', body - 4, 'latin1');
  });
  return out;
}
