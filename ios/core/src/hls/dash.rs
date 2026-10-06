//! MovieBox streams are DASH (a manifest plus fragmented-MP4 segments). An iPhone plays HLS, not
//! DASH, so AVPlayer gets HLS playlists written from the manifest; the segments themselves are
//! relayed unchanged. Handles what VOD manifests use: SegmentTemplate with or without a
//! SegmentTimeline ($Number$ / $Time$ addressing), BaseURL, one period. Port of dash.ts.

use std::collections::HashMap;

use reqwest::Url;

// ── A small XML reader (manifests are plain, machine-written XML) ────────────────

/// An element: name and attribute names without namespace prefixes, children, and its text
/// (entities decoded).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct XmlNode {
    pub name: String,
    pub attrs: HashMap<String, String>,
    pub children: Vec<XmlNode>,
    pub text: String,
}

impl XmlNode {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }

    /// The first child element called `name`.
    pub fn child(&self, name: &str) -> Option<&XmlNode> {
        self.children.iter().find(|c| c.name == name)
    }

    /// Every child element called `name`.
    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a XmlNode> {
        self.children.iter().filter(move |c| c.name == name)
    }
}

/// Parses XML as manifests write it; never fails (what can't be read is left out). The root is
/// a "#root" node holding the document element.
pub fn parse_xml(xml: &str) -> XmlNode {
    let clean = strip_markup(xml);
    let mut root = XmlNode { name: "#root".into(), ..XmlNode::default() };
    let mut open: Vec<XmlNode> = Vec::new();
    let (mut last, mut from) = (0, 0);
    while let Some(offset) = clean[from..].find('<') {
        let at = from + offset;
        let Some((tag, end)) = scan_tag(&clean, at) else {
            from = at + 1;
            continue;
        };
        let text = decode(&clean[last..at]);
        top(&mut root, &mut open).text.push_str(&text);
        (last, from) = (end, end);
        match tag {
            Tag::Cdata(text) => top(&mut root, &mut open).text.push_str(text),
            // Pop back to the matching element; elements left open inside it close with it.
            Tag::Close(name) => {
                if let Some(i) = open.iter().rposition(|n| n.name == name) {
                    close_to(&mut root, &mut open, i);
                }
            }
            Tag::Open { name, attrs, empty } => {
                let node = XmlNode { name, attrs, ..XmlNode::default() };
                if empty {
                    top(&mut root, &mut open).children.push(node);
                } else {
                    open.push(node);
                }
            }
        }
    }
    close_to(&mut root, &mut open, 0);
    root
}

enum Tag<'a> {
    Open { name: String, attrs: HashMap<String, String>, empty: bool },
    Close(String),
    Cdata(&'a str),
}

fn top<'a>(root: &'a mut XmlNode, open: &'a mut [XmlNode]) -> &'a mut XmlNode {
    open.last_mut().unwrap_or(root)
}

/// Closes open elements until `len` remain, each becoming a child of the one below it.
fn close_to(root: &mut XmlNode, open: &mut Vec<XmlNode>, len: usize) {
    while open.len() > len {
        if let Some(node) = open.pop() {
            top(root, open).children.push(node);
        }
    }
}

/// Drops the parts that carry no content: `<?…?>`, `<!--…-->`, `<!DOCTYPE…>`.
fn strip_markup(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut from = 0;
    while let Some(offset) = xml[from..].find('<') {
        let at = from + offset;
        let rest = &xml[at..];
        let skip = if rest.starts_with("<?") {
            rest[2..].find("?>").map(|e| e + 4)
        } else if rest.starts_with("<!--") {
            rest[4..].find("-->").map(|e| e + 7)
        } else if rest.starts_with("<!DOCTYPE") {
            rest.find('>').map(|e| e + 1)
        } else {
            None
        };
        match skip {
            Some(len) => {
                out.push_str(&xml[from..at]);
                from = at + len;
            }
            None => {
                out.push_str(&xml[from..=at]);
                from = at + 1;
            }
        }
    }
    out.push_str(&xml[from..]);
    out
}

/// A tag (or CDATA section) starting at `at`, and where it ends; None when `<` starts neither.
fn scan_tag(s: &str, at: usize) -> Option<(Tag<'_>, usize)> {
    if let Some(body) = s[at..].strip_prefix("<![CDATA[") {
        let len = body.find("]]>")?;
        return Some((Tag::Cdata(&body[..len]), at + 9 + len + 3));
    }
    let b = s.as_bytes();
    let mut i = at + 1;
    let closing = b.get(i) == Some(&b'/');
    if closing {
        i += 1;
    }
    let name_start = i;
    if !b.get(i).is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_') {
        return None;
    }
    while b.get(i).is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b':' | b'.' | b'-')) {
        i += 1;
    }
    let name = after_prefix(&s[name_start..i]).to_string();
    let mut attrs = HashMap::new();
    while let Some((key, value, end)) = scan_attr(s, i) {
        let key = if key.starts_with("xmlns") { key } else { after_prefix(key) };
        attrs.insert(key.to_string(), decode(value));
        i = end;
    }
    while b.get(i).is_some_and(|c| is_space(*c)) {
        i += 1;
    }
    let empty = b.get(i) == Some(&b'/');
    if empty {
        i += 1;
    }
    if b.get(i) != Some(&b'>') {
        return None;
    }
    let tag = if closing { Tag::Close(name) } else { Tag::Open { name, attrs, empty } };
    Some((tag, i + 1))
}

