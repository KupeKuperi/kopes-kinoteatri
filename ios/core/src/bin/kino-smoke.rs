//! Smoke test of the core against live MovieBox, through the JSON contract the app uses:
//! version, search, details of the first result, streams, play stream 0 with English subtitles;
//! then the fetches AVPlayer makes to start: the playlist, its first variant and audio rendition,
//! their init and first segments, the subtitles (for a file: its first KiB).
//!
//! `--resolve-only` checks the engine bridge alone: instead of `play`, `engine::resolve`, then a GET
//! of the source with its headers (for MovieBox a DASH manifest), its first segments and subtitles.
//!
//! Usage: kino-smoke [--resolve-only] [query] [season episode]
//! Data folder: $KINO_DATA, else <temp>/kino-smoke. Engine log level: $KINO_LOG (default warn).
//! Exits 0 only when every step loaded. OWNER: agent "engine" (see GUIDE.md).

use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use kino_core::engine;
use reqwest::Url;
use serde_json::{Value, json};

const DEFAULT_QUERY: &str = "The Lord of the Rings: The Fellowship of the Ring";
const SUBTITLES: &str = "English";
/// Bodies are cut here, so a mistaken GET of a whole film can't run away.
const MAX_BODY: usize = 32 * 1024 * 1024;

struct Args {
    resolve_only: bool,
    query: String,
    episode: Option<(usize, usize)>,
}

