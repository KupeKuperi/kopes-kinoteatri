//! The local stream server AVPlayer plays from (127.0.0.1): relays each play with its source's
//! headers, DASH as HLS. A port of the desktop relay (src/main/phone/relay.ts) without what only
//! exists there (the engine's player stand-in, idle timers): a play lives from `open` to `close`.
//! Two things the engine's own relay did for the desktop are done here too: DASH fetched in ranges
//! (MovieBox's CDN is slow per connection) and the picked quality as a height cap.
//! OWNER: agent "hls" (see GUIDE.md).
//!
//! Under /s/<session>/:
//! - `master.m3u8`: DASH, written from the manifest; HLS, the source's own with its links pointed here
//! - `v/<rep>.m3u8`, `a/<rep>.m3u8`: a DASH rendition's media playlist
//! - `init/<rep>.mp4`: its initialization segment, HEVC relabelled hvc1 (fetched once per play)
//! - `seg/<rep>/<i>.m4s`: its segment `i`, streamed (fetched in ranges: see `segment`)
//! - `subs.m3u8`, `subs.vtt`: the subtitles, as WebVTT
//! - `h/<base64url(url)>[.m3u8]`: HLS, a playlist or file named in a rewritten playlist (only those)
//! - `video`: a file (MP4…), seeking (Range) passed both ways
//!
//! An upstream 403 reaches AVPlayer as 403: MovieBox's CDN cookie is signed and runs out, and the
//! app tells that apart from a broken stream.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::Poll;
use std::time::Duration;

use bytes::Bytes;
use futures::{FutureExt, Stream, StreamExt, TryStreamExt};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use reqwest::Url;
use tokio::net::TcpListener;
use tokio::sync::{OnceCell, watch};

use crate::api::{Play, Source};
use crate::hls::{self, DashManifest, HlsPaths, MediaType, Rendition, SubtitleTrack};

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Body = UnsyncBoxBody<Bytes, BoxError>;

const PLAYLIST: &str = "application/vnd.apple.mpegurl";
const MP4: &str = "video/mp4";
const VTT: &str = "text/vtt; charset=utf-8";
const TEXT: &str = "text/plain; charset=utf-8";

/// Manifests, playlists, init segments and subtitles are read whole; real ones are far smaller.
const MAX_DOCUMENT: usize = 16 * 1024 * 1024;
/// Reading one of those takes no longer than this.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// A streamed resource starts answering within this…
const ANSWER_TIMEOUT: Duration = Duration::from_secs(30);
/// …and never goes quiet for longer than this.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
/// MovieBox's CDN slows every connection to about 130 KiB/s, far below a 1080p stream: segments
/// (and the manifest) come in 95 KiB ranges, 16 at a time, as the engine's own relay fetches them
/// (over 2 MiB/s).
const RANGE_BYTES: u64 = 95 * 1024;
const RANGES_AT_ONCE: usize = 16;
/// Plays left open (the app closes each one); beyond this the oldest is let go.
const MAX_SESSIONS: usize = 8;
/// What AVPlayer's subtitle menu calls the track: a Source doesn't say which language it is.
const SUBTITLE_NAME: &str = "Subtitles";

pub struct Server {
    shared: Arc<Shared>,
    accept: tokio::task::AbortHandle,
}

struct Shared {
    port: u16,
    client: reqwest::Client,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    opened: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dash,
    Hls,
    File,
}

/// One play: its stream, the headers the source wants, and what was learnt about it.
struct Session {
    id: String,
    url: String,
    headers: HeaderMap,
    kind: Kind,
    /// DASH: the picked quality; taller renditions are left out of the manifest.
    max_height: Option<u64>,
    /// Open order: the oldest is let go first.
    serial: u64,
    dash: OnceCell<Arc<DashManifest>>,
    /// DASH: each rendition's initialization segment, relabelled.
    inits: Mutex<HashMap<String, Arc<OnceCell<Bytes>>>>,
    /// DASH: each rendition's full codec string.
    codecs: Mutex<HashMap<String, String>>,
    /// HLS: the links its playlists were rewritten from (only those are relayed).
    allowed: Mutex<HashSet<String>>,
    vtt: Option<String>,
    /// Becomes true when the play is closed: its streams are cut.
    closed: watch::Sender<bool>,
}

/// A request that failed: the message (a play that can't open shows it) and the status AVPlayer
/// gets: 502, or the upstream's own 403.
#[derive(Debug)]
struct Failure {
    status: StatusCode,
    message: String,
}

impl From<String> for Failure {
    fn from(message: String) -> Failure {
        Failure { status: StatusCode::BAD_GATEWAY, message }
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Failure {
        Failure::from(message.to_string())
    }
}

/// An upstream answer other than the one wanted.
fn answered(status: StatusCode) -> Failure {
    let passed_on = if status == StatusCode::FORBIDDEN { status } else { StatusCode::BAD_GATEWAY };
    Failure { status: passed_on, message: format!("The stream answered {}.", status.as_u16()) }
}

impl Server {
    /// Listens on 127.0.0.1 (a free port) and serves on the tokio runtime it's called on.
    pub async fn start() -> Result<Server, String> {
        let cant = |e: &dyn std::fmt::Display| format!("The stream server can't start: {e}");
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.map_err(|e| cant(&e))?;
        let port = listener.local_addr().map_err(|e| cant(&e))?.port();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(STALL_TIMEOUT)
            // Redirects keep the source's Referer (reqwest would put the previous URL there).
            .referer(false)
            // A relay passes bytes as they are: lengths and ranges must stay true.
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .build()
            .map_err(|e| cant(&e))?;
        let shared = Arc::new(Shared { port, client, sessions: Mutex::default(), opened: AtomicU64::new(0) });
        let accept = tokio::spawn(accept(listener, shared.clone())).abort_handle();
        Ok(Server { shared, accept })
    }

