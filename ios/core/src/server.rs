//! The local stream server AVPlayer plays from (127.0.0.1): relays each play with its source's
//! headers, DASH as HLS. A port of the desktop relay (src/main/phone/relay.ts) without what only
//! exists there (the engine's player stand-in, idle timers): a play lives from `open` to `close`.
//! What the engine's own relay did for the desktop is done here too: MovieBox's CDN is slow per
//! connection, so segments and files come in ranges; the picked quality caps a DASH manifest; the
//! source's Cookie goes only to the source's own host (its other headers go everywhere).
//! OWNER: agent "hls" (see GUIDE.md).
//!
//! Under /s/<session>/:
//! - `master.m3u8`: DASH, written from the manifest; HLS, the source's own with its links pointed here
//! - `v/<rep>.m3u8`, `a/<rep>.m3u8`: a DASH rendition's media playlist
//! - `init/<rep>.mp4`: its initialization segment, HEVC relabelled hvc1 (fetched once per play)
//! - `seg/<rep>/<i>.m4s`: its segment `i`, streamed (fetched in ranges: see `stream`)
//! - `subs.m3u8`, `subs.vtt`: the subtitles, as WebVTT
//! - `h/<base64url(url)>[.m3u8]`: HLS, a playlist or file named in a rewritten playlist (only those)
//! - `video`: a file (MP4…), seeking (Range) passed both ways, fetched in ranges like segments
//!
//! An upstream 403 reaches AVPlayer as 403: MovieBox's CDN cookie is signed and runs out, and the
//! app tells that apart from a broken stream. iOS can take a suspended app's listening socket
//! (TN2277): the server then listens again, on the same port when it can.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::{Stream, StreamExt, TryStreamExt};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use reqwest::Url;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, OnceCell, watch};

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
/// MovieBox's CDN slows every connection to about 130 KiB/s, far below a 1080p stream: segments,
/// files (and the manifest) come in 95 KiB ranges, 16 at a time, as the engine's own relay fetches
/// them (over 2 MiB/s).
const RANGE_BYTES: u64 = 95 * 1024;
const RANGES_AT_ONCE: usize = 16;
/// Plays left open (the app closes each one); beyond this the oldest is let go.
const MAX_SESSIONS: usize = 8;
/// What AVPlayer's subtitle menu calls the track when the app named no language.
const SUBTITLE_NAME: &str = "Subtitles";
/// More accept errors in a row than this and the listening socket is taken for lost, whatever
/// they say.
const MAX_ACCEPT_ERRORS: u32 = 20;

pub struct Server {
    shared: Arc<Shared>,
    accept: tokio::task::AbortHandle,
}

struct Shared {
    /// Where AVPlayer connects; it moves only when the old port can't be had again.
    port: AtomicU16,
    client: reqwest::Client,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    opened: AtomicU64,
    /// Asks the accept loop to listen again: `open` found nothing answering.
    relisten: Notify,
    /// How many times it listened again (`open` waits for the next one).
    listens: watch::Sender<u64>,
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
    /// The source's host (and port): the only one its Cookie goes to.
    home: String,
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
    /// The subtitles' language as the app asked for it ("English").
    subtitle_lang: Option<String>,
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
        let shared = Arc::new(Shared::new(port, client));
        let accept = tokio::spawn(accept(listener, shared.clone())).abort_handle();
        Ok(Server { shared, accept })
    }

    pub fn port(&self) -> u16 {
        self.shared.port()
    }

    /// A new play of `source`: works out what the stream is (DASH, HLS or a file), fetches its
    /// subtitles, and for DASH reads the manifest and codecs now, so a stream that can't play
    /// says why here rather than in a silent player.
    pub async fn open(&self, source: Source) -> Result<Play, String> {
        let shared = &self.shared;
        let url = Url::parse(&source.url).map_err(|_| "The stream's address isn't valid.".to_string())?;
        let headers = upstream_headers(&source.headers);
        let home = authority(&url);
        let (kind, vtt) = tokio::join!(
            sniff(&shared.client, &url, &headers),
            subtitles(&shared.client, source.subtitle_url.as_deref(), &headers, &home)
        );
        let session = Arc::new(Session {
            id: session_id(),
            url: source.url,
            headers,
            home,
            kind,
            max_height: source.max_height,
            serial: shared.opened.fetch_add(1, Ordering::Relaxed),
            dash: OnceCell::new(),
            inits: Mutex::default(),
            codecs: Mutex::default(),
            allowed: Mutex::default(),
            vtt,
            subtitle_lang: source.subtitle_lang.map(|l| l.trim().to_string()).filter(|l| !l.is_empty()),
            closed: watch::channel(false).0,
        });
        if kind == Kind::Dash {
            let d = manifest(shared, &session).await.map_err(|f| f.message)?;
            codecs(shared, &session, &d).await.map_err(|f| f.message)?;
        }
        shared.listening().await;
        let base = format!("http://127.0.0.1:{}/s/{}", shared.port(), session.id);
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
    fn new(port: u16, client: reqwest::Client) -> Shared {
        Shared {
            port: AtomicU16::new(port),
            client,
            sessions: Mutex::default(),
            opened: AtomicU64::new(0),
            relisten: Notify::new(),
            listens: watch::channel(0).0,
        }
    }

    fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

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

    /// Makes sure something answers on the port before its address is handed out: iOS can take a
    /// suspended app's listening socket without the accept loop ever hearing of it (TN2277).
    async fn listening(&self) {
        let port = self.port();
        let connect = TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port)));
        if matches!(tokio::time::timeout(Duration::from_secs(1), connect).await, Ok(Ok(_))) {
            return;
        }
        log::warn!("stream server: nothing answers on port {port}: listening again");
        let mut listens = self.listens.subscribe();
        self.relisten.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(3), listens.changed()).await;
    }
}