fn main() -> ExitCode {
    init_logging();
    let args = match parse_args() {
        Ok(args) => args,
        Err(usage) => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(()) => {
            println!("\nSMOKE OK");
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("\nSMOKE FAILED: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `[--resolve-only] [query words…] [season episode]`: two trailing numbers are an episode.
fn parse_args() -> Result<Args, String> {
    let mut resolve_only = false;
    let mut words = Vec::new();
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--resolve-only" => resolve_only = true,
            "-h" | "--help" => return Err("usage: kino-smoke [--resolve-only] [query] [season episode]".into()),
            _ => words.push(arg),
        }
    }
    let mut episode = None;
    if let [.., season, number] = words.as_slice()
        && let (Ok(season), Ok(number)) = (season.parse(), number.parse())
    {
        episode = Some((season, number));
    }
    if episode.is_some() {
        words.truncate(words.len() - 2);
    }
    let query = if words.is_empty() { DEFAULT_QUERY.to_string() } else { words.join(" ") };
    Ok(Args { resolve_only, query, episode })
}

fn run(args: &Args) -> Result<(), String> {
    let dir = std::env::var("KINO_DATA")
        .ok()
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("kino-smoke"));
    println!("data folder: {}", dir.display());
    step("start", || kino_core::start(&dir.to_string_lossy()))?;
    let net = Net::new()?;

    let version = step("version", || call(json!({ "op": "version" })))?;
    println!("  {version}");

    let search = json!({ "op": "search", "query": args.query });
    let results = step(&format!("search {:?}", args.query), || call(search))?;
    let titles = results.as_array().cloned().unwrap_or_default();
    println!("  {} results", titles.len());
    for t in titles.iter().take(5) {
        let (title, year, kind) = (text(t, "title"), text(t, "year"), text(t, "kind"));
        println!("  - {title} ({year}, {kind}) rating {} id {}", text(t, "rating"), text(t, "id"));
    }
    let id = titles.first().and_then(|t| t["id"].as_str()).ok_or("search found nothing")?.to_string();

    let mut details = step("details of the first result", || call(json!({ "op": "details", "id": id })))?;
    print_details(&details);
    // With several dubs the TUI loads no streams until one is chosen, and its Audio pane
    // pre-selects Original, else English (tui/app/requests.rs DetailsSuccess). The app must too.
    let id = match preferred_audio(&details) {
        Some((label, audio_id)) if audio_id != id => {
            let request = json!({ "op": "details", "id": audio_id });
            details = step(&format!("audio {label} (the TUI's default): its details"), || call(request))?;
            print_details(&details);
            audio_id
        }
        Some((label, _)) => {
            println!("  audio {label} (the TUI's default) is this id");
            id
        }
        None => id,
    };
    let (season, episode) = match args.episode {
        Some(chosen) => chosen,
        None if details["kind"] == "series" => first_episode(&details).unwrap_or((1, 1)),
        None => (0, 0),
    };

    let listed = step(&format!("streams (season {season}, episode {episode})"), || {
        call(json!({ "op": "streams", "id": id, "season": season, "episode": episode }))
    })?;
    let streams = listed.as_array().cloned().unwrap_or_default();
    for s in &streams {
        let size = s["size_bytes"].as_u64().map_or("-".to_string(), human_size);
        println!(
            "  [{}] {} {} {} audio {}  {}",
            text(s, "index"),
            text(s, "quality"),
            text(s, "codec"),
            size,
            text(s, "audio"),
            text(s, "label")
        );
    }
    if streams.is_empty() {
        return Err("no streams".into());
    }

    if args.resolve_only {
        resolve_only(&net, &id, season, episode)
    } else {
        play(&net, &id, season, episode)
    }
}

fn print_details(d: &Value) {
    let (title, year, kind) = (text(d, "title"), text(d, "year"), text(d, "kind"));
    println!("  {title} ({year}, {kind})  rating {}  duration {}", text(d, "rating"), text(d, "duration"));
    let genres: Vec<&str> = d["genres"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let poster = if d["poster"].is_string() { "yes" } else { "no" };
    println!("  genres: {}  poster: {poster}", genres.join(", "));
    let description = text(d, "description");
    println!("  {}", description.chars().take(100).collect::<String>());
    let seasons = d["seasons"].as_array().cloned().unwrap_or_default();
    if !seasons.is_empty() {
        let counts: Vec<String> = seasons
            .iter()
            .map(|s| format!("S{}: {} ep", text(s, "season"), s["episodes"].as_array().map_or(0, Vec::len)))
            .collect();
        println!("  seasons: {}", counts.join(", "));
    }
    let track = |a: &Value| format!("{} ({})", text(a, "label"), text(a, "id"));
    let audio: Vec<String> = d["audio"].as_array().into_iter().flatten().map(track).collect();
    if !audio.is_empty() {
        println!("  audio: {}", audio.join(", "));
    }
}

/// The TUI's default audio track (label, id): Original, else English, else the first.
fn preferred_audio(details: &Value) -> Option<(String, String)> {
    let tracks: Vec<(String, String)> = details["audio"]
        .as_array()?
        .iter()
        .filter_map(|a| Some((a["label"].as_str()?.to_string(), a["id"].as_str()?.to_string())))
        .collect();
    let find = |patterns: &[&str]| {
        tracks
            .iter()
            .find(|(label, _)| {
                let label = label.to_ascii_lowercase();
                patterns.iter().any(|p| label.contains(p))
            })
            .cloned()
    };
    find(&["original", "orig"]).or_else(|| find(&["english", "eng"])).or_else(|| tracks.first().cloned())
}

fn first_episode(details: &Value) -> Option<(usize, usize)> {
    let season = details["seasons"].as_array()?.first()?;
    let episode = season["episodes"].as_array()?.first()?;
    Some((season["season"].as_u64()? as usize, episode["episode"].as_u64()? as usize))
}

// ── --resolve-only: the engine bridge alone ─────────────────────────────────

fn resolve_only(net: &Net, id: &str, season: usize, episode: usize) -> Result<(), String> {
    let source = step("resolve stream 0 (engine::resolve, subtitles English)", || {
        net.block_on(engine::resolve(id, season, episode, 0, Some(SUBTITLES)))
    })?;
    // Not part of `Source` (yet): the quality the TUI hands its player as a height cap.
    let playback = net.block_on(engine::playback(id, season, episode, 0, Some(SUBTITLES)));
    let cap = playback.ok().and_then(|p| p.source.max_height);
    println!("  title: {}", source.title);
    println!("  url: {}", source.url);
    for (name, value) in &source.headers {
        println!("  {name}: {}", shown_header(name, value));
    }
    println!("  subtitles: {}", source.subtitle_url.as_deref().map_or("none".to_string(), short_url));
    println!("  height cap (TUI's max_height): {}", cap.map_or("none".to_string(), |h| h.to_string()));

    let manifest_like = moviebox_like_manifest(&source.url);
    let range = if manifest_like { None } else { Some("bytes=0-1023") };
    let got = step("GET the source with its headers", || net.get(&source.url, &source.headers, range))?;
    println!("  HTTP {}  {}  {} bytes", got.status, got.content_type, got.body.len());
    if !got.ok() {
        return Err(format!("the source answered HTTP {}", got.status));
    }
    let body = String::from_utf8_lossy(&got.body);
    if body.contains("<MPD") {
        check_dash(net, &source.url, &body, &source.headers)?;
    } else if body.trim_start().starts_with("#EXTM3U") {
        println!("  an HLS playlist");
    } else {
        println!("  a file: its first {} bytes loaded", got.body.len());
    }

    match &source.subtitle_url {
        Some(url) => {
            let headers = subtitle_headers(url, &source.headers);
            let sub = step("GET the subtitles (engine's header rule)", || net.get(url, &headers, None))?;
            let text = String::from_utf8_lossy(&sub.body);
            let first: String = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(60).collect();
            let first = first.trim_start_matches('\u{feff}');
            println!("  HTTP {}  {} bytes  first line {first:?}", sub.status, sub.body.len());
            if !sub.ok() || sub.body.is_empty() {
                return Err(format!("the subtitles answered HTTP {}", sub.status));
            }
        }
        None => println!("\n(no {SUBTITLES} subtitles for this release)"),
    }
    Ok(())
}

/// The engine's own test for a DASH address (player::is_dash_url), plus HLS playlists.
fn moviebox_like_manifest(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.ends_with(".mpd") || path.contains("/dash/") || path.ends_with(".m3u8")
}

/// The first video and audio representations of the manifest load with the source's headers:
/// their init segments and first media segments (what the stream server will fetch).
fn check_dash(net: &Net, mpd_url: &str, mpd: &str, headers: &[(String, String)]) -> Result<(), String> {
    let reps = representations(mpd);
    let heights: Vec<String> = reps.iter().filter(|r| r.kind == "video").map(|r| r.height.clone()).collect();
    let codecs: Vec<&str> = reps.iter().map(|r| r.codecs.as_str()).collect();
    println!(
        "  DASH: {} video ({}), {} audio; codecs {}",
        heights.len(),
        heights.join("/"),
        reps.iter().filter(|r| r.kind == "audio").count(),
        codecs.join(", ")
    );
    let init = attr(mpd, "initialization").ok_or("no SegmentTemplate initialization in the manifest")?;
    let media = attr(mpd, "media").ok_or("no SegmentTemplate media in the manifest")?;
    let start: u64 = attr(mpd, "startNumber").and_then(|n| n.parse().ok()).unwrap_or(1);
    let base = Url::parse(mpd_url).map_err(|e| format!("bad source url: {e}"))?;
    for kind in ["video", "audio"] {
        let Some(rep) = reps.iter().find(|r| r.kind == kind) else {
            return Err(format!("no {kind} representation"));
        };
        let init_url = join(&base, &fill_template(&init, &rep.id, start))?;
        let name = format!("GET {kind} init segment (representation {})", rep.id);
        let got = step(&name, || net.get(&init_url, headers, None))?;
        let entries = sample_entries(&got.body);
        println!("  HTTP {}  {} bytes  sample entries {entries:?}", got.status, got.body.len());
        if !got.ok() {
            return Err(format!("{kind} init segment: HTTP {}", got.status));
        }
        let first_url = join(&base, &fill_template(&media, &rep.id, start))?;
        let started = Instant::now();
        let name = format!("GET {kind} first segment (the engine's way: 95 KiB ranges, 16 at a time)");
        let got = step(&name, || net.get_in_ranges(&first_url, headers))?;
        println!("  HTTP {}  {} bytes  {:.0} KiB/s", got.status, got.body.len(), kib_per_s(got.body.len(), started));
        if !got.ok() || got.body.is_empty() {
            return Err(format!("{kind} first segment: HTTP {}", got.status));
        }
        // For comparison ($KINO_SMOKE_PLAIN_GET): the same segment in one plain request.
        if std::env::var_os("KINO_SMOKE_PLAIN_GET").is_some() {
            let started = Instant::now();
            let name = format!("GET {kind} first segment again, one plain request");
            let plain = step(&name, || net.get(&first_url, headers, None))?;
            let rate = kib_per_s(plain.body.len(), started);
            println!("  HTTP {}  {} bytes  {rate:.0} KiB/s", plain.status, plain.body.len());
        }
    }
    Ok(())
}

struct Representation {
    id: String,
    kind: String,
    height: String,
    codecs: String,
}

/// Each `<Representation>` with its id, codecs, height and kind (its mimeType, else its
/// AdaptationSet's contentType).
fn representations(mpd: &str) -> Vec<Representation> {
    let mut reps = Vec::new();
    let mut set_kind = String::new();
    for (i, _) in mpd.match_indices('<') {
        let tag = &mpd[i..mpd[i..].find('>').map_or(mpd.len(), |end| i + end)];
        if tag.starts_with("<AdaptationSet") {
            set_kind = attr(tag, "contentType").or_else(|| attr(tag, "mimeType")).unwrap_or_default();
        } else if tag.starts_with("<Representation") {
            let kind = attr(tag, "mimeType").unwrap_or_else(|| set_kind.clone());
            reps.push(Representation {
                id: attr(tag, "id").unwrap_or_default(),
                kind: kind.split('/').next().unwrap_or("").to_string(),
                height: attr(tag, "height").unwrap_or_default(),
                codecs: attr(tag, "codecs").unwrap_or_default(),
            });
        }
    }
    reps
}

/// The first `name="value"` in `xml`.
fn attr(xml: &str, name: &str) -> Option<String> {
    let needle = format!(" {name}=\"");
    let start = xml.find(&needle)? + needle.len();
    let len = xml[start..].find('"')?;
    Some(xml[start..start + len].to_string())
}

/// A SegmentTemplate address for one representation and segment number (`$Number%05d$` and the like).
fn fill_template(template: &str, rep_id: &str, number: u64) -> String {
    let mut out = template.replace("$RepresentationID$", rep_id);
    if let Some(start) = out.find("$Number")
        && let Some(len) = out[start + 1..].find('$')
    {
        let end = start + 1 + len;
        let spec = &out[start + "$Number".len()..end];
        let width: usize = spec.strip_prefix("%0").and_then(|w| w.strip_suffix('d')?.parse().ok()).unwrap_or(0);
        out.replace_range(start..=end, &format!("{number:0width$}"));
    }
    out
}

/// The sample entries an init segment declares (Apple's player wants HEVC as `hvc1`, not `hev1`).
fn sample_entries(init: &[u8]) -> Vec<&'static str> {
    ["hvc1", "hev1", "avc1", "avc3", "mp4a", "ec-3", "ac-3", "Opus"]
        .into_iter()
        .filter(|tag| init.windows(4).any(|w| w == tag.as_bytes()))
        .collect()
}

/// The headers the engine sends with a subtitle download (service.rs download_subtitle_file): all
/// of the source's when the subtitle is on the Referer's host, else only User-Agent and Referer.
fn subtitle_headers(subtitle_url: &str, headers: &[(String, String)]) -> Vec<(String, String)> {
    let host = |url: &str| Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string));
    let referer = headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("referer"));
    let referer_host = referer.and_then(|(_, v)| host(v));
    let same_host = referer_host.is_some() && referer_host == host(subtitle_url);
    let forwarded = |n: &str| same_host || n.eq_ignore_ascii_case("user-agent") || n.eq_ignore_ascii_case("referer");
    headers.iter().filter(|(n, _)| forwarded(n)).cloned().collect()
}