/// ` name="value"` (or 'value') at `i`: the name, the raw value, and where it ends.
fn scan_attr(s: &str, i: usize) -> Option<(&str, &str, usize)> {
    let b = s.as_bytes();
    let skip_spaces = |mut j: usize| {
        while b.get(j).is_some_and(|c| is_space(*c)) {
            j += 1;
        }
        j
    };
    let key_start = skip_spaces(i);
    if key_start == i {
        return None;
    }
    let mut j = key_start;
    while b.get(j).is_some_and(|c| !is_space(*c) && !matches!(c, b'=' | b'/' | b'>')) {
        j += 1;
    }
    if j == key_start {
        return None;
    }
    let key = &s[key_start..j];
    j = skip_spaces(j);
    if b.get(j) != Some(&b'=') {
        return None;
    }
    j = skip_spaces(j + 1);
    let quote = *b.get(j).filter(|q| matches!(q, b'"' | b'\''))?;
    let value_start = j + 1;
    let len = s[value_start..].find(char::from(quote))?;
    Some((key, &s[value_start..value_start + len], value_start + len + 1))
}

/// `mpd:Period` → `Period`.
fn after_prefix(name: &str) -> &str {
    name.split_once(':').map_or(name, |(_, rest)| rest)
}

/// Whitespace as JavaScript's `\s` sees it, in ASCII.
fn is_space(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0B | 0x0C)
}