    pub fn port(&self) -> u16 {
        self.shared.port
    }

    /// A new play of `source`: works out what the stream is (DASH, HLS or a file), fetches its
    /// subtitles, and for DASH reads the manifest and codecs now, so a stream that can't play
    /// says why here rather than in a silent player.
    pub async fn open(&self, source: Source) -> Result<Play, String> {
        let shared = &self.shared;
        let url = Url::parse(&source.url).map_err(|_| "The stream's address isn't valid.".to_string())?;
        let headers = upstream_headers(&source.headers);
        let (kind, vtt) = tokio::join!(
            sniff(&shared.client, &url, &headers),
            subtitles(&shared.client, source.subtitle_url.as_deref(), &headers)
        );
        let session = Arc::new(Session {
            id: session_id(),
            url: source.url,
            headers,
            kind,
            max_height: source.max_height,
            serial: shared.opened.fetch_add(1, Ordering::Relaxed),
            dash: OnceCell::new(),
            inits: Mutex::default(),
            codecs: Mutex::default(),
            allowed: Mutex::default(),
            vtt,
            closed: watch::channel(false).0,
        });
        if kind == Kind::Dash {
            let d = manifest(shared, &session).await.map_err(|f| f.message)?;
            codecs(shared, &session, &d).await.map_err(|f| f.message)?;
        }
        let base = format!("http://127.0.0.1:{}/s/{}", shared.port, session.id);
        let play = Play {
            session: session.id.clone(),
            url: format!("{base}/{}", if kind == Kind::File { "video" } else { "master.m3u8" }),
            kind: if kind == Kind::File { "file" } else { "hls" }.into(),
            subtitles: session.vtt.as_ref().map(|_| format!("{base}/subs.vtt")),
            title: source.title,
        };
        shared.insert(session);
        Ok(play)
    }

    /// Ends a play: its addresses answer 410 and its running streams are cut.
    pub fn close(&self, session: &str) {
        let removed = lock(&self.shared.sessions).remove(session);
        if let Some(s) = removed {
            s.end();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl Shared {
    fn session(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.sessions).get(id).cloned()
    }

    fn insert(&self, session: Arc<Session>) {
        let mut sessions = lock(&self.sessions);
        while sessions.len() >= MAX_SESSIONS {
            let Some(oldest) = sessions.values().min_by_key(|s| s.serial).map(|s| s.id.clone()) else { break };
            if let Some(old) = sessions.remove(&oldest) {
                old.end();
            }
        }
        sessions.insert(session.id.clone(), session);
    }
}

impl Session {
    fn end(&self) {
        self.closed.send_replace(true);
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

async fn accept(listener: TcpListener, shared: Arc<Shared>) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                // Out of file descriptors and the like: wait a moment rather than spin.
                log::warn!("stream server: accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let shared = shared.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                let shared = shared.clone();
                async move { Ok::<_, Infallible>(respond(&shared, req).await) }
            });
            // Errors here are AVPlayer hanging up mid-answer.
            if let Err(e) = http1::Builder::new().timer(TokioTimer::new()).serve_connection(TokioIo::new(stream), service).await {
                log::debug!("stream server: connection ended: {e}");
            }
        });
    }
}

// ── HTTP: /s/<session>/… ─────────────────────────────────────────────────────────

async fn respond(shared: &Shared, req: Request<Incoming>) -> Response<Body> {
    route(shared, &req).await.unwrap_or_else(|f| {
        log::warn!("stream server: {}: {}", req.uri().path(), f.message);
        text(f.status, f.message)
    })
}