// ── play: the whole core, as AVPlayer sees it ───────────────────────────────

fn play(net: &Net, id: &str, season: usize, episode: usize) -> Result<(), String> {
    let request = json!({
        "op": "play", "id": id, "season": season, "episode": episode, "stream": 0, "subtitles": SUBTITLES
    });
    let play = step("play stream 0 (subtitles English)", || call(request))?;
    let url = play["url"].as_str().ok_or("play gave no url")?.to_string();
    println!("  session {}  kind {}  title {}", text(&play, "session"), text(&play, "kind"), text(&play, "title"));
    println!("  url: {url}");
    println!("  subtitles: {}", text(&play, "subtitles"));
    let outcome = fetch_like_avplayer(net, &url, play["kind"] == "file", play["subtitles"].as_str());
    let _ = call(json!({ "op": "stop", "session": play["session"] }));
    outcome
}

/// What AVPlayer fetches to start playing, without headers of its own (the local server adds them).
fn fetch_like_avplayer(net: &Net, url: &str, is_file: bool, subtitles: Option<&str>) -> Result<(), String> {
    if is_file {
        let got = step("GET the file's first KiB", || net.get(url, &[], Some("bytes=0-1023")))?;
        println!("  HTTP {}  {}  {} bytes", got.status, got.content_type, got.body.len());
        if !got.ok() || got.body.is_empty() {
            return Err(format!("the file answered HTTP {}", got.status));
        }
    } else {
        let got = step("GET the playlist", || net.get(url, &[], None))?;
        println!("  HTTP {}  {}  {} bytes", got.status, got.content_type, got.body.len());
        let playlist = String::from_utf8_lossy(&got.body).into_owned();
        if !got.ok() || !playlist.trim_start().starts_with("#EXTM3U") {
            return Err(format!("not an HLS playlist (HTTP {})", got.status));
        }
        let base = Url::parse(url).map_err(|e| format!("bad play url: {e}"))?;
        if playlist.contains("#EXT-X-STREAM-INF") {
            let mut lines = playlist.lines();
            let variant = lines
                .by_ref()
                .find(|l| l.starts_with("#EXT-X-STREAM-INF"))
                .and_then(|_| lines.find(|l| !l.trim().is_empty() && !l.starts_with('#')))
                .ok_or("a master playlist without variants")?;
            println!(
                "  master: {} variants, {} audio, {} subtitles",
                playlist.matches("#EXT-X-STREAM-INF").count(),
                playlist.lines().filter(|l| l.contains("TYPE=AUDIO")).count(),
                playlist.lines().filter(|l| l.contains("TYPE=SUBTITLES")).count()
            );
            check_media_playlist(net, &join(&base, variant.trim())?, "video")?;
            for (kind, label) in [("TYPE=AUDIO", "audio"), ("TYPE=SUBTITLES", "subtitles")] {
                let rendition = playlist.lines().find(|l| l.starts_with("#EXT-X-MEDIA") && l.contains(kind));
                if let Some(uri) = rendition.and_then(quoted_uri) {
                    check_media_playlist(net, &join(&base, &uri)?, label)?;
                }
            }
        } else {
            check_media_playlist(net, url, "media")?;
        }
    }
    if let Some(sub) = subtitles {
        let got = step("GET the subtitles", || net.get(sub, &[], None))?;
        let head = String::from_utf8_lossy(&got.body[..got.body.len().min(64)]).into_owned();
        let first_line = head.lines().next().unwrap_or("");
        println!("  HTTP {}  {} bytes  starts {first_line:?}", got.status, got.body.len());
        if !got.ok() || !head.trim_start_matches('\u{feff}').starts_with("WEBVTT") {
            return Err(format!("subtitles aren't WebVTT (HTTP {})", got.status));
        }
    }
    Ok(())
}

