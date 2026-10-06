//! Reads and adjusts the initialization segment of fragmented MP4 streams for Apple's player: the
//! exact codec string an HLS playlist must name, and HEVC labelled the way Apple expects. Port of
//! mp4.ts.

/// Boxes that only hold other boxes.
const CONTAINERS: [&[u8; 4]; 8] = [b"moov", b"trak", b"mdia", b"minf", b"stbl", b"mvex", b"edts", b"dinf"];

/// Real files nest boxes a few levels deep (moov/trak/mdia/minf/stbl/stsd/entry); a deeper one
/// is broken or hostile, and isn't walked.
const MAX_DEPTH: usize = 16;

/// Sample entries: fixed fields before their child boxes (visual 78 bytes, audio 28).
fn entry_fields(kind: &[u8; 4]) -> Option<usize> {
    match kind {
        b"hev1" | b"hvc1" | b"avc1" | b"avc3" => Some(78),
        b"mp4a" => Some(28),
        _ => None,
    }
}

/// One box as `walk` sees it: its type, where it starts, where its body starts, where it ends.
struct Mp4Box {
    kind: [u8; 4],
    start: usize,
    body: usize,
}

/// Calls `visit` for every box in `buf[start..end]`; containers are walked into.
fn walk(buf: &[u8], start: usize, end: usize, depth: usize, visit: &mut dyn FnMut(&Mp4Box)) {
    if depth > MAX_DEPTH {
        return;
    }
    let mut at = start;
    while at + 8 <= end {
        let word = |i: usize| buf.get(i..i + 4).and_then(|b| b.try_into().ok()).map(u32::from_be_bytes);
        let (Some(size), Some(kind)) = (word(at), buf.get(at + 4..at + 8).and_then(|b| <[u8; 4]>::try_from(b).ok())) else {
            return;
        };
        let (size, header) = match size {
            1 => match buf.get(at + 8..at + 16).and_then(|b| b.try_into().ok()).map(u64::from_be_bytes) {
                Some(large) => (large, 16),
                None => return,
            },
            0 => ((end - at) as u64, 8),
            n => (u64::from(n), 8),
        };
        if size < header || size > (end - at) as u64 {
            return;
        }
        let box_end = at + size as usize;
        let header = header as usize;
        visit(&Mp4Box { kind, start: at, body: at + header });
        if CONTAINERS.contains(&&kind) {
            walk(buf, at + header, box_end, depth + 1, visit);
        } else if &kind == b"stsd" {
            walk(buf, at + header + 8, box_end, depth + 1, visit);
        } else if let Some(fields) = entry_fields(&kind) {
            walk(buf, at + header + fields, box_end, depth + 1, visit);
        }
        at = box_end;
    }
}

/// The RFC 6381 codec string for the stream's video or audio ("hvc1.1.6.L150.90", "avc1.640028",
/// "mp4a.40.2").
pub fn codec_string(init: &[u8]) -> Option<String> {
    let mut found: Option<String> = None;
    walk(init, 0, init.len(), 0, &mut |b| {
        if found.is_some() {
            return;
        }
        let body = b.body;
        match &b.kind {
            b"hvcC" if body + 13 <= init.len() => {
                let p = init[body + 1];
                let space = ["", "A", "B", "C"][usize::from(p >> 6)];
                let tier = if (p >> 5) & 1 == 1 { 'H' } else { 'L' };
                let profile = p & 31;
                // The compatibility flags are written in reverse bit order.
                let flags = u32::from_be_bytes([init[body + 2], init[body + 3], init[body + 4], init[body + 5]]).reverse_bits();
                let mut constraints = init[body + 6..body + 12].to_vec();
                while constraints.last() == Some(&0) {
                    constraints.pop();
                }
                let level = init[body + 12];
                let mut parts = vec![format!("hvc1.{space}{profile}"), format!("{flags:X}"), format!("{tier}{level}")];
                parts.extend(constraints.iter().map(|c| format!("{c:X}")));
                found = Some(parts.join("."));
            }
            b"avcC" if body + 4 <= init.len() => {
                found = Some(format!("avc1.{:02x}{:02x}{:02x}", init[body + 1], init[body + 2], init[body + 3]));
            }
            b"esds" => {
                // DecoderConfigDescriptor: object type 0x40 (AAC), then the audio object type in its config.
                let find = |byte: u8, from: usize| init.get(from..)?.iter().position(|&x| x == byte).map(|i| i + from);
                let config = find(0x04, body + 4);
                let object_type = config.and_then(|at| init.get(at + 2).copied());
                found = Some(match (config, object_type) {
                    (Some(at), Some(0x40)) => {
                        let aot = find(0x05, at).and_then(|dsi| init.get(dsi + 2)).map_or(0, |b| b >> 3);
                        format!("mp4a.40.{}", if aot == 0 { 2 } else { aot })
                    }
                    _ => "mp4a.40.2".into(),
                });
            }
            _ => {}
        }
    });
    found
}