async fn route(shared: &Shared, req: &Request<Incoming>) -> Result<Response<Body>, Failure> {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return Ok(text(StatusCode::METHOD_NOT_ALLOWED, "Only GET and HEAD."));
    }
    let Some(rest) = req.uri().path().strip_prefix("/s/") else {
        return Ok(not_found());
    };
    let (id, what) = rest.split_once('/').unwrap_or((rest, ""));
    let Some(s) = shared.session(id) else {
        return Ok(text(StatusCode::GONE, "This play has ended."));
    };
    if what == "subs.vtt" {
        return Ok(match &s.vtt {
            Some(vtt) => send(StatusCode::OK, VTT, vtt.clone()),
            None => send(StatusCode::NOT_FOUND, VTT, ""),
        });
    }
    let parts: Vec<&str> = what.split('/').collect();
    match s.kind {
        Kind::File if what == "video" => pipe(shared, &s, req, &s.url, None).await,
        Kind::Hls if what == "master.m3u8" => playlist(shared, &s, &s.url).await,
        Kind::Hls if parts[0] == "h" && parts.get(1).is_some_and(|p| !p.is_empty()) => {
            // Links to playlists end in .m3u8 here; everything else is media.
            let link = parts[1];
            let is_playlist = link.ends_with(".m3u8");
            let url = b64url_decode(link.strip_suffix(".m3u8").unwrap_or(link)).and_then(|b| String::from_utf8(b).ok());
            let allowed = url.as_ref().is_some_and(|u| lock(&s.allowed).contains(u));
            match url {
                Some(url) if allowed && is_playlist => playlist(shared, &s, &url).await,
                Some(url) if allowed => pipe(shared, &s, req, &url, None).await,
                _ => Ok(text(StatusCode::FORBIDDEN, "Not part of this stream.")),
            }
        }
        Kind::Dash => dash(shared, &s, req, &parts).await,
        _ => Ok(not_found()),
    }
}

/// Playlist links for one play: absolute paths, so they work from any playlist.
struct SessionPaths<'a>(&'a str);

impl HlsPaths for SessionPaths<'_> {
    fn playlist(&self, r: &Rendition) -> String {
        let kind = if r.kind == MediaType::Video { "v" } else { "a" };
        format!("/s/{}/{kind}/{}.m3u8", self.0, encode_component(&r.id))
    }
    fn init(&self, r: &Rendition) -> String {
        format!("/s/{}/init/{}.mp4", self.0, encode_component(&r.id))
    }
    fn segment(&self, r: &Rendition, i: usize) -> String {
        format!("/s/{}/seg/{}/{i}.m4s", self.0, encode_component(&r.id))
    }
}

async fn dash(shared: &Shared, s: &Session, req: &Request<Incoming>, parts: &[&str]) -> Result<Response<Body>, Failure> {
    let d = manifest(shared, s).await?;
    let paths = SessionPaths(&s.id);
    let find = |id: &str| decode_component(id).and_then(|id| d.renditions.iter().find(|r| r.id == id));
    let (what, a, b) = (parts[0], parts.get(1).copied(), parts.get(2).copied());
    match (what, a, b) {
        ("master.m3u8", _, _) => {
            let codecs = codecs(shared, s, &d).await?;
            let subtitles = s.vtt.as_ref().map(|_| SubtitleTrack { uri: format!("/s/{}/subs.m3u8", s.id), name: SUBTITLE_NAME.into(), lang: None });
            let master = hls::master_playlist(&d, |r| codecs.get(&r.id).cloned().unwrap_or_default(), &paths, subtitles.as_ref());
            Ok(send(StatusCode::OK, PLAYLIST, master))
        }
        ("subs.m3u8", _, _) => Ok(send(StatusCode::OK, PLAYLIST, hls::subtitle_playlist(&format!("/s/{}/subs.vtt", s.id), d.duration))),
        ("v" | "a", Some(a), _) => match find(a.strip_suffix(".m3u8").unwrap_or(a)) {
            Some(r) => Ok(send(StatusCode::OK, PLAYLIST, hls::media_playlist(r, &paths))),
            None => Ok(not_found()),
        },
        ("init", Some(a), _) => match find(a.strip_suffix(".mp4").unwrap_or(a)) {
            Some(r) => Ok(send(StatusCode::OK, MP4, init(shared, s, r).await?)),
            None => Ok(not_found()),
        },
        ("seg", Some(a), Some(b)) => match find(a).zip(leading_number(b)).and_then(|(r, i)| r.segments.get(i)) {
            Some(found) => segment(shared, s, req, &found.url).await,
            None => Ok(not_found()),
        },
        _ => Ok(not_found()),
    }
}

/// The play's manifest, read once (a failed read is tried again on the next request), with the
/// renditions above the picked quality left out. Segment URLs are relative to where the manifest
/// was found after redirects.
async fn manifest(shared: &Shared, s: &Session) -> Result<Arc<DashManifest>, Failure> {
    let d = s
        .dash
        .get_or_try_init(|| async {
            let (found, body) = fetch_whole(shared, s, &s.url).await?;
            let mut d = hls::parse_mpd(&String::from_utf8_lossy(&body), found.as_str())?;
            if let Some(cap) = s.max_height.filter(|&h| h > 0) {
                hls::cap_height(&mut d, cap);
            }
            Ok::<_, Failure>(Arc::new(d))
        })
        .await?;
    Ok(d.clone())
}

/// A rendition's initialization segment, with HEVC labelled for Apple's player (fetched once).
async fn init(shared: &Shared, s: &Session, r: &Rendition) -> Result<Bytes, Failure> {
    let cell = lock(&s.inits).entry(r.id.clone()).or_default().clone();
    let init = cell
        .get_or_try_init(|| async {
            let url = r.init.as_deref().ok_or("No initialization segment.")?;
            let body = read_ok(fetch(shared, s, url).await?).await?;
            Ok::<_, Failure>(Bytes::from(hls::hvc1(&body)))
        })
        .await?;
    Ok(init.clone())
}