impl Session {
    fn end(&self) {
        self.closed.send_replace(true);
    }

    /// A request for this play, with the source's headers (see `headers_for`).
    fn request(&self, client: &reqwest::Client, method: Method, url: &Url) -> reqwest::RequestBuilder {
        client.request(method, url.clone()).headers(headers_for(&self.headers, &self.home, url))
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

// ── Listening ──────────────────────────────────────────────────────────────────────

/// Accept errors that pass, with the listening socket still working.
fn transient(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::ConnectionAborted | io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock)
        // EMFILE, ENFILE (the same numbers on Linux and Apple's systems): out of file descriptors.
        || matches!(e.raw_os_error(), Some(23 | 24))
}

async fn accept(listener: TcpListener, shared: Arc<Shared>) {
    let mut listener = Some(listener);
    let mut errors = 0;
    loop {
        let Some(current) = &listener else {
            // Nothing could be bound: try again in a moment.
            tokio::time::sleep(Duration::from_secs(1)).await;
            listener = relisten(&shared).await;
            continue;
        };
        let accepted = tokio::select! {
            accepted = current.accept() => Some(accepted),
            () = shared.relisten.notified() => None,
        };
        match accepted {
            Some(Ok((stream, _))) => {
                errors = 0;
                serve(stream, shared.clone());
            }
            Some(Err(e)) if transient(&e) && errors + 1 < MAX_ACCEPT_ERRORS => {
                errors += 1;
                log::warn!("stream server: accept failed ({e}); trying again");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            lost => {
                if let Some(Err(e)) = lost {
                    log::warn!("stream server: the listening socket is lost ({e}): listening again");
                }
                // Closed first, so its port can be taken again.
                drop(listener.take());
                errors = 0;
                listener = relisten(&shared).await;
            }
        }
    }
}

fn serve(stream: TcpStream, shared: Arc<Shared>) {
    let _ = stream.set_nodelay(true);
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

/// Listens again after the socket was lost: on the same port when it can be had (addresses handed
/// out keep working), else on a new one, which `Server::port` reports from then on.
async fn relisten(shared: &Shared) -> Option<TcpListener> {
    let port = shared.port();
    let listener = match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await {
        Ok(listener) => listener,
        Err(e) => {
            log::warn!("stream server: port {port} can't be had again ({e}): taking a new one");
            match TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await {
                Ok(listener) => listener,
                Err(e) => {
                    log::warn!("stream server: can't listen ({e})");
                    return None;
                }
            }
        }
    };
    let port = listener.local_addr().ok()?.port();
    shared.port.store(port, Ordering::Relaxed);
    shared.listens.send_modify(|n| *n += 1);
    log::warn!("stream server: listening again on port {port}");
    Some(listener)
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
        Kind::File if what == "video" => stream(shared, &s, req, &s.url, None).await,
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
            // Named as the app asked for them ("English"), with the language code AVPlayer's
            // subtitle menu goes by, as relay.ts names them.
            let subtitles = s.vtt.as_ref().map(|_| SubtitleTrack {
                uri: format!("/s/{}/subs.m3u8", s.id),
                name: s.subtitle_lang.clone().unwrap_or_else(|| SUBTITLE_NAME.into()),
                lang: s.subtitle_lang.as_deref().and_then(language_code).and_then(|code| hls::language_tag(Some(code))),
            });
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
            Some(found) => stream(shared, s, req, &found.url, Some(MP4)).await,
            None => Ok(not_found()),
        },
        _ => Ok(not_found()),
    }
}

/// The app's subtitle language (an English name) as a language code (relay.ts LANGUAGE_CODES).
fn language_code(name: &str) -> Option<&'static str> {
    const CODES: &[(&str, &str)] = &[
        ("English", "en"),
        ("Georgian", "ka"),
        ("Russian", "ru"),
        ("Spanish", "es"),
        ("French", "fr"),
        ("German", "de"),
        ("Italian", "it"),
        ("Portuguese", "pt"),
        ("Turkish", "tr"),
        ("Ukrainian", "uk"),
        ("Arabic", "ar"),
        ("Hindi", "hi"),
        ("Japanese", "ja"),
        ("Korean", "ko"),
        ("Chinese", "zh"),
        ("Polish", "pl"),
        ("Dutch", "nl"),
        ("Greek", "el"),
        ("Hebrew", "he"),
        ("Persian", "fa"),
        ("Indonesian", "id"),
        ("Malay", "ms"),
        ("Thai", "th"),
        ("Vietnamese", "vi"),
        ("Bengali", "bn"),
        ("Tamil", "ta"),
        ("Telugu", "te"),
        ("Urdu", "ur"),
        ("Czech", "cs"),
        ("Danish", "da"),
        ("Finnish", "fi"),
        ("Hungarian", "hu"),
        ("Norwegian", "no"),
        ("Romanian", "ro"),
        ("Swedish", "sv"),
        ("Filipino", "fil"),
    ];
    CODES.iter().find(|(language, _)| language.eq_ignore_ascii_case(name.trim())).map(|&(_, code)| code)
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

// ── Streaming to AVPlayer ─────────────────────────────────────────────────────────

/// One request upstream for what AVPlayer asked, passing seeking (Range) both ways. When AVPlayer
/// hangs up, hyper drops the body and with it the upstream request.
async fn pipe(shared: &Shared, s: &Session, req: &Request<Incoming>, url: &str, content_type: Option<&'static str>) -> Result<Response<Body>, Failure> {
    let range = req.headers().get(header::RANGE).cloned();
    let head = req.method() == Method::HEAD;
    let mut up = s.request(&shared.client, if head { Method::HEAD } else { Method::GET }, &upstream_url(url)?);
    if let Some(range) = &range {
        up = up.header(header::RANGE, range.clone());
    }
    let up = answer(up).await?;
    Ok(relay(up, s, url, content_type, range.is_some(), head))
}

/// What AVPlayer streams (a DASH segment, a file), fetched in 95 KiB ranges, 16 at a time, and
/// passed on in order as they come (never more than those 16 in memory): the whole of it, or the
/// range AVPlayer asked for; an open-ended range goes on until AVPlayer hangs up. A server without
/// ranges, an error (an expired cookie's 403), a HEAD or an unusual Range goes the plain way.
async fn stream(shared: &Shared, s: &Session, req: &Request<Incoming>, url: &str, content_type: Option<&'static str>) -> Result<Response<Body>, Failure> {
    let asked = match req.headers().get(header::RANGE) {
        None => Some((0, None)),
        Some(range) => asked_range(range),
    };
    let Some((start, asked_end)) = asked.filter(|_| req.method() != Method::HEAD) else {
        return pipe(shared, s, req, url, content_type).await;
    };
    let partial = req.headers().contains_key(header::RANGE);
    let first_end = asked_end.unwrap_or(u64::MAX).min(start.saturating_add(RANGE_BYTES - 1));
    let request = s.request(&shared.client, Method::GET, &upstream_url(url)?).header(header::RANGE, format!("bytes={start}-{first_end}"));
    let first = answer(request).await?;
    let got = first.headers().get(header::CONTENT_RANGE).and_then(content_range);
    let (got_start, got_end, total) = match (first.status(), got) {
        (StatusCode::PARTIAL_CONTENT, Some(got)) => got,
        // A range of unknown size: one plain request instead.
        (StatusCode::PARTIAL_CONTENT, None) => return pipe(shared, s, req, url, content_type).await,
        // The whole of it (no ranges here), or an error: passed on as it came.
        _ => return Ok(relay(first, s, url, content_type, partial, false)),
    };
    let last = asked_end.map_or(total - 1, |end| end.min(total - 1));
    // Not the range asked for (a server that cuts ranges short, say): one plain request instead.
    if got_start != start || got_end != first_end.min(last) {
        return pipe(shared, s, req, url, content_type).await;
    }
    let mut res = Response::new(empty());
    if partial {
        *res.status_mut() = StatusCode::PARTIAL_CONTENT;
        let range = HeaderValue::try_from(format!("bytes {start}-{last}/{total}")).map_err(|_| "A range can't be written.")?;
        res.headers_mut().insert(header::CONTENT_RANGE, range);
    }
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, response_type(first.headers(), url, content_type));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(last - start + 1));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    for name in [header::LAST_MODIFIED, header::ETAG] {
        if let Some(value) = first.headers().get(&name) {
            headers.insert(name, value.clone());
        }
    }
    let body = parts(shared, s, first, start, got_end, last).map(|part| part.map_err(|f| BoxError::from(f.message)));
    *res.body_mut() = cut_on_close(body, s);
    Ok(res)
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
    headers.insert(header::CONTENT_TYPE, response_type(up.headers(), url, content_type));
    if !headers.contains_key(header::ACCEPT_RANGES) && !ranged {
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    }
    if !head {
        *res.body_mut() = cut_on_close(up.bytes_stream().map(|chunk| chunk.map_err(BoxError::from)), s);
    }
    res
}