/// HEVC labelled 'hev1' (parameter sets also in the stream) as 'hvc1', which Apple's player
/// requires; the decoder configuration already carries the parameter sets. A copy; others untouched.
pub fn hvc1(init: &[u8]) -> Vec<u8> {
    let mut entries = Vec::new();
    walk(init, 0, init.len(), 0, &mut |b| {
        if &b.kind == b"hev1" {
            entries.push(b.start + 4);
        }
    });
    let mut out = init.to_vec();
    for at in entries {
        out[at..at + 4].copy_from_slice(b"hvc1");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIDEO_INIT: &[u8] = include_bytes!("../../tests/fixtures/init0.m4s");
    const AUDIO_INIT: &[u8] = include_bytes!("../../tests/fixtures/init3.m4s");

    /// A box: size, type, body.
    fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    /// moov/trak/mdia/minf/stbl/stsd holding one sample entry with `config` inside.
    fn init_with(entry: &[u8; 4], fields: usize, config: Vec<u8>) -> Vec<u8> {
        let mut sample = vec![0; fields];
        sample.extend(config);
        let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stsd.extend(mp4_box(entry, &sample));
        let mut inner = mp4_box(b"stsd", &stsd);
        for kind in [b"stbl", b"minf", b"mdia", b"trak", b"moov"] {
            inner = mp4_box(kind, &inner);
        }
        let mut file = mp4_box(b"ftyp", b"isom\0\0\0\x01");
        file.extend(inner);
        file
    }

    #[test]
    fn fixtures() {
        assert_eq!(codec_string(VIDEO_INIT).as_deref(), Some("hvc1.1.6.L150.90"));
        assert_eq!(codec_string(AUDIO_INIT).as_deref(), Some("mp4a.40.2"));
        // Only the sample entry's type changes.
        let at = VIDEO_INIT.windows(4).position(|w| w == b"hev1").expect("an hev1 sample entry");
        let mut expected = VIDEO_INIT.to_vec();
        expected[at..at + 4].copy_from_slice(b"hvc1");
        let patched = hvc1(VIDEO_INIT);
        assert_eq!(patched, expected);
        assert!(!patched.windows(4).any(|w| w == b"hev1"));
        assert_eq!(codec_string(&patched).as_deref(), Some("hvc1.1.6.L150.90"));
        assert_eq!(hvc1(AUDIO_INIT), AUDIO_INIT);
    }

    #[test]
    fn built_inits() {
        let avc = init_with(b"avc1", 78, mp4_box(b"avcC", &[1, 0x64, 0x00, 0x28, 0xff]));
        assert_eq!(codec_string(&avc).as_deref(), Some("avc1.640028"));
        // Main 10, high tier, flags 0x20000000 reversed = 4, level 153, constraints B0 then zeros.
        let hvcc = [1, 0b0010_0010, 0x20, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 153, 0xf0];
        let hevc = init_with(b"hev1", 78, mp4_box(b"hvcC", &hvcc));
        assert_eq!(codec_string(&hevc).as_deref(), Some("hvc1.2.4.H153.B0"));
        assert_eq!(codec_string(&hvc1(&hevc)).as_deref(), Some("hvc1.2.4.H153.B0"));
        assert!(hvc1(&hevc).windows(4).any(|w| w == b"hvc1"));
        // HE-AAC: audio object type 5 in the DecoderSpecificInfo.
        let esds = [0, 0, 0, 0, 0x03, 0x19, 0, 1, 0, 0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, 0x2b, 0x92];
        let aac = init_with(b"mp4a", 28, mp4_box(b"esds", &esds));
        assert_eq!(codec_string(&aac).as_deref(), Some("mp4a.40.5"));
        let mp3 = init_with(b"mp4a", 28, mp4_box(b"esds", &[0, 0, 0, 0, 0x03, 0x19, 0, 1, 0, 0x04, 0x11, 0x6b]));
        assert_eq!(codec_string(&mp3).as_deref(), Some("mp4a.40.2"));
    }

    #[test]
    fn broken_input() {
        for junk in [&b""[..], b"\0\0\0", b"\0\0\0\x01moov", b"\xff\xff\xff\xffmoov", b"\0\0\0\x04moov"] {
            assert_eq!(codec_string(junk), None);
            assert_eq!(hvc1(junk), junk);
        }
        // Nesting deeper than any real file is not walked (and can't overflow the stack).
        let mut deep = mp4_box(b"avcC", &[1, 0x64, 0, 0x28]);
        for _ in 0..1000 {
            deep = mp4_box(b"moov", &deep);
        }
        assert_eq!(codec_string(&deep), None);
        // A 64-bit size.
        let mut large = 1u32.to_be_bytes().to_vec();
        large.extend_from_slice(b"moov");
        large.extend_from_slice(&(16u64 + 12).to_be_bytes());
        large.extend(mp4_box(b"avcC", &[1, 0x4d, 0x40, 0x1f]));
        assert_eq!(codec_string(&large).as_deref(), Some("avc1.4d401f"));
    }
}