/// Every rendition's codec string, by rendition id.
async fn codecs(shared: &Shared, s: &Session, d: &DashManifest) -> Result<HashMap<String, String>, Failure> {
    let found = futures::future::try_join_all(d.renditions.iter().map(|r| codec(shared, s, r))).await?;
    Ok(d.renditions.iter().map(|r| r.id.clone()).zip(found).collect())
}

/// "hev1" alone (as MovieBox writes it) isn't enough for an HLS playlist: read the real codec.
async fn codec(shared: &Shared, s: &Session, r: &Rendition) -> Result<String, Failure> {
    let known = lock(&s.codecs).get(&r.id).cloned();
    if let Some(known) = known {
        return Ok(known);
    }
    let mut codec = if !r.codecs.contains('.') {
        String::new()
    } else if let Some(rest) = r.codecs.strip_prefix("hev1") {
        format!("hvc1{rest}")
    } else {
        r.codecs.clone()
    };
    if codec.is_empty() && r.init.is_some() {
        codec = hls::codec_string(&init(shared, s, r).await?).unwrap_or_default();
    }
    if codec.is_empty() {
        codec = if r.kind == MediaType::Audio { "mp4a.40.2".into() } else { r.codecs.clone() };
    }
    lock(&s.codecs).insert(r.id.clone(), codec.clone());
    Ok(codec)
}

/// An HLS playlist with its links pointed back here.
async fn playlist(shared: &Shared, s: &Session, url: &str) -> Result<Response<Body>, Failure> {
    let up = fetch(shared, s, url).await?;
    let status = up.status();
    let content_type = up.headers().get(header::CONTENT_TYPE).cloned();
    let base = up.url().clone();
    let body = read_body(up).await?;
    if !status.is_success() {
        return Ok(send(status, TEXT, body));
    }
    let text = String::from_utf8_lossy(&body);
    if !text.trim_start().starts_with("#EXTM3U") {
        return Ok(send_typed(status, content_type.unwrap_or(HeaderValue::from_static("application/octet-stream")), body));
    }
    let mut links = Vec::new();
    let rewritten = rewrite_playlist(&text, &base, &s.id, &mut links)?;
    lock(&s.allowed).extend(links);
    Ok(send(StatusCode::OK, PLAYLIST, rewritten))
}

/// The playlist with every link pointed here: variants and renditions as playlists (`.m3u8`),
/// everything else (segments, keys, init maps) as files. The absolute links are added to `links`.
fn rewrite_playlist(text: &str, base: &Url, session: &str, links: &mut Vec<String>) -> Result<String, String> {
    let mut point = |link: &str, is_playlist: bool| {
        let abs = String::from(base.join(link).map_err(|_| format!("The playlist has a bad link: {link}"))?);
        let here = format!("/s/{session}/h/{}{}", b64url_encode(abs.as_bytes()), if is_playlist { ".m3u8" } else { "" });
        links.push(abs);
        Ok::<_, String>(here)
    };
    let mut variant_next = false;
    let mut out = Vec::new();
    for line in text.split('\n') {
        let l = line.trim();
        if l.is_empty() {
            out.push(String::new());
        } else if l.starts_with('#') {
            variant_next = l.starts_with("#EXT-X-STREAM-INF");
            // Renditions and I-frame variants are playlists; keys and init maps are files.
            let playlist_tag = l.starts_with("#EXT-X-MEDIA:") || l.starts_with("#EXT-X-I-FRAME-STREAM-INF");
            out.push(replace_uris(l, |uri| point(uri, playlist_tag))?);
        } else {
            let path = base.join(l).map(|u| u.path().to_ascii_lowercase()).unwrap_or_default();
            out.push(point(l, variant_next || path.ends_with(".m3u8") || path.ends_with(".m3u"))?);
            variant_next = false;
        }
    }
    Ok(out.join("\n"))
}