/// `URI="…"` inside an HLS tag line (attributes there have no leading space after a comma).
fn quoted_uri(line: &str) -> Option<String> {
    let start = line.find("URI=\"")? + 5;
    let len = line[start..].find('"')?;
    Some(line[start..start + len].to_string())
}

/// A media playlist, its EXT-X-MAP init segment and its first segment.
fn check_media_playlist(net: &Net, url: &str, what: &str) -> Result<(), String> {
    let got = step(&format!("GET the {what} playlist"), || net.get(url, &[], None))?;
    let playlist = String::from_utf8_lossy(&got.body).into_owned();
    println!("  HTTP {}  {} segments", got.status, playlist.matches("#EXTINF").count());
    if !got.ok() || !playlist.trim_start().starts_with("#EXTM3U") {
        return Err(format!("{what} playlist: HTTP {}", got.status));
    }
    let base = Url::parse(url).map_err(|e| format!("bad playlist url: {e}"))?;
    if let Some(map) = playlist.lines().find(|l| l.starts_with("#EXT-X-MAP")).and_then(quoted_uri) {
        let map_url = join(&base, &map)?;
        let got = step(&format!("GET the {what} init segment"), || net.get(&map_url, &[], None))?;
        let entries = sample_entries(&got.body);
        println!("  HTTP {}  {} bytes  sample entries {entries:?}", got.status, got.body.len());
        if !got.ok() {
            return Err(format!("{what} init segment: HTTP {}", got.status));
        }
        if entries.contains(&"hev1") && !entries.contains(&"hvc1") {
            return Err(format!("the {what} init segment says hev1: Apple's player needs hvc1"));
        }
    }
    let first = playlist.lines().find(|l| !l.trim().is_empty() && !l.starts_with('#'));
    let first_url = join(&base, first.ok_or(format!("the {what} playlist has no segments"))?.trim())?;
    let got = step(&format!("GET the first {what} segment"), || net.get(&first_url, &[], None))?;
    println!("  HTTP {}  {} bytes", got.status, got.body.len());
    if !got.ok() || got.body.is_empty() {
        return Err(format!("first {what} segment: HTTP {}", got.status));
    }
    Ok(())
}