/// The type AVPlayer is told: the one given (segments), else upstream's unless it says nothing
/// (octet-stream), else one guessed from the address.
fn response_type(upstream: &HeaderMap, url: &str, given: Option<&'static str>) -> HeaderValue {
    let upstream = upstream.get(header::CONTENT_TYPE).filter(|t| !t.to_str().unwrap_or("").to_ascii_lowercase().contains("octet-stream"));
    match (given, upstream) {
        (Some(given), _) => HeaderValue::from_static(given),
        (None, Some(upstream)) => upstream.clone(),
        (None, None) => HeaderValue::from_static(guess_type(url)),
    }
}

/// A resource whose first range (bytes `first_start` to `first_end`) has answered: its parts in
/// order up to byte `last`, the later ranges fetched 16 at a time from where the first was found.
fn parts(
    shared: &Shared,
    s: &Session,
    first: reqwest::Response,
    first_start: u64,
    first_end: u64,
    last: u64,
) -> impl Stream<Item = Result<Bytes, Failure>> + Send + use<> {
    let url = first.url().clone();
    let (client, headers) = (shared.client.clone(), headers_for(&s.headers, &s.home, &url));
    let first_part = Part::spawn(exact(first, first_end - first_start + 1));
    let rest = (first_end + 1..=last).step_by(RANGE_BYTES as usize).map(move |start| {
        let end = (start + RANGE_BYTES - 1).min(last);
        let request = client.get(url.clone()).headers(headers.clone()).header(header::RANGE, format!("bytes={start}-{end}")).timeout(FETCH_TIMEOUT);
        Part::spawn(async move {
            let part = request.send().await.map_err(failed)?;
            if part.status() != StatusCode::PARTIAL_CONTENT {
                return Err(answered(part.status()));
            }
            exact(part, end - start + 1).await
        })
    });
    futures::stream::iter(std::iter::once(first_part).chain(rest)).buffered(RANGES_AT_ONCE)
}