/// Each `URI="…"` value in a tag line replaced by `with(value)`.
fn replace_uris(line: &str, mut with: impl FnMut(&str) -> Result<String, String>) -> Result<String, String> {
    let mut out = String::with_capacity(line.len() + 64);
    let mut rest = line;
    while let Some(at) = rest.find("URI=\"") {
        let start = at + 5;
        match rest[start..].find('"') {
            Some(len) if len > 0 => {
                out.push_str(&rest[..start]);
                out.push_str(&with(&rest[start..start + len])?);
                out.push('"');
                rest = &rest[start + len + 1..];
            }
            _ => {
                out.push_str(&rest[..=at]);
                rest = &rest[at + 1..];
            }
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// Streams one resource from upstream to AVPlayer, passing seeking (Range) both ways. When AVPlayer
/// hangs up, hyper drops the body and with it the upstream request.
async fn pipe(shared: &Shared, s: &Session, req: &Request<Incoming>, url: &str, content_type: Option<&'static str>) -> Result<Response<Body>, Failure> {
    let range = req.headers().get(header::RANGE).cloned();
    let head = req.method() == Method::HEAD;
    let mut up = shared.client.request(if head { Method::HEAD } else { Method::GET }, url).headers(s.headers.clone());
    if let Some(range) = &range {
        up = up.header(header::RANGE, range.clone());
    }
    let up = answer(up).await?;
    Ok(relay(up, s, url, content_type, range.is_some(), head))
}

/// Upstream's answer (not yet its body).
async fn answer(request: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    tokio::time::timeout(ANSWER_TIMEOUT, request.send())
        .await
        .map_err(|_| "The stream didn't answer in time.".to_string())?
        .map_err(failed)
}

/// Upstream's answer passed on as it came (an error status too): its status, length, range and
/// type, and its body streamed.
fn relay(up: reqwest::Response, s: &Session, url: &str, content_type: Option<&'static str>, ranged: bool, head: bool) -> Response<Body> {
    let mut res = Response::new(empty());
    *res.status_mut() = up.status();
    let headers = res.headers_mut();
    for name in [header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES, header::LAST_MODIFIED, header::ETAG] {
        if let Some(value) = up.headers().get(&name) {
            headers.insert(name, value.clone());
        }
    }
    let upstream_type = up.headers().get(header::CONTENT_TYPE).filter(|t| !t.to_str().unwrap_or("").to_ascii_lowercase().contains("octet-stream"));
    let content_type = match (content_type, upstream_type) {
        (Some(fixed), _) => HeaderValue::from_static(fixed),
        (None, Some(upstream)) => upstream.clone(),
        (None, None) => HeaderValue::from_static(guess_type(url)),
    };
    headers.insert(header::CONTENT_TYPE, content_type);
    if !headers.contains_key(header::ACCEPT_RANGES) && !ranged {
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    }
    if !head {
        *res.body_mut() = cut_on_close(up.bytes_stream().map(|chunk| chunk.map_err(BoxError::from)), s);
    }
    res
}

/// A DASH segment: its first range tells the size, the rest are fetched 16 at a time and passed on
/// in order as they come (never more than those 16 in memory). A server without ranges, or an
/// error (an expired cookie's 403), is passed on as it came.
async fn segment(shared: &Shared, s: &Session, req: &Request<Incoming>, url: &str) -> Result<Response<Body>, Failure> {
    if req.method() == Method::HEAD || req.headers().contains_key(header::RANGE) {
        return pipe(shared, s, req, url, Some(MP4)).await;
    }
    let first = answer(shared.client.get(url).headers(s.headers.clone()).header(header::RANGE, format!("bytes=0-{}", RANGE_BYTES - 1))).await?;
    let size = first.headers().get(header::CONTENT_RANGE).and_then(content_range);
    let (first_end, total) = match (first.status(), size) {
        (StatusCode::PARTIAL_CONTENT, Some(size)) => size,
        // A range of unknown size: one plain request instead.
        (StatusCode::PARTIAL_CONTENT, None) => return pipe(shared, s, req, url, Some(MP4)).await,
        _ => return Ok(relay(first, s, url, Some(MP4), false, false)),
    };
    let mut res = Response::new(empty());
    for name in [header::LAST_MODIFIED, header::ETAG] {
        if let Some(value) = first.headers().get(&name) {
            res.headers_mut().insert(name, value.clone());
        }
    }
    let body = parts(shared, s, first, first_end, total).map(|part| part.map_err(|f| BoxError::from(f.message)));
    *res.body_mut() = cut_on_close(body, s);
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(MP4));
    res.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(total));
    res.headers_mut().insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    Ok(res)
}

/// A resource whose first range (bytes 0 to `first_end` of `total`) has answered: its parts in
/// order, the later ranges fetched 16 at a time from where the first was found.
fn parts(shared: &Shared, s: &Session, first: reqwest::Response, first_end: u64, total: u64) -> impl Stream<Item = Result<Bytes, Failure>> + Send + use<> {
    let (client, headers, url) = (shared.client.clone(), s.headers.clone(), first.url().clone());
    let first_part = async move { exact(first, first_end + 1).await }.boxed();
    let rest = (first_end + 1..total).step_by(RANGE_BYTES as usize).map(move |start| {
        let end = (start + RANGE_BYTES - 1).min(total - 1);
        let request = client.get(url.clone()).headers(headers.clone()).header(header::RANGE, format!("bytes={start}-{end}")).timeout(FETCH_TIMEOUT);
        async move {
            let part = request.send().await.map_err(|e| Failure::from(failed(e)))?;
            if part.status() != StatusCode::PARTIAL_CONTENT {
                return Err(answered(part.status()));
            }
            exact(part, end - start + 1).await
        }
        .boxed()
    });
    futures::stream::iter(std::iter::once(first_part).chain(rest)).buffered(RANGES_AT_ONCE)
}

/// A range's body, which must be exactly `len` bytes: a short one would corrupt the segment.
async fn exact(part: reqwest::Response, len: u64) -> Result<Bytes, Failure> {
    let body = read_body(part).await?;
    if body.len() as u64 == len { Ok(body) } else { Err("The stream sent a range short.".into()) }
}

/// "bytes 0-97279/2984396" → (97279, 2984396): a range from the start, and the whole size.
fn content_range(value: &HeaderValue) -> Option<(u64, u64)> {
    let (range, total) = value.to_str().ok()?.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total): (u64, u64, u64) = (start.trim().parse().ok()?, end.trim().parse().ok()?, total.trim().parse().ok()?);
    (start == 0 && end < total).then_some((end, total))
}