// ── Plumbing ─────────────────────────────────────────────────────────────────

/// Runs one step, then prints its name and how long it took; errors name the step.
fn step<T>(name: &str, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let started = Instant::now();
    let result = work();
    println!("\n== {name} ({} ms)", started.elapsed().as_millis());
    result.map_err(|e| format!("{name}: {e}"))
}

/// One request through the JSON contract: the answer's `value`, or its `error`.
fn call(request: Value) -> Result<Value, String> {
    let answer = kino_core::call(&request.to_string());
    let answer: Value = serde_json::from_str(&answer).map_err(|e| format!("unreadable answer: {e}"))?;
    if answer["ok"] == true {
        Ok(answer["value"].clone())
    } else {
        Err(answer["error"].as_str().unwrap_or("error without a message").to_string())
    }
}

/// A field for printing: strings bare, null as "-".
fn text(value: &Value, key: &str) -> String {
    match &value[key] {
        Value::Null => "-".to_string(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn kib_per_s(bytes: usize, started: Instant) -> f64 {
    bytes as f64 / 1024.0 / started.elapsed().as_secs_f64().max(0.001)
}

fn human_size(bytes: u64) -> String {
    let mib = bytes as f64 / 1_048_576.0;
    if mib >= 1024.0 { format!("{:.1} GB", mib / 1024.0) } else { format!("{mib:.0} MB") }
}

/// An address without its query (CDN signatures), for printing.
fn short_url(url: &str) -> String {
    url.split(['?', '#']).next().unwrap_or(url).to_string()
}

/// Header values for printing: the CDN cookie only by its length and, for an Edge-Cache-Cookie
/// (`…:sign=…:t=<unix time>`), how long ago it was signed (`t` is the signing time, not an expiry).
fn shown_header(name: &str, value: &str) -> String {
    if !name.eq_ignore_ascii_case("cookie") {
        return value.to_string();
    }
    let signed = value.split([':', ';']).find_map(|part| part.trim().strip_prefix("t=")?.parse::<i64>().ok());
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
    match signed {
        Some(t) => format!("<{} chars, signed {}s ago>", value.len(), now - t),
        None => format!("<{} chars>", value.len()),
    }
}

fn join(base: &Url, reference: &str) -> Result<String, String> {
    base.join(reference).map(String::from).map_err(|e| format!("bad address {reference:?}: {e}"))
}

/// The smoke test's HTTP side, standing in for AVPlayer (or, with --resolve-only, for the stream
/// server). It has its own runtime; `kino_core::call` must not run inside it.
struct Net {
    runtime: tokio::runtime::Runtime,
    client: reqwest::Client,
}

struct Fetched {
    status: u16,
    content_type: String,
    body: Vec<u8>,
    /// The whole resource's size, from a ranged answer's Content-Range.
    total_size: Option<usize>,
}

impl Fetched {
    fn ok(&self) -> bool {
        self.status == 200 || self.status == 206
    }
}

impl Net {
    fn new() -> Result<Net, String> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?;
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Net { runtime, client })
    }

    fn block_on<F: Future>(&self, work: F) -> F::Output {
        self.runtime.block_on(work)
    }

    /// A GET with the given headers and optional byte range; the body is cut at MAX_BODY.
    fn get(&self, url: &str, headers: &[(String, String)], range: Option<&str>) -> Result<Fetched, String> {
        self.block_on(async {
            let mut request = self.client.get(url);
            for (name, value) in headers {
                request = request.header(name.as_str(), value.as_str());
            }
            if let Some(range) = range {
                request = request.header("Range", range);
            }
            let mut response = request.send().await.map_err(|e| format!("GET {}: {e}", short_url(url)))?;
            let status = response.status().as_u16();
            let header = |name: reqwest::header::HeaderName| {
                response.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
            };
            let content_type = header(reqwest::header::CONTENT_TYPE);
            let content_range = header(reqwest::header::CONTENT_RANGE);
            let total_size = content_range.rsplit('/').next().and_then(|t| t.trim().parse().ok());
            let mut body = Vec::new();
            let read_error = |e: reqwest::Error| format!("reading {}: {e}", short_url(url));
            while let Some(chunk) = response.chunk().await.map_err(read_error)? {
                body.extend_from_slice(&chunk);
                if body.len() >= MAX_BODY {
                    break;
                }
            }
            Ok(Fetched { status, content_type, body, total_size })
        })
    }

    /// A DASH segment the way the engine's stream proxy fetches one (proxy.rs fetch_m4s_chunked):
    /// a first 95 KiB range tells the size, the rest comes in 95 KiB ranges, 16 at a time. The
    /// MovieBox CDN throttles each request; a single GET of a 1080p segment is slower than playback.
    fn get_in_ranges(&self, url: &str, headers: &[(String, String)]) -> Result<Fetched, String> {
        const CHUNK: usize = 95 * 1024;
        let first = self.get(url, headers, Some(&format!("bytes=0-{}", CHUNK - 1)))?;
        let total = first.total_size.filter(|&t| first.status == 206 && t > first.body.len() && t <= MAX_BODY);
        let Some(total) = total else {
            return Ok(first);
        };
        let starts = (first.body.len()..total).step_by(CHUNK);
        let ranges: Vec<(usize, usize)> = starts.map(|start| (start, (start + CHUNK - 1).min(total - 1))).collect();
        let mut body = first.body;
        for batch in ranges.chunks(16) {
            let parts = self.block_on(futures::future::try_join_all(batch.iter().map(|&(start, end)| {
                let mut request = self.client.get(url).header("Range", format!("bytes={start}-{end}"));
                for (name, value) in headers {
                    request = request.header(name.as_str(), value.as_str());
                }
                async move {
                    let response = request.send().await?.error_for_status()?;
                    response.bytes().await
                }
            })))
            .map_err(|e| format!("ranged GET {}: {e}", short_url(url)))?;
            for part in parts {
                body.extend_from_slice(&part);
            }
        }
        Ok(Fetched { status: 200, content_type: first.content_type, body, total_size: Some(total) })
    }
}

/// Engine log lines (MovieBox host failures and the like) on stderr, at $KINO_LOG or warn.
struct StderrLog;

impl log::Log for StderrLog {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("  [{} {}] {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

static LOGGER: StderrLog = StderrLog;

fn init_logging() {
    let level = std::env::var("KINO_LOG").ok().and_then(|l| l.parse().ok()).unwrap_or(log::LevelFilter::Warn);
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(level);
    }
}