/// One part, fetched by a task of its own: it downloads while AVPlayer still reads the parts before
/// it, and a paused player (which stops reading) can't let its timeouts run out. Dropped (AVPlayer
/// hung up), it stops.
struct Part(tokio::task::JoinHandle<Result<Bytes, Failure>>);

impl Part {
    fn spawn(fetch: impl Future<Output = Result<Bytes, Failure>> + Send + 'static) -> Part {
        Part(tokio::spawn(fetch))
    }
}

impl Future for Part {
    type Output = Result<Bytes, Failure>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(cx).map(|done| done.unwrap_or_else(|e| Err(Failure::from(format!("A part of the stream failed ({e})")))))
    }
}

impl Drop for Part {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A range's body, which must be exactly `len` bytes: a short one would corrupt the stream.
async fn exact(part: reqwest::Response, len: u64) -> Result<Bytes, Failure> {
    let body = read_body(part).await?;
    if body.len() as u64 == len { Ok(body) } else { Err("The stream sent a range short.".into()) }
}

/// "bytes 100-199/2984396" → (100, 199, 2984396).
fn content_range(value: &HeaderValue) -> Option<(u64, u64, u64)> {
    let (range, total) = value.to_str().ok()?.strip_prefix("bytes ")?.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let (start, end, total): (u64, u64, u64) = (start.trim().parse().ok()?, end.trim().parse().ok()?, total.trim().parse().ok()?);
    (start <= end && end < total).then_some((start, end, total))
}

/// "bytes=a-b" or "bytes=a-", as AVPlayer asks: the start, and the end when there is one. Other
/// forms (suffixes, several ranges) are left to the server.
fn asked_range(value: &HeaderValue) -> Option<(u64, Option<u64>)> {
    let (start, end) = value.to_str().ok()?.trim().strip_prefix("bytes=")?.split_once('-')?;
    let start = start.trim().parse().ok()?;
    let end = match end.trim() {
        "" => None,
        end => Some(end.parse().ok()?),
    };
    end.is_none_or(|end| end >= start).then_some((start, end))
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

fn upstream_url(url: &str) -> Result<Url, Failure> {
    Url::parse(url).map_err(|_| Failure::from("The stream has a bad address."))
}

/// Host and port as an address names them ("cdn.test", "127.0.0.1:8080").
fn authority(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

/// The source's headers for a request to `url`: the Cookie (a signed CDN cookie) only to the
/// source's own host, as the engine sends it; the rest everywhere.
fn headers_for(headers: &HeaderMap, home: &str, url: &Url) -> HeaderMap {
    let mut headers = headers.clone();
    if authority(url) != home {
        headers.remove(header::COOKIE);
    }
    headers
}

/// A GET for the play, with its headers; redirects followed, given up after FETCH_TIMEOUT.
async fn fetch(shared: &Shared, s: &Session, url: &str) -> Result<reqwest::Response, Failure> {
    let request = s.request(&shared.client, Method::GET, &upstream_url(url)?).timeout(FETCH_TIMEOUT);
    Ok(request.send().await.map_err(failed)?)
}

/// A whole document fetched in ranges like segments (MovieBox's 140 KB manifest takes over a
/// second in one request); a server without ranges sends it whole. Where it was found, and it.
async fn fetch_whole(shared: &Shared, s: &Session, url: &str) -> Result<(Url, Bytes), Failure> {
    let range = format!("bytes=0-{}", RANGE_BYTES - 1);
    let first = s.request(&shared.client, Method::GET, &upstream_url(url)?).header(header::RANGE, range).timeout(FETCH_TIMEOUT);
    let first = first.send().await.map_err(failed)?;
    let found = first.url().clone();
    match (first.status(), first.headers().get(header::CONTENT_RANGE).and_then(content_range)) {
        (StatusCode::PARTIAL_CONTENT, Some((0, end, total))) if total <= MAX_DOCUMENT as u64 && end == (RANGE_BYTES - 1).min(total - 1) => {
            let parts: Vec<Bytes> = parts(shared, s, first, 0, end, total - 1).try_collect().await?;
            Ok((found, parts.concat().into()))
        }
        // Another range than asked for, or one too big: one plain request, which says why it fails.
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
async fn subtitles(client: &reqwest::Client, url: Option<&str>, headers: &HeaderMap, home: &str) -> Option<String> {
    let url = url.map(str::trim).filter(|u| !u.is_empty())?;
    let raw = match local_file(url) {
        // The engine may hand over a file it downloaded rather than a link.
        Some(path) => tokio::task::spawn_blocking(move || std::fs::read(path)).await.map_err(|e| e.to_string()).and_then(|r| r.map_err(|e| e.to_string())),
        None => match Url::parse(url) {
            Ok(target) => match client.get(target.clone()).headers(headers_for(headers, home, &target)).timeout(FETCH_TIMEOUT).send().await {
                Ok(res) => read_ok(res).await.map(Vec::from).map_err(|f| f.message),
                Err(e) => Err(failed(e)),
            },
            Err(_) => Err("their address isn't valid".into()),
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

        let value = |v: &str| HeaderValue::from_str(v).unwrap();
        assert_eq!(content_range(&value("bytes 0-97279/2984396")), Some((0, 97279, 2984396)));
        assert_eq!(content_range(&value("bytes 5-9/60")), Some((5, 9, 60)));
        for odd in ["bytes 0-60/60", "bytes 9-5/60", "bytes 0-9/*", "bytes */60", "0-9/60"] {
            assert_eq!(content_range(&value(odd)), None, "{odd}");
        }
        assert_eq!(asked_range(&value("bytes=0-1")), Some((0, Some(1))));
        assert_eq!(asked_range(&value("bytes=500-")), Some((500, None)));
        for odd in ["bytes=-500", "bytes=0-1,5-9", "bytes=9-5", "items=0-1", "bytes=x-"] {
            assert_eq!(asked_range(&value(odd)), None, "{odd}");
        }
        assert_eq!(answered(StatusCode::FORBIDDEN).status, StatusCode::FORBIDDEN);
        assert_eq!(answered(StatusCode::NOT_FOUND).status, StatusCode::BAD_GATEWAY);
        assert_eq!(answered(StatusCode::NOT_FOUND).message, "The stream answered 404.");

        assert_eq!((language_code("English"), language_code(" english "), language_code("Filipino")), (Some("en"), Some("en"), Some("fil")));
        assert_eq!(language_code("Klingon"), None);
        assert!(transient(&io::Error::from(io::ErrorKind::ConnectionAborted)) && transient(&io::Error::from_raw_os_error(24)));
        assert!(!transient(&io::Error::from(io::ErrorKind::InvalidInput)));

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

        // The Cookie stays with the source's host (and port); the rest goes everywhere.
        let home = authority(&Url::parse("https://cdn.test/a/index.mpd").unwrap());
        for (url, cookies) in [("https://cdn.test/b/seg.m4s", 2), ("http://cdn.test/x", 2), ("https://cdn.test:8443/x", 0), ("https://other.test/x", 0)] {
            let sent = headers_for(&headers, &home, &Url::parse(url).unwrap());
            assert_eq!((sent.get_all(header::COOKIE).iter().count(), sent.contains_key(header::REFERER)), (cookies, true), "{url}");
        }
    }

    fn source(url: &str) -> Source {
        Source { url: url.into(), headers: vec![], subtitle_url: None, subtitle_lang: None, title: String::new(), max_height: None }
    }

    async fn status(url: &str) -> u16 {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        client.get(url).send().await.map(|r| r.status().as_u16()).unwrap_or(0)
    }

    /// What iOS does to a suspended app's listening socket (TN2277), near enough: once a listening
    /// socket is shut down, Linux fails its accept (EINVAL) and refuses connections.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_lost_listening_socket_is_replaced_on_its_port() {
        use std::os::fd::AsRawFd;
        unsafe extern "C" {
            fn shutdown(socket: i32, how: i32) -> i32;
        }
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let fd = listener.as_raw_fd();
        let shared = Arc::new(Shared::new(port, reqwest::Client::new()));
        let mut listens = shared.listens.subscribe();
        tokio::spawn(accept(listener, shared.clone()));
        let url = format!("http://127.0.0.1:{port}/s/nope/master.m3u8");
        assert_eq!(status(&url).await, 410);
        // SAFETY: `fd` is the accept loop's listening socket, still open; SHUT_RDWR is 2.
        assert_eq!(unsafe { shutdown(fd, 2) }, 0);
        tokio::time::timeout(Duration::from_secs(5), listens.changed()).await.expect("listening again").unwrap();
        assert_eq!(shared.port(), port);
        assert_eq!(status(&url).await, 410);
    }

    #[tokio::test]
    async fn a_taken_port_moves_to_a_new_one() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let shared = Shared::new(port, reqwest::Client::new());
        let listener = relisten(&shared).await.expect("listening");
        let moved = listener.local_addr().unwrap().port();
        assert_ne!(moved, port);
        assert_eq!((shared.port(), *shared.listens.borrow()), (moved, 1));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn open_listens_again_when_nothing_answers() {
        let server = Server::start().await.unwrap();
        // As if iOS had taken the socket without the accept loop hearing of it: nothing answers on
        // the port the server reports.
        let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        server.shared.port.store(silent, Ordering::Relaxed);
        assert_eq!(status(&format!("http://127.0.0.1:{silent}/")).await, 0);
        // A file's play opens without asking upstream (port 9 refuses: a 502 that says so).
        let play = server.open(source("http://127.0.0.1:9/film.mp4")).await.unwrap();
        assert_eq!(server.port(), silent);
        assert!(play.url.starts_with(&format!("http://127.0.0.1:{silent}/s/")), "{}", play.url);
        assert_eq!(status(&play.url).await, 502);
    }
}