/// A body for AVPlayer that is cut off (as an error, not a clean end) when the play is closed.
fn cut_on_close(body: impl Stream<Item = Result<Bytes, BoxError>> + Send + 'static, s: &Session) -> Body {
    let mut closed = s.closed.subscribe();
    let mut body = Box::pin(body);
    let mut ended = Some(Box::pin(async move {
        let _ = closed.wait_for(|&c| c).await;
    }));
    let frames = futures::stream::poll_fn(move |cx| {
        let Some(waiting) = ended.as_mut() else {
            return Poll::Ready(None);
        };
        if waiting.as_mut().poll(cx).is_ready() {
            ended = None;
            return Poll::Ready(Some(Err::<Frame<Bytes>, BoxError>("The play was closed.".into())));
        }
        body.as_mut().poll_next(cx).map(|chunk| chunk.map(|c| c.map(Frame::data)))
    });
    StreamBody::new(frames).boxed_unsync()
}

// ── Upstream ──────────────────────────────────────────────────────────────────────

/// A GET for the play, with its headers; redirects followed, given up after FETCH_TIMEOUT.
async fn fetch(shared: &Shared, s: &Session, url: &str) -> Result<reqwest::Response, String> {
    shared.client.get(url).headers(s.headers.clone()).timeout(FETCH_TIMEOUT).send().await.map_err(failed)
}

/// A whole document fetched in ranges like segments (MovieBox's 140 KB manifest takes over a
/// second in one request); a server without ranges sends it whole. Where it was found, and it.
async fn fetch_whole(shared: &Shared, s: &Session, url: &str) -> Result<(Url, Bytes), Failure> {
    let range = format!("bytes=0-{}", RANGE_BYTES - 1);
    let first = shared.client.get(url).headers(s.headers.clone()).header(header::RANGE, range).timeout(FETCH_TIMEOUT).send().await.map_err(failed)?;
    let found = first.url().clone();
    let size = first.headers().get(header::CONTENT_RANGE).and_then(content_range);
    match (first.status(), size) {
        (StatusCode::PARTIAL_CONTENT, Some((end, total))) if total <= MAX_DOCUMENT as u64 => {
            let parts: Vec<Bytes> = parts(shared, s, first, end, total).try_collect().await?;
            Ok((found, parts.concat().into()))
        }
        // A range of unknown size (or too big): one plain request, which says why it fails.
        (StatusCode::PARTIAL_CONTENT, _) => {
            let res = fetch(shared, s, url).await?;
            let found = res.url().clone();
            Ok((found, read_ok(res).await?))
        }
        _ => Ok((found, read_ok(first).await?)),
    }
}

/// The whole body of a successful answer.
async fn read_ok(res: reqwest::Response) -> Result<Bytes, Failure> {
    match res.status() {
        status if status.is_success() => Ok(read_body(res).await?),
        status => Err(answered(status)),
    }
}

async fn read_body(res: reqwest::Response) -> Result<Bytes, String> {
    let too_large = || "The stream sent more than a playlist or manifest can be.".to_string();
    if res.content_length().is_some_and(|n| n > MAX_DOCUMENT as u64) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    let mut chunks = res.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(failed)?;
        if body.len() + chunk.len() > MAX_DOCUMENT {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body.into())
}

/// Shown to the user when a play can't open, so short, and without the URL (it carries tokens).
fn failed(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "The stream didn't answer in time.".into()
    } else if e.is_connect() {
        "Can't connect to the stream.".into()
    } else {
        format!("The stream failed ({}).", e.without_url())
    }
}

/// The source's headers as sent upstream; ones that can't be sent, or that the relay sets itself
/// (Range, Host…), are left out.
fn upstream_headers(list: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in list {
        let (Ok(name), Ok(value)) = (HeaderName::from_bytes(name.trim().as_bytes()), HeaderValue::from_bytes(value.trim().as_bytes())) else {
            log::warn!("stream server: a header can't be sent and is left out: {name:?}");
            continue;
        };
        if ![header::HOST, header::RANGE, header::CONTENT_LENGTH, header::TRANSFER_ENCODING, header::CONNECTION].contains(&name) {
            map.append(name, value);
        }
    }
    map
}

/// What the stream is: by its address, or failing that by its first bytes.
async fn sniff(client: &reqwest::Client, url: &Url, headers: &HeaderMap) -> Kind {
    let path = url.path().to_ascii_lowercase();
    if path.ends_with(".mpd") {
        return Kind::Dash;
    }
    if path.ends_with(".m3u8") || path.ends_with(".m3u") {
        return Kind::Hls;
    }
    if [".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ts"].iter().any(|ext| path.ends_with(ext)) {
        return Kind::File;
    }
    // No telling extension (add-on links often have none): look at the first bytes.
    let Some((content_type, head)) = peek(client, url, headers).await else {
        return Kind::File;
    };
    let head = head.trim_start();
    if content_type.contains("mpegurl") || head.starts_with("#EXTM3U") {
        Kind::Hls
    } else if content_type.contains("dash+xml") || looks_like_mpd(head) {
        Kind::Dash
    } else {
        Kind::File
    }
}