/// Character references and the five predefined entities.
fn decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        match entity(tail) {
            Some((c, len)) => {
                out.push(c);
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The reference at the start of `s` ("&amp;", "&#38;", "&#x26;"): its character and length.
fn entity(s: &str) -> Option<(char, usize)> {
    // References are short: no `;` close by means there is none.
    let end = s.bytes().take(16).position(|b| b == b';')?;
    let name = s[1..end].to_ascii_lowercase();
    let code = |digits: &str, radix: u32| {
        let valid = !digits.is_empty() && digits.chars().all(|c| c.is_digit(radix));
        valid.then(|| u32::from_str_radix(digits, radix).ok()).flatten().and_then(char::from_u32)
    };
    let c = match name.as_str() {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        _ => match name.strip_prefix("#x") {
            Some(hex) => code(hex, 16)?,
            None => code(name.strip_prefix('#')?, 10)?,
        },
    };
    Some((c, end + 1))
}

/// ISO 8601 durations as manifests write them (PT3H48M18.4S, P1DT2H); 0 when unreadable.
pub fn iso_seconds(v: &str) -> f64 {
    fn read(v: &str) -> Option<f64> {
        let mut rest = v.strip_prefix('P')?;
        let days = part(&mut rest, b'D');
        let (mut hours, mut minutes, mut seconds) = (None, None, None);
        if let Some(time) = rest.strip_prefix('T') {
            rest = time;
            hours = part(&mut rest, b'H');
            minutes = part(&mut rest, b'M');
            seconds = part(&mut rest, b'S');
        }
        let [d, h, m, s] = [days, hours, minutes, seconds].map(|x| x.unwrap_or(0.0));
        rest.is_empty().then_some(d * 86400.0 + h * 3600.0 + m * 60.0 + s)
    }
    /// "<number><unit>" at the start of `rest`, consumed when present.
    fn part(rest: &mut &str, unit: u8) -> Option<f64> {
        let b = rest.as_bytes();
        let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
        let mut len = digits(0);
        if len == 0 {
            return None;
        }
        if b.get(len) == Some(&b'.') && digits(len + 1) > 0 {
            len += 1 + digits(len + 1);
        }
        if b.get(len) != Some(&unit) {
            return None;
        }
        let value = rest[..len].parse().ok()?;
        *rest = &rest[len + 1..];
        Some(value)
    }
    read(v.trim()).unwrap_or(0.0)
}

/// `Number(text)` as JavaScript reads an attribute: blank is 0, anything unreadable NaN.
fn number(v: &str) -> f64 {
    let v = v.trim();
    if v.is_empty() {
        0.0
    } else if v.bytes().any(|c| c.is_ascii_alphabetic() && !matches!(c, b'e' | b'E')) {
        // Rust also reads "inf" and "nan"; JavaScript doesn't.
        f64::NAN
    } else {
        v.parse().unwrap_or(f64::NAN)
    }
}

/// A number as JavaScript's `String(n)` writes the ones a manifest can hold ("12", not "12.0").
fn js_string(n: f64) -> String {
    if n == 0.0 {
        "0".into()
    } else if n.is_finite() && n.fract() == 0.0 {
        format!("{n:.0}")
    } else {
        format!("{n}")
    }
}

/// `n.toFixed(3)`. Rust rounds an exact half (at 3 decimals only odd sixteenths, like 5.0625, are
/// exact halves) to even; JavaScript rounds it up.
fn fixed3(n: f64) -> String {
    let sixteenths = n * 16.0; // exact: a power of two
    if n > 0.0 && n < 1e12 && sixteenths.fract() == 0.0 && sixteenths % 2.0 == 1.0 {
        let thousandths = (125 * sixteenths as u64).div_ceil(2);
        return format!("{}.{:03}", thousandths / 1000, thousandths % 1000);
    }
    format!("{n:.3}")
}

// ── Manifest → renditions ─────────────────────────────────────────────────────────

/// One manifest with more segments than this is broken (or hostile): a day of 1-second
/// segments is 86,400.
const MAX_SEGMENTS: usize = 500_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub url: String,
    /// Seconds.
    pub duration: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaType {
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rendition {
    pub id: String,
    pub kind: MediaType,
    /// Bits per second; NaN when the manifest's value can't be read (the master playlist then
    /// falls back to 1 Mbit/s, as dash.ts does).
    pub bandwidth: f64,
    /// As the manifest writes it ("hev1", "avc1.640028", "mp4a.40.2"); may be incomplete.
    pub codecs: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    pub lang: Option<String>,
    pub label: Option<String>,
    pub init: Option<String>,
    pub segments: Vec<Segment>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DashManifest {
    /// Seconds.
    pub duration: f64,
    pub renditions: Vec<Rendition>,
}

/// `new URL(rel, base).href`, or `base` itself when there is nothing to add.
fn join(base: &str, rel: Option<&str>) -> Result<String, String> {
    match rel.filter(|r| !r.is_empty()) {
        Some(rel) => resolve(&parse_url(base)?, base, rel),
        None => Ok(base.to_string()),
    }
}

/// `join` with the base already parsed (segment lists are long).
fn resolve(base: &Url, base_text: &str, rel: &str) -> Result<String, String> {
    if rel.is_empty() {
        return Ok(base_text.to_string());
    }
    base.join(rel.trim()).map(String::from).map_err(|_| format!("The stream manifest has a bad address: {rel}"))
}

fn parse_url(url: &str) -> Result<Url, String> {
    Url::parse(url).map_err(|_| "The stream's address isn't valid.".to_string())
}

fn frame_rate(v: Option<&str>) -> Option<f64> {
    let mut parts = v.filter(|v| !v.is_empty())?.split('/').map(number);
    let a = parts.next().unwrap_or(f64::NAN);
    let rate = match parts.next() {
        Some(b) if b != 0.0 && !b.is_nan() => a / b,
        _ => a,
    };
    (rate.is_finite() && rate > 0.0).then_some(rate)
}

/// A width or height: positive, or none.
fn size(v: Option<&str>) -> Option<u32> {
    let n = v.map_or(f64::NAN, number);
    (n.is_finite() && n >= 1.0).then(|| n as u32)
}

/// Fills a SegmentTemplate URL: $RepresentationID$, $Bandwidth$, $Number%05d$, $Time$, $$.
fn fill(template: &str, id: &str, bandwidth: f64, number: f64, time: f64) -> String {
    let mut out = String::with_capacity(template.len() + 16);
    let mut rest = template;
    while let Some(at) = rest.find('$') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let Some((key, width, len)) = identifier(after) else {
            out.push('$');
            rest = after;
            continue;
        };
        rest = &after[len..];
        let value = match key {
            "" => "$".to_string(),
            "RepresentationID" => {
                out.push_str(id);
                continue;
            }
            "Number" => js_string(number),
            "Time" => js_string(time),
            _ => js_string(bandwidth),
        };
        let pad = width.unwrap_or(0).saturating_sub(value.chars().count());
        out.extend(std::iter::repeat_n('0', if key.is_empty() { 0 } else { pad }));
        out.push_str(&value);
    }
    out.push_str(rest);
    out
}

/// After a `$`: the identifier, its `%0<width>d` format, and the length up to its closing `$`.
fn identifier(s: &str) -> Option<(&'static str, Option<usize>, usize)> {
    // Wider than any number gets; keeps a broken template from asking for gigabytes of zeros.
    const MAX_WIDTH: usize = 32;
    for key in ["RepresentationID", "Number", "Time", "Bandwidth", ""] {
        let Some(after) = s.strip_prefix(key) else { continue };
        if let Some(format) = after.strip_prefix("%0") {
            let digits = format.bytes().take_while(u8::is_ascii_digit).count();
            if digits > 0 && format[digits..].starts_with("d$") {
                let width = format[..digits].parse().unwrap_or(MAX_WIDTH).min(MAX_WIDTH);
                return Some((key, Some(width), key.len() + 2 + digits + 2));
            }
        }
        if after.starts_with('$') {
            return Some((key, None, key.len() + 1));
        }
    }
    None
}

pub fn parse_mpd(xml: &str, mpd_url: &str) -> Result<DashManifest, String> {
    let root = parse_xml(xml);
    let mpd = root.child("MPD").ok_or("The stream manifest could not be read.")?;
    if mpd.attr("type") == Some("dynamic") {
        return Err("Live DASH streams cannot play on a phone yet.".into());
    }
    let period = mpd.child("Period").ok_or("The stream manifest has no content.")?;
    let total = match period.attr("duration").map_or(0.0, iso_seconds) {
        d if d == 0.0 => mpd.attr("mediaPresentationDuration").map_or(0.0, iso_seconds),
        d => d,
    };
    let text = |n: &XmlNode| n.text.clone();
    let mpd_base = join(mpd_url, mpd.child("BaseURL").map(text).as_deref())?;
    let period_base = join(&mpd_base, period.child("BaseURL").map(text).as_deref())?;

    let mut renditions: Vec<Rendition> = Vec::new();
    for set in period.children_named("AdaptationSet") {
        let set_base = join(&period_base, set.child("BaseURL").map(text).as_deref())?;
        let set_template = set.child("SegmentTemplate");
        for rep in set.children_named("Representation") {
            let mime = rep.attr("mimeType").or(set.attr("mimeType")).unwrap_or("");
            let kind = match set.attr("contentType").unwrap_or_else(|| mime.split('/').next().unwrap_or("")) {
                "video" => MediaType::Video,
                "audio" => MediaType::Audio,
                _ => continue,
            };
            let own = rep.child("SegmentTemplate");
            if own.is_none() && set_template.is_none() {
                return Err("This stream uses a manifest layout a phone cannot play yet.".into());
            }
            // The representation's own template attributes win over its set's.
            let t = |key: &str| own.and_then(|n| n.attr(key)).or_else(|| set_template.and_then(|n| n.attr(key)));
            let timeline = own.and_then(|n| n.child("SegmentTimeline")).or_else(|| set_template.and_then(|n| n.child("SegmentTimeline")));
            let base = join(&set_base, rep.child("BaseURL").map(text).as_deref())?;
            let base_url = parse_url(&base)?;
            let id = rep.attr("id").map_or_else(|| renditions.len().to_string(), str::to_string);
            let bandwidth = rep.attr("bandwidth").map_or(0.0, number);
            let timescale = match t("timescale").map_or(1.0, number) {
                v if v == 0.0 || v.is_nan() => 1.0,
                v => v,
            };
            let start_number = t("startNumber").map_or(1.0, number);
            let media = t("media").filter(|m| !m.is_empty()).ok_or("The stream manifest names no segments.")?;
            let segment = |number: f64, time: f64, duration: f64| -> Result<Segment, String> {
                Ok(Segment { url: resolve(&base_url, &base, &fill(media, &id, bandwidth, number, time))?, duration })
            };
            let mut segments = Vec::new();
            let too_many = || format!("The stream manifest lists more than {MAX_SEGMENTS} segments.");
            if let Some(timeline) = timeline {
                let items: Vec<&XmlNode> = timeline.children_named("S").collect();
                let (mut time, mut number) = (0.0, start_number);
                for (i, s) in items.iter().enumerate() {
                    if let Some(t) = s.attr("t") {
                        time = self::number(t);
                    }
                    let d = s.attr("d").map_or(f64::NAN, self::number);
                    let mut repeat = s.attr("r").map_or(0.0, self::number);
                    if repeat < 0.0 {
                        // Repeat until the next entry's start, or the end of the period.
                        let next_start = items.get(i + 1).and_then(|n| n.attr("t")).map_or(total * timescale, self::number);
                        let count = ((next_start - time) / d).ceil() - 1.0;
                        repeat = if count.is_nan() { count } else { count.max(0.0) };
                    }
                    let mut k = 0.0;
                    while k <= repeat {
                        if segments.len() >= MAX_SEGMENTS {
                            return Err(too_many());
                        }
                        segments.push(segment(number, time, d / timescale)?);
                        time += d;
                        number += 1.0;
                        k += 1.0;
                    }
                }
            } else {
                let d = t("duration").map_or(f64::NAN, number);
                if d == 0.0 || d.is_nan() || total == 0.0 || total.is_nan() {
                    return Err("The stream manifest has no segment timing.".into());
                }
                let count = (total * timescale / d).ceil();
                let mut i = 0.0;
                while i < count {
                    if segments.len() >= MAX_SEGMENTS {
                        return Err(too_many());
                    }
                    segments.push(segment(start_number + i, i * d, d.min(total * timescale - i * d) / timescale)?);
                    i += 1.0;
                }
            }
            let label = |n: &XmlNode| n.child("Label").map(|l| l.text.trim().to_string()).filter(|l| !l.is_empty());
            let init = match t("initialization").filter(|i| !i.is_empty()) {
                Some(template) => Some(resolve(&base_url, &base, &fill(template, &id, bandwidth, start_number, 0.0))?),
                None => None,
            };
            renditions.push(Rendition {
                kind,
                bandwidth,
                codecs: rep.attr("codecs").or(set.attr("codecs")).unwrap_or("").to_string(),
                width: size(rep.attr("width").or(set.attr("width"))),
                height: size(rep.attr("height").or(set.attr("height"))),
                frame_rate: frame_rate(rep.attr("frameRate").or(set.attr("frameRate"))),
                lang: set.attr("lang").or(rep.attr("lang")).map(str::to_string),
                label: label(set).or_else(|| label(rep)),
                init,
                segments,
                id,
            });
        }
    }
    if !renditions.iter().any(|r| r.kind == MediaType::Video) {
        return Err("The stream manifest has no video.".into());
    }
    Ok(DashManifest { duration: total, renditions })
}

/// Leaves out the video renditions taller than `max_height`, the quality the user picked (at
/// MovieBox every quality of a title is in one manifest), as the engine's own relay does
/// (proxy.rs filter_dash_representations): renditions without a height stay, and when none fits
/// the cap the smallest stays.
pub fn cap_height(d: &mut DashManifest, max_height: u64) {
    let heights: Vec<u64> = d.renditions.iter().filter(|r| r.kind == MediaType::Video).filter_map(|r| r.height).map(u64::from).collect();
    let Some(&smallest) = heights.iter().min() else { return };
    let ceiling = if heights.iter().any(|&h| h <= max_height) { max_height } else { smallest };
    d.renditions.retain(|r| r.kind != MediaType::Video || r.height.is_none_or(|h| u64::from(h) <= ceiling));
}

// ── Renditions → HLS ──────────────────────────────────────────────────────────────

fn language_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "en" | "eng" => "English",
        "ka" | "kat" | "geo" => "ქართული",
        "ru" | "rus" => "Русский",
        "hi" | "hin" => "Hindi",
        "es" | "spa" => "Español",
        "fr" | "fra" | "fre" => "Français",
        "de" | "deu" | "ger" => "Deutsch",
        "pt" | "por" => "Português",
        "tr" | "tur" => "Türkçe",
        "uk" | "ukr" => "Українська",
        "ar" | "ara" => "العربية",
        "ja" | "jpn" => "日本語",
        "ko" | "kor" => "한국어",
        "zh" | "zho" | "chi" => "中文",
        _ => return None,
    })
}

