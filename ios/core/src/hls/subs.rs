//! Subtitles for the phone: sources give SRT (or VTT); AVPlayer reads WebVTT. Port of subs.ts.

/// SRT → WebVTT (cue numbers dropped, commas in times made dots); WebVTT passes through.
pub fn to_webvtt(text: &str) -> String {
    let text = text.strip_prefix(|c: char| c as u32 == 0xFEFF).unwrap_or(text);
    let body = text.replace("\r\n", "\n").replace('\r', "\n");
    let body = body.trim();
    if body.starts_with("WEBVTT") {
        return format!("{body}\n");
    }
    let cues: Vec<String> = blocks(body).into_iter().filter_map(cue).collect();
    // X-TIMESTAMP-MAP lines the cues up with the video's own clock (it starts at 0) inside HLS.
    format!("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n{}\n", cues.join("\n\n"))
}

/// A subtitle file as fetched: mostly UTF-8; older SRTs can be Windows-1252, which decodes as
/// Latin-1 closely enough. Returns WebVTT.
pub fn read_subtitles(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(text) => to_webvtt(text),
        Err(_) => to_webvtt(&raw.iter().map(|&b| char::from(b)).collect::<String>()),
    }
}

/// The text split at blank lines.
fn blocks(body: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(at) = rest.find("\n\n") {
        out.push(&rest[..at]);
        rest = rest[at..].trim_start_matches('\n');
    }
    out.push(rest);
    out
}

/// One SRT block as a WebVTT cue: the timing line and the text after it (none without either).
fn cue(block: &str) -> Option<String> {
    let lines: Vec<&str> = block.split('\n').collect();
    let at = lines.iter().position(|l| l.contains("-->"))?;
    let text = lines[at + 1..].join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| format!("{}\n{text}", times(lines[at])))
}

/// "00:01:02,5 --> 00:01:03,25" → "00:01:02.500 --> 00:01:03.250".
fn times(line: &str) -> String {
    let line = replace_matches(line, |b, i| {
        // (\d{1,2}:\d{2}:\d{2}),(\d{1,3}) → $1.$2
        let hours = if digit(b, i) && digit(b, i + 1) && at(b, i + 2, b':') {
            2
        } else if digit(b, i) && at(b, i + 1, b':') {
            1
        } else {
            return None;
        };
        let comma = clock(b, i + hours)?;
        if !at(b, comma, b',') {
            return None;
        }
        let end = (comma + 1..comma + 4).take_while(|&k| digit(b, k)).last()? + 1;
        Some((end, format!("{}.{}", ascii(&b[i..comma]), ascii(&b[comma + 1..end]))))
    });
    // Fractions with one or two digits get three.
    let line = replace_matches(&line, |b, i| padded(b, i, 1, "00"));
    replace_matches(&line, |b, i| padded(b, i, 2, "0"))
}

/// (\d+:\d{2}:\d{2}\.\d{`decimals`})(?!\d) → $1`zeros`
fn padded(b: &[u8], i: usize, decimals: usize, zeros: &str) -> Option<(usize, String)> {
    let colon = (i..).take_while(|&k| digit(b, k)).last()? + 1;
    let dot = clock(b, colon)?;
    let end = dot + 1 + decimals;
    if !at(b, dot, b'.') || !(dot + 1..end).all(|k| digit(b, k)) || digit(b, end) {
        return None;
    }
    Some((end, format!("{}{zeros}", ascii(&b[i..end]))))
}

/// ":\d{2}:\d{2}" at `i`: where it ends.
fn clock(b: &[u8], i: usize) -> Option<usize> {
    let ok = at(b, i, b':') && digit(b, i + 1) && digit(b, i + 2) && at(b, i + 3, b':') && digit(b, i + 4) && digit(b, i + 5);
    ok.then_some(i + 6)
}

fn digit(b: &[u8], i: usize) -> bool {
    b.get(i).is_some_and(u8::is_ascii_digit)
}

fn at(b: &[u8], i: usize, c: u8) -> bool {
    b.get(i) == Some(&c)
}

/// Matches are ASCII digits and punctuation.
fn ascii(b: &[u8]) -> &str {
    std::str::from_utf8(b).unwrap_or_default()
}

/// Every match of `find` (tried at each position, left to right, as a global regex does) replaced.
/// `find(bytes, i)` gives where a match starting at `i` ends and what replaces it.
fn replace_matches(s: &str, find: impl Fn(&[u8], usize) -> Option<(usize, String)>) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len() + 8);
    let (mut copied, mut i) = (0, 0);
    while i < b.len() {
        match find(b, i) {
            Some((end, with)) => {
                // Matches start and end on ASCII bytes, so these are character boundaries.
                out.push_str(&s[copied..i]);
                out.push_str(&with);
                (copied, i) = (end, end);
            }
            None => i += 1,
        }
    }
    out.push_str(&s[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n";

    #[test]
    fn srt_to_webvtt() {
        let vtt = to_webvtt("1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:01:02,5 --> 00:01:03,25\r\nTwo\r\nlines\r\n");
        assert!(vtt.starts_with("WEBVTT") && vtt.contains("00:00:01.000 --> 00:00:02.500") && vtt.contains("00:01:02.500 --> 00:01:03.250"));
        assert_eq!(vtt, format!("{HEADER}00:00:01.000 --> 00:00:02.500\nHello\n\n00:01:02.500 --> 00:01:03.250\nTwo\nlines\n"));
    }

    #[test]
    fn odd_files() {
        let bom = char::from_u32(0xFEFF).map(String::from).unwrap_or_default();
        assert_eq!(to_webvtt(&format!("{bom}1\n00:00:01,000 --> 00:00:02,000\nBOM\n")), format!("{HEADER}00:00:01.000 --> 00:00:02.000\nBOM\n"));
        // Blocks without timing or text are dropped; extra blank lines and Mac line endings are fine.
        let srt = "1\r100:00:01,000 --> 100:00:02,000\rlong\r\r\r\r2\r00:00:03,000 --> 00:00:04,000\r\r3\rno arrow\r\r4\r0:00:05,1 --> 0:00:06,12 X1:1\r  spaced  ";
        assert_eq!(
            to_webvtt(srt),
            format!("{HEADER}100:00:01.000 --> 100:00:02.000\nlong\n\n0:00:05.100 --> 0:00:06.120 X1:1\nspaced\n")
        );
        assert_eq!(to_webvtt("WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n\n"), "WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n");
        assert_eq!(to_webvtt(""), format!("{HEADER}\n"));
    }

    #[test]
    fn latin1_fallback() {
        // "Café" in Windows-1252 isn't UTF-8.
        let raw = b"1\n00:00:01,000 --> 00:00:02,000\nCaf\xe9\n";
        assert_eq!(read_subtitles(raw), format!("{HEADER}00:00:01.000 --> 00:00:02.000\nCaf{}\n", char::from(0xe9u8)));
        assert_eq!(read_subtitles("1\n00:00:01,000 --> 00:00:02,000\nCafé\n".as_bytes()), format!("{HEADER}00:00:01.000 --> 00:00:02.000\nCafé\n"));
    }
}