/// The content type (lowercase) and first 512 bytes (as Latin-1) of a stream; the rest is never
/// downloaded, even when the server ignores the Range.
async fn peek(client: &reqwest::Client, url: &Url, headers: &HeaderMap) -> Option<(String, String)> {
    let request = client.get(url.clone()).headers(headers.clone()).header(header::RANGE, "bytes=0-511").timeout(FETCH_TIMEOUT);
    let res = request.send().await.ok()?;
    let content_type = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let mut head = Vec::new();
    let mut body = res.bytes_stream();
    while head.len() < 512 {
        match body.next().await {
            Some(Ok(chunk)) => head.extend_from_slice(&chunk),
            Some(Err(_)) => return None,
            None => break,
        }
    }
    head.truncate(512);
    Some((content_type, head.iter().map(|&b| char::from(b)).collect()))
}

/// `<MPD`, maybe after an XML declaration.
fn looks_like_mpd(head: &str) -> bool {
    let head = head.to_ascii_lowercase();
    let rest = match head.strip_prefix("<?xml") {
        Some(declaration) => match declaration.find('>') {
            Some(end) => declaration[end + 1..].trim_start(),
            None => return false,
        },
        None => &head,
    };
    rest.starts_with("<mpd")
}

/// The play's subtitles as WebVTT; none when there are none or they can't be had (the film still
/// plays).
async fn subtitles(client: &reqwest::Client, url: Option<&str>, headers: &HeaderMap) -> Option<String> {
    let url = url.map(str::trim).filter(|u| !u.is_empty())?;
    let raw = match local_file(url) {
        // The engine may hand over a file it downloaded rather than a link.
        Some(path) => tokio::task::spawn_blocking(move || std::fs::read(path)).await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())),
        None => match client.get(url).headers(headers.clone()).timeout(FETCH_TIMEOUT).send().await {
            Ok(res) => read_ok(res).await.map(Vec::from).map_err(|f| f.message),
            Err(e) => Err(failed(e)),
        },
    };
    match raw {
        Ok(raw) => Some(hls::read_subtitles(&raw)),
        Err(e) => {
            log::warn!("stream server: subtitles left out: {e}");
            None
        }
    }
}

fn local_file(url: &str) -> Option<std::path::PathBuf> {
    if url.starts_with('/') {
        return Some(url.into());
    }
    Url::parse(url).ok().filter(|u| u.scheme() == "file")?.to_file_path().ok()
}

// ── Small parts ───────────────────────────────────────────────────────────────────

fn empty() -> Body {
    Empty::<Bytes>::new().map_err(|never| match never {}).boxed_unsync()
}

fn send(status: StatusCode, content_type: &'static str, body: impl Into<Bytes>) -> Response<Body> {
    send_typed(status, HeaderValue::from_static(content_type), body)
}

fn send_typed(status: StatusCode, content_type: HeaderValue, body: impl Into<Bytes>) -> Response<Body> {
    let mut res = Response::new(Full::new(body.into()).map_err(|never| match never {}).boxed_unsync());
    *res.status_mut() = status;
    res.headers_mut().insert(header::CONTENT_TYPE, content_type);
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn text(status: StatusCode, message: impl Into<String>) -> Response<Body> {
    send(status, TEXT, message.into())
}

fn not_found() -> Response<Body> {
    text(StatusCode::NOT_FOUND, "Not found.")
}

fn guess_type(url: &str) -> &'static str {
    let path = Url::parse(url).map(|u| u.path().to_ascii_lowercase()).unwrap_or_default();
    let ext = path.rsplit_once('.').map(|(_, ext)| ext).filter(|e| !e.is_empty() && e.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'));
    match ext {
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("ts") => "video/mp2t",
        Some("aac") => "audio/aac",
        _ => MP4,
    }
}

/// `parseInt`: the number a path part starts with ("12.m4s" → 12).
fn leading_number(s: &str) -> Option<usize> {
    s[..s.bytes().take_while(u8::is_ascii_digit).count()].parse().ok()
}

/// 12 random bytes, URL-safe: 16 characters no one can guess.
fn session_id() -> String {
    let mut bytes = [0u8; 12];
    rand::fill(&mut bytes[..]);
    b64url_encode(&bytes)
}

const BASE64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url without padding (Node's "base64url").
fn b64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(char::from(BASE64URL[(n >> (18 - 6 * i)) as usize & 63]));
        }
    }
    out
}

fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut count) = (0u32, 0);
    for c in text.trim_end_matches('=').bytes() {
        bits = bits << 6 | BASE64URL.iter().position(|&x| x == c)? as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    Some(out)
}