/// HLS wants BCP 47 tags: the two-letter code where manifests write the three-letter one.
fn two_letter(code: &str) -> Option<&'static str> {
    Some(match code {
        "eng" => "en",
        "kat" | "geo" => "ka",
        "rus" => "ru",
        "hin" => "hi",
        "spa" => "es",
        "fra" | "fre" => "fr",
        "deu" | "ger" => "de",
        "por" => "pt",
        "tur" => "tr",
        "ukr" => "uk",
        "ara" => "ar",
        "jpn" => "ja",
        "kor" => "ko",
        "zho" | "chi" => "zh",
        "ita" => "it",
        "tam" => "ta",
        "tel" => "te",
        "ben" => "bn",
        "ind" => "id",
        "tha" => "th",
        "vie" => "vi",
        "pol" => "pl",
        _ => return None,
    })
}

/// A manifest language as an HLS LANGUAGE tag ("eng" → "en"); none for "und" or nothing.
pub fn language_tag(lang: Option<&str>) -> Option<String> {
    let lang = lang.filter(|l| !l.is_empty() && *l != "und")?;
    Some(two_letter(&lang.to_lowercase()).map_or_else(|| lang.to_string(), str::to_string))
}

/// Quotes can't appear inside an HLS attribute value.
fn attr(v: &str) -> String {
    v.replace('"', "'")
}

/// Where a playlist points for each part of a rendition.
pub trait HlsPaths {
    /// URL of a rendition's media playlist.
    fn playlist(&self, r: &Rendition) -> String;
    /// URL of a rendition's initialization segment.
    fn init(&self, r: &Rendition) -> String;
    /// URL of segment `i` of a rendition.
    fn segment(&self, r: &Rendition, i: usize) -> String;
}

/// The subtitles a master playlist lists: their playlist's URL, the track's name and language.
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleTrack {
    pub uri: String,
    pub name: String,
    pub lang: Option<String>,
}

/// The master playlist: every video rendition, its audio, and the subtitles when there are some.
pub fn master_playlist(
    d: &DashManifest,
    codecs: impl Fn(&Rendition) -> String,
    paths: &impl HlsPaths,
    subtitles: Option<&SubtitleTrack>,
) -> String {
    let video: Vec<&Rendition> = d.renditions.iter().filter(|r| r.kind == MediaType::Video).collect();
    let audio: Vec<&Rendition> = d.renditions.iter().filter(|r| r.kind == MediaType::Audio).collect();
    let mut lines: Vec<String> = vec!["#EXTM3U".into(), "#EXT-X-VERSION:7".into(), "#EXT-X-INDEPENDENT-SEGMENTS".into()];
    for (i, &a) in audio.iter().enumerate() {
        let lang = language_tag(a.lang.as_deref());
        let name = match (&a.label, a.lang.as_deref(), &lang) {
            (Some(label), _, _) => label.clone(),
            (None, Some(l), Some(tag)) => language_name(&l.to_lowercase()).map_or_else(|| tag.clone(), str::to_string),
            _ => format!("Audio {}", i + 1),
        };
        let language = lang.map(|l| format!("LANGUAGE=\"{}\",", attr(&l))).unwrap_or_default();
        let default = if i == 0 { "YES" } else { "NO" };
        lines.push(format!(
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"{}\",{language}DEFAULT={default},AUTOSELECT=YES,URI=\"{}\"",
            attr(&name),
            paths.playlist(a)
        ));
    }
    if let Some(s) = subtitles {
        let language = s.lang.as_ref().map(|l| format!("LANGUAGE=\"{}\",", attr(l))).unwrap_or_default();
        lines.push(format!(
            "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"{}\",{language}DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI=\"{}\"",
            attr(&s.name),
            s.uri
        ));
    }
    // Math.max: one unreadable (NaN) bandwidth makes the sum unknown.
    let audio_bandwidth = audio.iter().fold(0.0, |max: f64, a| if max.is_nan() || a.bandwidth.is_nan() { f64::NAN } else { max.max(a.bandwidth) });
    let mut audio_codecs: Vec<String> = Vec::new();
    for c in audio.iter().map(|&a| codecs(a)) {
        if !c.is_empty() && !audio_codecs.contains(&c) {
            audio_codecs.push(c);
        }
    }
    // The first variant is where playback starts: the one nearest 720p loads quickly and looks good.
    let mut order = video;
    order.sort_by_key(|v| (i64::from(v.height.unwrap_or(720)) - 720).abs());
    for v in order {
        let bandwidth = match v.bandwidth + audio_bandwidth {
            b if b == 0.0 || b.is_nan() => 1_000_000.0,
            b => b,
        };
        let mut parts = vec![format!("BANDWIDTH={}", js_string(bandwidth))];
        if let (Some(w), Some(h)) = (v.width, v.height) {
            parts.push(format!("RESOLUTION={w}x{h}"));
        }
        if let Some(rate) = v.frame_rate {
            parts.push(format!("FRAME-RATE={}", fixed3(rate)));
        }
        let all: Vec<String> = std::iter::once(codecs(v)).chain(audio_codecs.iter().cloned()).filter(|c| !c.is_empty()).collect();
        parts.push(format!("CODECS=\"{}\"", all.join(",")));
        if !audio.is_empty() {
            parts.push("AUDIO=\"audio\"".into());
        }
        if subtitles.is_some() {
            parts.push("SUBTITLES=\"subs\"".into());
        }
        lines.push(format!("#EXT-X-STREAM-INF:{}", parts.join(",")));
        lines.push(paths.playlist(v));
    }
    lines.join("\n") + "\n"
}

/// One rendition's media playlist (VOD: every segment listed, ending with ENDLIST).
pub fn media_playlist(r: &Rendition, paths: &impl HlsPaths) -> String {
    let longest = r.segments.iter().map(|s| s.duration).fold(f64::NEG_INFINITY, f64::max);
    let target = longest.ceil().max(1.0);
    let mut lines: Vec<String> = vec![
        "#EXTM3U".into(),
        "#EXT-X-VERSION:7".into(),
        format!("#EXT-X-TARGETDURATION:{}", js_string(target)),
        "#EXT-X-MEDIA-SEQUENCE:0".into(),
        "#EXT-X-PLAYLIST-TYPE:VOD".into(),
        "#EXT-X-INDEPENDENT-SEGMENTS".into(),
    ];
    if r.init.is_some() {
        lines.push(format!("#EXT-X-MAP:URI=\"{}\"", paths.init(r)));
    }
    for (i, s) in r.segments.iter().enumerate() {
        lines.push(format!("#EXTINF:{},", fixed3(s.duration)));
        lines.push(paths.segment(r, i));
    }
    lines.push("#EXT-X-ENDLIST".into());
    lines.join("\n") + "\n"
}