/// `encodeURIComponent`: rendition ids are the manifest's, so anything can be in them.
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`; none when malformed.
fn decode_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = b.get(i + 1..i + 3).filter(|h| h.iter().all(u8::is_ascii_hexdigit))?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hls_playlists_point_here() {
        let base = Url::parse("https://cdn.test/live/master.m3u8?t=1").unwrap();
        let text = "#EXTM3U\r\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/en.m3u8\"\r\n\r\n#EXT-X-STREAM-INF:BANDWIDTH=1\r\n#comment\r\nlow/index.m3u8\r\n#EXT-X-STREAM-INF:BANDWIDTH=2\r\nhigh?x=1\r\n#EXT-X-I-FRAME-STREAM-INF:URI=\"iframes\"\r\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://keys.test/k\",X=URI=\"\"\r\n#EXT-X-MAP:URI=\"init.mp4\"\r\n  seg1.ts  \r\n/abs/seg2.TS\r\nother.M3U\r\n";
        let mut links = Vec::new();
        let out = rewrite_playlist(text, &base, "S", &mut links).unwrap();
        let here = |url: &str, playlist: bool| format!("/s/S/h/{}{}", b64url_encode(url.as_bytes()), if playlist { ".m3u8" } else { "" });
        let expected = [
            "#EXTM3U".to_string(),
            format!("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"{}\"", here("https://cdn.test/live/audio/en.m3u8", true)),
            String::new(),
            "#EXT-X-STREAM-INF:BANDWIDTH=1".into(),
            "#comment".into(),
            here("https://cdn.test/live/low/index.m3u8", true),
            "#EXT-X-STREAM-INF:BANDWIDTH=2".into(),
            here("https://cdn.test/live/high?x=1", true),
            format!("#EXT-X-I-FRAME-STREAM-INF:URI=\"{}\"", here("https://cdn.test/live/iframes", true)),
            format!("#EXT-X-KEY:METHOD=AES-128,URI=\"{}\",X=URI=\"\"", here("https://keys.test/k", false)),
            format!("#EXT-X-MAP:URI=\"{}\"", here("https://cdn.test/live/init.mp4", false)),
            here("https://cdn.test/live/seg1.ts", false),
            here("https://cdn.test/abs/seg2.TS", false),
            here("https://cdn.test/live/other.M3U", true),
            String::new(),
        ]
        .join("\n");
        assert_eq!(out, expected);
        assert_eq!(links.len(), 9);
        assert!(links.contains(&"https://keys.test/k".to_string()));
        assert!(rewrite_playlist("#EXTM3U\nhttp://[bad\n", &base, "S", &mut links).is_err());
    }

    #[test]
    fn small_parts() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foob", b"\xff\xfe\xfd\x00", "https://cdn.test/a?b=c&d=é".as_bytes()] {
            assert_eq!(b64url_decode(&b64url_encode(data)).as_deref(), Some(data));
        }
        assert_eq!(b64url_encode(b"\xfb\xff"), "-_8");
        assert_eq!(b64url_decode("Zm9vYg=="), Some(b"foob".to_vec()));
        assert_eq!(b64url_decode("Zm9v+g"), None);
        assert_eq!(session_id().len(), 16);
        assert_ne!(session_id(), session_id());

        assert_eq!(encode_component("v 1/é"), "v%201%2F%C3%A9");
        assert_eq!(decode_component("v%201%2F%C3%A9").as_deref(), Some("v 1/é"));
        assert_eq!(decode_component("bad%2"), None);
        assert_eq!(decode_component("bad%+1"), None);
        assert_eq!(decode_component("%FF"), None);

        assert_eq!(leading_number("12.m4s"), Some(12));
        assert_eq!(leading_number("x"), None);
        assert_eq!(leading_number("-1"), None);

        assert_eq!(guess_type("https://a.test/v.MKV?x=1"), "video/x-matroska");
        assert_eq!(guess_type("https://a.test/v.ts"), "video/mp2t");
        assert_eq!(guess_type("https://a.test/a.b/v"), "video/mp4");

        assert!(looks_like_mpd("<?xml version=\"1.0\"?>\n <MPD x>"));
        assert!(looks_like_mpd("<mpd>"));
        assert!(!looks_like_mpd("<?xml version=\"1.0\"?><!-- c --><MPD>"));
        assert!(!looks_like_mpd("<html>"));

        let range = |v: &str| content_range(&HeaderValue::from_str(v).unwrap());
        assert_eq!(range("bytes 0-97279/2984396"), Some((97279, 2984396)));
        assert_eq!(range("bytes 0-59/60"), Some((59, 60)));
        for odd in ["bytes 5-9/60", "bytes 0-60/60", "bytes 0-9/*", "bytes */60", "0-9/60"] {
            assert_eq!(range(odd), None, "{odd}");
        }
        assert_eq!(answered(StatusCode::FORBIDDEN).status, StatusCode::FORBIDDEN);
        assert_eq!(answered(StatusCode::NOT_FOUND).status, StatusCode::BAD_GATEWAY);
        assert_eq!(answered(StatusCode::NOT_FOUND).message, "The stream answered 404.");

        let headers = upstream_headers(&[
            ("Referer".into(), "https://a.test/".into()),
            ("Cookie".into(), "a=1".into()),
            ("Cookie".into(), "b=2".into()),
            ("Range".into(), "bytes=5-".into()),
            ("Host".into(), "evil.test".into()),
            ("Bad Name".into(), "x".into()),
            ("X-Bad-Value".into(), "a\nb".into()),
        ]);
        assert_eq!(headers.len(), 3);
        assert_eq!(headers.get_all(header::COOKIE).iter().count(), 2);
        assert_eq!(headers.get(header::REFERER).map(|v| v.as_bytes()), Some(&b"https://a.test/"[..]));
    }
}