/// A subtitle "playlist": the whole WebVTT file as one segment.
pub fn subtitle_playlist(uri: &str, duration: f64) -> String {
    let d = duration.ceil().max(1.0);
    [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        &format!("#EXT-X-TARGETDURATION:{}", js_string(d)),
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        &format!("#EXTINF:{},", fixed3(d)),
        uri,
        "#EXT-X-ENDLIST",
        "",
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hls::{codec_string, hvc1};

    /// Where the desktop app's test fetched the manifest (through the engine's relay).
    const MPD_URL: &str = "http://127.0.0.1:62273/https/sbcdn3.hakunaymatata.com/dash/5238552786089955104_0_0_1080_h265_555/index.mpd";
    const DIR: &str = "http://127.0.0.1:62273/https/sbcdn3.hakunaymatata.com/dash/5238552786089955104_0_0_1080_h265_555/";
    const LOTR: &str = include_str!("../../tests/fixtures/lotr.mpd");
    const VIDEO_INIT: &[u8] = include_bytes!("../../tests/fixtures/init0.m4s");
    const AUDIO_INIT: &[u8] = include_bytes!("../../tests/fixtures/init3.m4s");

    /// The paths dash-test.ts used.
    struct Paths;
    impl HlsPaths for Paths {
        fn playlist(&self, r: &Rendition) -> String {
            format!("/watch/S/{}/{}.m3u8", if r.kind == MediaType::Video { 'v' } else { 'a' }, r.id)
        }
        fn init(&self, r: &Rendition) -> String {
            format!("/watch/S/init/{}.mp4", r.id)
        }
        fn segment(&self, r: &Rendition, i: usize) -> String {
            format!("/watch/S/seg/{}/{i}.m4s", r.id)
        }
    }

    fn lotr() -> DashManifest {
        parse_mpd(LOTR, MPD_URL).expect("the LOTR manifest parses")
    }

    #[test]
    fn iso_durations() {
        assert_eq!(iso_seconds("PT3H48M18.4S"), 3.0 * 3600.0 + 48.0 * 60.0 + 18.4);
        assert_eq!(iso_seconds("PT0.0S"), 0.0);
        assert_eq!(iso_seconds("P1DT2H"), 26.0 * 3600.0);
        assert_eq!(iso_seconds(" PT1M "), 60.0);
        for bad in ["", "P1H", "PT1S1M", "1S", "PT1.S", "P1Y"] {
            assert_eq!(iso_seconds(bad), 0.0, "{bad}");
        }
    }

    #[test]
    fn xml_reader() {
        let root = parse_xml("<a x=\"1&amp;2\"><b>t&lt;</b><c/></a>");
        let a = &root.children[0];
        assert_eq!(a.attrs["x"], "1&2");
        assert_eq!(a.children[0].text, "t<");
        assert_eq!(a.children[1].name, "c");

        let root = parse_xml(
            "<?xml version='1.0'?><!-- note --><!DOCTYPE x><mpd:MPD xmlns:mpd='urn:x' xlink:href = \"h\">\
             <![CDATA[<raw>]]>&#x41;&#66;&QUOT;&bogus;<Open><Inner></MPD>",
        );
        let mpd = root.child("MPD").expect("prefix dropped");
        assert_eq!(mpd.attr("xmlns:mpd"), Some("urn:x"));
        assert_eq!(mpd.attr("href"), Some("h"));
        assert_eq!(mpd.text, "<raw>AB\"&bogus;");
        // Unclosed elements close with their parent.
        assert_eq!(mpd.children[0].name, "Open");
        assert_eq!(mpd.children[0].children[0].name, "Inner");
        // A `<` that starts no tag is text.
        assert_eq!(parse_xml("<a>1 < 2</a>").children[0].text, "1 < 2");
    }

    #[test]
    fn lotr_manifest() {
        let d = lotr();
        assert_eq!(d.duration, 13698.4);
        let video: Vec<&Rendition> = d.renditions.iter().filter(|r| r.kind == MediaType::Video).collect();
        let audio: Vec<&Rendition> = d.renditions.iter().filter(|r| r.kind == MediaType::Audio).collect();
        assert_eq!((video.len(), audio.len()), (3, 1));
        for r in &d.renditions {
            let total: f64 = r.segments.iter().map(|s| s.duration).sum();
            assert!((total - d.duration).abs() < 10.0, "{}: segments cover the film ({total})", r.id);
        }
        for v in &video {
            assert_eq!(v.segments.len(), 2281, "{}", v.id);
            assert_eq!(v.codecs, "hev1");
            assert_eq!(v.frame_rate, Some(24000.0 / 1001.0));
        }
        assert_eq!(video[0].segments[0].url, format!("{DIR}chunk-stream0-00001.m4s"));
        assert_eq!(video[0].segments[2280].url, format!("{DIR}chunk-stream0-02281.m4s"));
        assert_eq!(video[0].init.as_deref(), Some(format!("{DIR}init-stream0.m4s").as_str()));
        assert_eq!((video[0].width, video[0].height, video[0].bandwidth), (Some(2580), Some(1080), 2_200_000.0));
        assert_eq!(video[1].height, Some(720));
        let a = audio[0];
        assert_eq!((a.id.as_str(), a.codecs.as_str(), a.lang.as_deref(), a.bandwidth), ("3", "mp4a.40.2", Some("eng"), 128_000.0));
        assert_eq!(a.init.as_deref(), Some(format!("{DIR}init-stream3.m4s").as_str()));
        assert_eq!(a.segments[0].duration, 239608.0 / 48000.0);
    }

    #[test]
    fn lotr_playlists() {
        let d = lotr();
        let (vc, ac) = (codec_string(VIDEO_INIT).expect("video codec"), codec_string(AUDIO_INIT).expect("audio codec"));
        assert_eq!(vc, "hvc1.1.6.L150.90");
        assert_eq!(ac, "mp4a.40.2");
        let patched = hvc1(VIDEO_INIT);
        assert_eq!(patched.len(), VIDEO_INIT.len());
        let has = |b: &[u8], what: &[u8]| b.windows(4).any(|w| w == what);
        assert!(has(VIDEO_INIT, b"hev1"));
        assert!(has(&patched, b"hvc1") && !has(&patched, b"hev1"), "hev1 relabelled");
        assert_eq!(codec_string(&patched).as_deref(), Some("hvc1.1.6.L150.90"));

        let subs = SubtitleTrack { uri: "/watch/S/subs.m3u8".into(), name: "English".into(), lang: Some("en".into()) };
        let codecs = |r: &Rendition| if r.kind == MediaType::Video { vc.clone() } else { ac.clone() };
        let master = master_playlist(&d, codecs, &Paths, Some(&subs));
        assert!(master.contains("CODECS=\"hvc1.1.6.L150.90,mp4a.40.2\""));
        assert!(master.contains(
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,AUTOSELECT=YES,URI=\"/watch/S/a/3.m3u8\"\n"
        ));
        assert!(master.contains(
            "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI=\"/watch/S/subs.m3u8\"\n"
        ));
        // Nearest 720p first, then 480p, then 1080p.
        let variants: Vec<&str> = master.lines().filter(|l| l.starts_with("/watch/S/v/")).collect();
        assert_eq!(variants, ["/watch/S/v/1.m3u8", "/watch/S/v/2.m3u8", "/watch/S/v/0.m3u8"]);
        assert!(master.contains(
            "#EXT-X-STREAM-INF:BANDWIDTH=1008000,RESOLUTION=1720x720,FRAME-RATE=23.976,CODECS=\"hvc1.1.6.L150.90,mp4a.40.2\",AUDIO=\"audio\",SUBTITLES=\"subs\"\n/watch/S/v/1.m3u8\n"
        ));
        assert!(master.starts_with("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n") && master.ends_with(".m3u8\n"));

        let video = d.renditions.iter().find(|r| r.id == "0").expect("rendition 0");
        let media = media_playlist(video, &Paths);
        assert!(media.contains("#EXT-X-ENDLIST") && media.contains("#EXT-X-MAP:URI=\"/watch/S/init/0.mp4\""));
        assert!(media.starts_with(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:7\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n\
             #EXT-X-MAP:URI=\"/watch/S/init/0.mp4\"\n#EXTINF:5.964,\n/watch/S/seg/0/0.m4s\n#EXTINF:5.923,\n/watch/S/seg/0/1.m4s\n"
        ));
        assert!(media.ends_with("#EXTINF:4.922,\n/watch/S/seg/0/2280.m4s\n#EXT-X-ENDLIST\n"));

        assert_eq!(
            subtitle_playlist("/watch/S/subs.vtt", d.duration),
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:13699\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:13699.000,\n/watch/S/subs.vtt\n#EXT-X-ENDLIST\n"
        );
    }

    #[test]
    fn templates() {
        assert_eq!(fill("c-$RepresentationID$-$Number%05d$.m4s", "v1", 0.0, 7.0, 0.0), "c-v1-00007.m4s");
        assert_eq!(fill("$Time$_$Bandwidth%08d$_$$_$RepresentationID%03d$", "a", 128000.0, 1.0, 9009.0), "9009_00128000_$_a");
        assert_eq!(fill("$Number%02d$|$Unknown$|$Number", "a", 0.0, 123.0, 0.0), "123|$Unknown$|$Number");
        assert_eq!(fill("$Bandwidth%05d$", "a", f64::NAN, 0.0, 0.0), "00NaN");
    }

    #[test]
    fn manifest_layouts() {
        // No timeline: segments from @duration; BaseURLs chained; set template, own overrides.
        let xml = r#"<MPD mediaPresentationDuration="PT10S"><BaseURL>https://cdn.test/a/</BaseURL><Period>
            <BaseURL>p/</BaseURL>
            <AdaptationSet mimeType="video/mp4" codecs="avc1.640028" lang="und">
              <SegmentTemplate timescale="1000" duration="4000" startNumber="0" media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4"/>
              <Representation id="hd" bandwidth="3000000" width="1920" height="1080"><BaseURL>../q/</BaseURL></Representation>
              <Representation id="sd" bandwidth="800000"><SegmentTemplate media="sd-$Time$.m4s"/></Representation>
            </AdaptationSet>
            <AdaptationSet contentType="audio" lang="kat"><Label> Dub </Label>
              <Representation bandwidth="96000"><SegmentTemplate timescale="10" startNumber="5" media="a$Number$.m4s">
                <SegmentTimeline><S t="0" d="30" r="-1"/></SegmentTimeline></SegmentTemplate></Representation>
            </AdaptationSet>
            <AdaptationSet contentType="text"><Representation id="t"/></AdaptationSet>
          </Period></MPD>"#;
        let d = parse_mpd(xml, "https://origin.test/x/index.mpd").expect("parses");
        assert_eq!(d.duration, 10.0);
        let [hd, sd, audio] = [&d.renditions[0], &d.renditions[1], &d.renditions[2]];
        assert_eq!(d.renditions.len(), 3);
        let urls = |r: &Rendition| r.segments.iter().map(|s| s.url.clone()).collect::<Vec<_>>();
        assert_eq!(urls(hd), ["https://cdn.test/a/q/hd/0.m4s", "https://cdn.test/a/q/hd/1.m4s", "https://cdn.test/a/q/hd/2.m4s"]);
        assert_eq!(hd.segments.iter().map(|s| s.duration).collect::<Vec<_>>(), [4.0, 4.0, 2.0]);
        assert_eq!(hd.init.as_deref(), Some("https://cdn.test/a/q/hd/init.mp4"));
        assert_eq!(urls(sd), ["https://cdn.test/a/p/sd-0.m4s", "https://cdn.test/a/p/sd-4000.m4s", "https://cdn.test/a/p/sd-8000.m4s"]);
        assert_eq!((sd.codecs.as_str(), sd.width), ("avc1.640028", None));
        // r="-1" repeats to the end of the period; the id defaults to the position.
        assert_eq!(audio.id, "2");
        assert_eq!(urls(audio), ["https://cdn.test/a/p/a5.m4s", "https://cdn.test/a/p/a6.m4s", "https://cdn.test/a/p/a7.m4s", "https://cdn.test/a/p/a8.m4s"]);
        assert_eq!((audio.label.as_deref(), audio.init.as_deref()), (Some("Dub"), None));
        assert_eq!(language_tag(audio.lang.as_deref()).as_deref(), Some("ka"));
        assert_eq!(language_tag(hd.lang.as_deref()), None);

        let master = master_playlist(&d, |r| r.codecs.clone(), &Paths, None);
        assert!(master.contains("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"Dub\",LANGUAGE=\"ka\",DEFAULT=YES,AUTOSELECT=YES,URI=\"/watch/S/a/2.m3u8\""));
        assert!(master.contains("#EXT-X-STREAM-INF:BANDWIDTH=896000,CODECS=\"avc1.640028\",AUDIO=\"audio\"\n/watch/S/v/sd.m3u8"));
        assert!(!master.contains("SUBTITLES"));

        for (xml, error) in [
            ("<x/>", "could not be read"),
            ("<MPD type=\"dynamic\"><Period/></MPD>", "Live DASH"),
            ("<MPD/>", "no content"),
            ("<MPD><Period><AdaptationSet mimeType=\"audio/mp4\"><Representation/></AdaptationSet></Period></MPD>", "layout"),
            ("<MPD><Period><AdaptationSet mimeType=\"video/mp4\"><SegmentTemplate duration=\"1\"/><Representation/></AdaptationSet></Period></MPD>", "names no segments"),
            ("<MPD><Period><AdaptationSet mimeType=\"video/mp4\"><SegmentTemplate media=\"$Number$\"/><Representation/></AdaptationSet></Period></MPD>", "no segment timing"),
            ("<MPD><Period><AdaptationSet mimeType=\"audio/mp4\"><SegmentTemplate media=\"$Number$\" duration=\"1\"/><Representation/></AdaptationSet></Period></MPD>", "no segment timing"),
            ("<MPD><Period duration=\"PT1S\"><AdaptationSet mimeType=\"audio/mp4\"><SegmentTemplate media=\"$Number$\" duration=\"1\"/><Representation/></AdaptationSet></Period></MPD>", "no video"),
            ("<MPD><Period><AdaptationSet mimeType=\"video/mp4\"><SegmentTemplate media=\"$Number$\"><SegmentTimeline><S d=\"1\" r=\"9999999\"/></SegmentTimeline></SegmentTemplate><Representation/></AdaptationSet></Period></MPD>", "more than"),
        ] {
            let e = parse_mpd(xml, MPD_URL).expect_err(xml);
            assert!(e.contains(error), "{xml}: {e}");
        }
    }

    #[test]
    fn quality_cap() {
        let ids = |d: &DashManifest| d.renditions.iter().map(|r| r.id.as_str()).collect::<Vec<_>>().join(",");
        let capped = |cap: u64| {
            let mut d = lotr();
            cap_height(&mut d, cap);
            d
        };
        // LOTR: 0 = 1080p, 1 = 720p, 2 = 480p, 3 = audio.
        assert_eq!(ids(&capped(1080)), "0,1,2,3");
        assert_eq!(ids(&capped(720)), "1,2,3");
        assert_eq!(ids(&capped(719)), "2,3");
        // Nothing fits: the smallest stays.
        assert_eq!(ids(&capped(240)), "2,3");
        // What's left keeps the desktop order: nearest 720p first.
        let master = master_playlist(&capped(720), |_| String::new(), &Paths, None);
        let variants: Vec<&str> = master.lines().filter(|l| !l.starts_with('#')).collect();
        assert_eq!(variants, ["/watch/S/v/1.m3u8", "/watch/S/v/2.m3u8"]);

        // A video rendition without a height stays; one without any heights is left alone.
        let mut d = lotr();
        d.renditions[1].height = None;
        cap_height(&mut d, 240);
        assert_eq!(ids(&d), "1,2,3");
        let mut d = lotr();
        d.renditions.iter_mut().for_each(|r| r.height = None);
        cap_height(&mut d, 240);
        assert_eq!(ids(&d), "0,1,2,3");
    }

    #[test]
    fn numbers_as_javascript_writes_them() {
        assert_eq!(fixed3(5.0625), "5.063");
        assert_eq!(fixed3(0.1875), "0.188");
        assert_eq!(fixed3(1.0005), "1.000");
        assert_eq!(fixed3(24000.0 / 1001.0), "23.976");
        assert_eq!(fixed3(4.0), "4.000");
        assert_eq!(js_string(2281.0), "2281");
        assert_eq!(js_string(1.5), "1.5");
        assert_eq!(js_string(f64::NAN), "NaN");
        assert!(number("abc").is_nan() && number("inf").is_nan());
        assert_eq!((number(" 12 "), number(""), number("1e3")), (12.0, 0.0, 1000.0));
    }
}
