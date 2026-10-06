//! The stream server against a mock upstream on 127.0.0.1: DASH as HLS (the real LOTR manifest and
//! init segments, fetched in ranges, capped at the picked quality), HLS passed through, a file with
//! seeking, subtitles, the source's headers on every request, an expired cookie's 403 passed on,
//! and streams that stop when AVPlayer hangs up or the play is closed.

use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use kino_core::api::Source;
use kino_core::hls;
use kino_core::server::Server;
use tokio::net::TcpListener;

const MPD: &str = include_str!("fixtures/lotr.mpd");
const VIDEO_INIT: &[u8] = include_bytes!("fixtures/init0.m4s");
const AUDIO_INIT: &[u8] = include_bytes!("fixtures/init3.m4s");
/// The mock refuses requests without this Referer: proves the source's headers reach upstream.
const REFERER: &str = "https://example.test/";
const USER_AGENT: &str = "KinoTest/1.0";
const COOKIE: &str = "k=v";
const MOVIE_LEN: usize = 1000;

const HLS_MASTER: &str = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",URI=\"audio/index.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"aud\"\nvideo/index\n";
const HLS_VIDEO: &str = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.0,\nseg0.m4s\n#EXTINF:4.0,\nseg1.m4s\n#EXT-X-ENDLIST\n";
const HLS_AUDIO: &str = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\na0.aac\n#EXT-X-ENDLIST\n";
const SRT: &str = "1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:01:02,5 --> 00:01:03,25\r\nTwo\r\n";

type MockBody = UnsyncBoxBody<Bytes, Infallible>;

/// The upstream: a CDN for DASH, HLS and files that wants the source's headers and minds Range.
struct Mock {
    port: u16,
    /// Paths asked for.
    log: Mutex<Vec<String>>,
    /// The endless stream's reader went away.
    endless_dropped: AtomicBool,
    /// The CDN's signed cookie has run out: everything answers 403.
    expired: AtomicBool,
}

impl Mock {
    async fn start() -> Arc<Mock> {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("the mock listens");
        let port = listener.local_addr().expect("the mock's port").port();
        let mock = Arc::new(Mock { port, log: Mutex::default(), endless_dropped: AtomicBool::new(false), expired: AtomicBool::new(false) });
        let state = mock.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let state = state.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req| {
                        let state = state.clone();
                        async move { Ok::<_, Infallible>(state.answer(req)) }
                    });
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
                });
            }
        });
        mock
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn asked(&self, path: &str) -> usize {
        self.log.lock().unwrap().iter().filter(|p| *p == path).count()
    }

    fn answer(self: &Arc<Self>, req: Request<Incoming>) -> Response<MockBody> {
        let path = req.uri().path().to_string();
        self.log.lock().unwrap().push(path.clone());
        let header = |name: &str| req.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if header("referer") != REFERER {
            return full(403, "text/plain", "no referer");
        }
        if self.expired.load(Ordering::SeqCst) {
            return full(403, "text/plain", "expired");
        }
        let file = path.rsplit('/').next().unwrap_or("").to_string();
        match path.as_str() {
            "/dash/x/index.mpd" => ranged(&header("range"), "application/dash+xml", MPD.as_bytes().to_vec(), MPD.len()),
            "/moved/index.mpd" => {
                let mut res = full(302, "text/plain", "");
                res.headers_mut().insert("location", "/dash/x/index.mpd".parse().unwrap());
                res
            }
            "/sniff/manifest" => full(200, "text/plain", MPD),
            "/hls/master.m3u8" | "/sniff/playlist" => full(200, "text/plain", HLS_MASTER),
            "/hls/video/index" => full(200, "application/vnd.apple.mpegurl", HLS_VIDEO),
            "/hls/audio/index.m3u8" => full(200, "application/vnd.apple.mpegurl", HLS_AUDIO),
            "/subs/en.srt" => full(200, "application/x-subrip", SRT),
            "/file/movie.mp4" => ranged(&header("range"), "video/mp4", movie(), MOVIE_LEN),
            "/file/movie" => ranged(&header("range"), "application/octet-stream", movie(), MOVIE_LEN),
            "/endless.mp4" => self.endless(),
            _ if file.starts_with("init-stream") => full(200, "video/mp4", if file == "init-stream3.m4s" { AUDIO_INIT } else { VIDEO_INIT }),
            // Segment 2 is big (fetched in ranges); segment 3 claims more than it has; /sniff/ ignores Range.
            _ if file.starts_with("chunk-stream") => {
                let small = format!("segment {file} ua={} cookie={}", header("user-agent"), header("cookie")).into_bytes();
                let (body, claimed) = match &file[file.len() - 10..] {
                    "-00002.m4s" => (big_segment(), BIG_LEN),
                    "-00003.m4s" => (big_segment()[..200_000].to_vec(), 300_000),
                    _ => {
                        let len = small.len();
                        (small, len)
                    }
                };
                if path.starts_with("/sniff/") { full(200, "video/iso.segment", body) } else { ranged(&header("range"), "video/iso.segment", body, claimed) }
            }
            _ if path.starts_with("/hls/") => full(200, "video/mp4", format!("hls file {path}")),
            _ => full(404, "text/plain", "not here"),
        }
    }

    /// A stream that never ends, and notes when its reader goes.
    fn endless(self: &Arc<Self>) -> Response<MockBody> {
        struct Reader(Arc<Mock>);
        impl Drop for Reader {
            fn drop(&mut self) {
                self.0.endless_dropped.store(true, Ordering::SeqCst);
            }
        }
        let chunks = futures::stream::unfold(Reader(self.clone()), |reader| async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            Some((Ok::<_, Infallible>(Frame::data(Bytes::from(vec![7u8; 16 * 1024]))), reader))
        });
        let mut res = Response::new(StreamBody::new(chunks).boxed_unsync());
        res.headers_mut().insert("content-type", "video/mp4".parse().unwrap());
        res
    }
}

fn full(status: u16, content_type: &str, body: impl Into<Bytes>) -> Response<MockBody> {
    let mut res = Response::new(Full::new(body.into()).boxed_unsync());
    *res.status_mut() = StatusCode::from_u16(status).unwrap();
    res.headers_mut().insert("content-type", content_type.parse().unwrap());
    res
}

/// Byte i of the movie is i % 251.
fn movie() -> Vec<u8> {
    (0..MOVIE_LEN).map(|i| (i % 251) as u8).collect()
}

const BIG_LEN: usize = 1_000_000;

/// A segment bigger than ten ranges; byte i is i % 253, so parts out of order would show.
fn big_segment() -> Vec<u8> {
    (0..BIG_LEN).map(|i| (i % 253) as u8).collect()
}

/// `body` with Range answered as a CDN does; `claimed` is the size it reports (normally the true one).
fn ranged(range: &str, content_type: &str, body: Vec<u8>, claimed: usize) -> Response<MockBody> {
    let mut res = match range.strip_prefix("bytes=").and_then(|r| r.split_once('-')) {
        Some((start, end)) => {
            let start: usize = start.parse().unwrap();
            if start >= body.len() {
                return full(416, "text/plain", "out of range");
            }
            let end = end.parse().unwrap_or(body.len() - 1).min(body.len() - 1);
            let mut res = full(206, content_type, body[start..=end].to_vec());
            res.headers_mut().insert("content-range", format!("bytes {start}-{end}/{claimed}").parse().unwrap());
            res
        }
        None => full(200, content_type, body),
    };
    res.headers_mut().insert("accept-ranges", "bytes".parse().unwrap());
    res
}

fn source(url: &str, subtitles: Option<&str>) -> Source {
    Source {
        url: url.into(),
        headers: vec![("Referer".into(), REFERER.into()), ("User-Agent".into(), USER_AGENT.into()), ("Cookie".into(), COOKIE.into())],
        subtitle_url: subtitles.map(str::to_string),
        title: "The Fellowship of the Ring".into(),
        max_height: None,
    }
}

/// The same, with the quality the user picked.
fn capped(url: &str, max_height: u64) -> Source {
    Source { max_height: Some(max_height), ..source(url, None) }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

/// A GET to the local server, as AVPlayer makes it: status, content type, body.
async fn get(url: &str) -> (u16, String, Bytes) {
    let res = client().get(url).send().await.expect("the local server answers");
    let status = res.status().as_u16();
    let content_type = header(&res, "content-type");
    (status, content_type, res.bytes().await.expect("a whole body"))
}

async fn get_text(url: &str) -> String {
    let (status, _, body) = get(url).await;
    assert_eq!(status, 200, "{url}");
    String::from_utf8(body.to_vec()).unwrap()
}

fn header(res: &reqwest::Response, name: &str) -> String {
    res.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

fn has(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn b64url(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[(n >> (18 - 6 * i)) as usize & 63]));
        }
    }
    out
}

async fn wait_until(what: &str, done: impl Fn() -> bool) {
    for _ in 0..200 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting: {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn dash_plays_as_hls() {
    let mock = Mock::start().await;
    let server = Server::start().await.expect("the server starts");
    let play = server.open(source(&mock.url("/dash/x/index.mpd"), Some(&mock.url("/subs/en.srt")))).await.expect("the play opens");
    let origin = format!("http://127.0.0.1:{}", server.port());
    let sid = play.session.clone();
    let base = format!("{origin}/s/{sid}");
    assert_eq!(play.kind, "hls");
    assert_eq!(play.url, format!("{base}/master.m3u8"));
    assert_eq!(play.subtitles.as_deref(), Some(format!("{base}/subs.vtt").as_str()));
    assert_eq!(play.title, "The Fellowship of the Ring");

    let (status, content_type, master) = get(&play.url).await;
    assert_eq!((status, content_type.as_str()), (200, "application/vnd.apple.mpegurl"));
    let master = String::from_utf8(master.to_vec()).unwrap();
    assert!(master.contains(&format!(
        "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,AUTOSELECT=YES,URI=\"/s/{sid}/a/3.m3u8\"\n"
    )));
    assert!(master.contains(&format!(
        "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"Subtitles\",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI=\"/s/{sid}/subs.m3u8\"\n"
    )));
    assert_eq!(master.matches("CODECS=\"hvc1.1.6.L150.90,mp4a.40.2\",AUDIO=\"audio\",SUBTITLES=\"subs\"").count(), 3);
    // The first variant, where playback starts, is the 720p one.
    let variant = master.lines().find(|l| !l.starts_with('#')).unwrap();
    assert_eq!(variant, format!("/s/{sid}/v/1.m3u8"));

    let media = get_text(&format!("{origin}{variant}")).await;
    assert!(media.contains(&format!("#EXT-X-MAP:URI=\"/s/{sid}/init/1.mp4\"\n")));
    assert_eq!(media.lines().filter(|l| l.starts_with("#EXTINF:")).count(), 2281);
    assert!(media.ends_with(&format!("/s/{sid}/seg/1/2280.m4s\n#EXT-X-ENDLIST\n")));
    let first = media.lines().find(|l| !l.starts_with('#')).unwrap();
    assert_eq!(first, format!("/s/{sid}/seg/1/0.m4s"));

    let (status, content_type, init) = get(&format!("{base}/init/1.mp4")).await;
    assert_eq!((status, content_type.as_str()), (200, "video/mp4"));
    assert!(has(&init, b"hvc1") && !has(&init, b"hev1"));
    assert_eq!(init, hls::hvc1(VIDEO_INIT));

    let (status, content_type, segment) = get(&format!("{origin}{first}")).await;
    assert_eq!((status, content_type.as_str()), (200, "video/mp4"));
    assert_eq!(segment, format!("segment chunk-stream1-00001.m4s ua={USER_AGENT} cookie={COOKIE}").as_bytes());

    // A big segment comes in 95 KiB ranges (the CDN slows each connection), whole and in order.
    let res = client().get(format!("{base}/seg/1/1.m4s")).send().await.unwrap();
    assert_eq!((res.status().as_u16(), header(&res, "content-length"), header(&res, "content-type")), (200, BIG_LEN.to_string(), "video/mp4".into()));
    assert!(res.bytes().await.unwrap() == big_segment());
    assert_eq!(mock.asked("/dash/x/chunk-stream1-00002.m4s"), BIG_LEN.div_ceil(95 * 1024));
    // Ranges that come back short end the answer in an error, never in a corrupt segment.
    let res = client().get(format!("{base}/seg/1/2.m4s")).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.bytes().await.is_err());

    let audio = get_text(&format!("{base}/a/3.m3u8")).await;
    assert!(audio.contains(&format!("#EXT-X-MAP:URI=\"/s/{sid}/init/3.mp4\"\n")) && audio.contains(&format!("/s/{sid}/seg/3/2734.m4s\n")));
    let (_, _, audio_init) = get(&format!("{base}/init/3.mp4")).await;
    assert_eq!(audio_init, AUDIO_INIT);

    let subs = get_text(&format!("{base}/subs.m3u8")).await;
    assert!(subs.contains(&format!("\n/s/{sid}/subs.vtt\n")) && subs.contains("#EXT-X-TARGETDURATION:13699\n"));
    let (status, content_type, vtt) = get(&format!("{base}/subs.vtt")).await;
    assert_eq!((status, content_type.as_str()), (200, "text/vtt; charset=utf-8"));
    assert_eq!(
        vtt,
        "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n00:01:02.500 --> 00:01:03.250\nTwo\n"
    );

    // Read once each: the manifest (142 KB: two ranges), and every init segment (open read them
    // for the codecs).
    assert_eq!(mock.asked("/dash/x/index.mpd"), 2);
    for i in 0..4 {
        assert_eq!(mock.asked(&format!("/dash/x/init-stream{i}.m4s")), 1, "init {i}");
    }

    for missing in ["v/9.m3u8", "init/9.mp4", "seg/1/2281.m4s", "seg/1/x.m4s", "seg/1", "video", "nothing"] {
        assert_eq!(get(&format!("{base}/{missing}")).await.0, 404, "{missing}");
    }
    server.close(&sid);
    assert_eq!(get(&play.url).await.0, 410);
    assert_eq!(get(&format!("{base}/subs.vtt")).await.0, 410);
}

#[tokio::test(flavor = "multi_thread")]
async fn dash_needs_the_sources_headers() {
    let mock = Mock::start().await;
    let server = Server::start().await.unwrap();

    // Segments are relative to where the manifest really is, after redirects.
    let play = server.open(source(&mock.url("/moved/index.mpd"), None)).await.expect("opens");
    assert!(play.subtitles.is_none());
    assert!(!get_text(&play.url).await.contains("SUBTITLES"));
    let (status, _, segment) = get(&format!("http://127.0.0.1:{}/s/{}/seg/0/5.m4s", server.port(), play.session)).await;
    assert_eq!(status, 200);
    assert!(segment.starts_with(b"segment chunk-stream0-00006.m4s"));

    // Without the source's headers the CDN says no, and the play says why.
    let mut bare = source(&mock.url("/dash/x/index.mpd"), None);
    bare.headers.clear();
    assert_eq!(server.open(bare).await.expect_err("refused"), "The stream answered 403.");

    // Subtitles that can't be had leave the film playing without them.
    let play = server.open(source(&mock.url("/dash/x/index.mpd"), Some(&mock.url("/subs/missing.srt")))).await.unwrap();
    assert!(play.subtitles.is_none());
    assert_eq!(get(&format!("http://127.0.0.1:{}/s/{}/subs.vtt", server.port(), play.session)).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn hls_passes_through() {
    let mock = Mock::start().await;
    let server = Server::start().await.unwrap();
    // The quality cap is for DASH: an HLS stream is passed through as it is.
    let play = server.open(capped(&mock.url("/hls/master.m3u8"), 240)).await.unwrap();
    assert_eq!(play.kind, "hls");
    assert_eq!(play.url, format!("http://127.0.0.1:{}/s/{}/master.m3u8", server.port(), play.session));
    let origin = format!("http://127.0.0.1:{}", server.port());
    let sid = &play.session;
    let here = |path: &str, playlist: bool| format!("/s/{sid}/h/{}{}", b64url(mock.url(path).as_bytes()), if playlist { ".m3u8" } else { "" });

    let (status, content_type, master) = get(&play.url).await;
    assert_eq!((status, content_type.as_str()), (200, "application/vnd.apple.mpegurl"));
    assert_eq!(
        String::from_utf8(master.to_vec()).unwrap(),
        format!(
            "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",URI=\"{}\"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO=\"aud\"\n{}\n",
            here("/hls/audio/index.m3u8", true),
            here("/hls/video/index", true)
        )
    );
    let video = get_text(&format!("{origin}{}", here("/hls/video/index", true))).await;
    assert_eq!(
        video,
        format!(
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"{}\"\n#EXTINF:4.0,\n{}\n#EXTINF:4.0,\n{}\n#EXT-X-ENDLIST\n",
            here("/hls/video/init.mp4", false),
            here("/hls/video/seg0.m4s", false),
            here("/hls/video/seg1.m4s", false)
        )
    );
    let (status, content_type, segment) = get(&format!("{origin}{}", here("/hls/video/seg0.m4s", false))).await;
    assert_eq!((status, content_type.as_str(), &segment[..]), (200, "video/mp4", &b"hls file /hls/video/seg0.m4s"[..]));
    let audio = get_text(&format!("{origin}{}", here("/hls/audio/index.m3u8", true))).await;
    assert!(audio.contains(&here("/hls/audio/a0.aac", false)));

    // Only what the playlists name is relayed.
    for link in [here("/hls/secret", false), here("/hls/secret", true), format!("/s/{sid}/h/not*base64")] {
        assert_eq!(get(&format!("{origin}{link}")).await.0, 403, "{link}");
    }
    assert_eq!(get(&format!("{origin}/s/{sid}/video")).await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn files_seek() {
    let mock = Mock::start().await;
    let server = Server::start().await.unwrap();
    let movie = movie();
    // With an extension, and without one (found out from its first bytes).
    for path in ["/file/movie.mp4", "/file/movie"] {
        let play = server.open(source(&mock.url(path), None)).await.unwrap();
        assert_eq!(play.kind, "file", "{path}");
        assert_eq!(play.url, format!("http://127.0.0.1:{}/s/{}/video", server.port(), play.session));
        let res = client().get(&play.url).header("range", "bytes=0-9").send().await.unwrap();
        assert_eq!(res.status(), 206);
        assert_eq!(header(&res, "content-range"), format!("bytes 0-9/{MOVIE_LEN}"));
        assert_eq!(header(&res, "content-type"), "video/mp4");
        assert_eq!(res.bytes().await.unwrap(), movie[..10]);

        let res = client().get(&play.url).header("range", "bytes=990-").send().await.unwrap();
        assert_eq!((res.status().as_u16(), header(&res, "content-range")), (206, format!("bytes 990-999/{MOVIE_LEN}")));
        assert_eq!(res.bytes().await.unwrap(), movie[990..]);

        let res = client().get(&play.url).send().await.unwrap();
        assert_eq!((res.status().as_u16(), header(&res, "content-length"), header(&res, "accept-ranges")), (200, "1000".into(), "bytes".into()));
        assert_eq!(res.bytes().await.unwrap(), movie);

        let res = client().head(&play.url).send().await.unwrap();
        assert_eq!((res.status().as_u16(), header(&res, "content-length")), (200, "1000".into()));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_without_extensions_are_sniffed() {
    let mock = Mock::start().await;
    let server = Server::start().await.unwrap();
    let hls = server.open(source(&mock.url("/sniff/playlist"), None)).await.unwrap();
    assert_eq!(hls.kind, "hls");
    assert!(get_text(&hls.url).await.contains(&format!("/s/{}/h/", hls.session)));
    let dash = server.open(source(&mock.url("/sniff/manifest"), None)).await.unwrap();
    assert_eq!(dash.kind, "hls");
    assert!(get_text(&dash.url).await.contains("CODECS=\"hvc1.1.6.L150.90,mp4a.40.2\""));
    assert_eq!(mock.asked("/sniff/init-stream1.m4s"), 1);
    // This server ignores Range: a segment is relayed as it comes, whole.
    let (status, _, segment) = get(&format!("http://127.0.0.1:{}/s/{}/seg/2/1.m4s", server.port(), dash.session)).await;
    assert_eq!((status, segment.len()), (200, BIG_LEN));
    assert_eq!(mock.asked("/sniff/chunk-stream2-00002.m4s"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn streams_stop_when_avplayer_hangs_up() {
    let mock = Mock::start().await;
    let server = Server::start().await.unwrap();
    let play = server.open(source(&mock.url("/endless.mp4"), None)).await.unwrap();
    let mut res = client().get(&play.url).send().await.unwrap();
    assert_eq!(res.status(), 200);
    // Bytes arrive while the (endless) stream goes on: streamed, not buffered.
    assert!(res.chunk().await.unwrap().is_some());
    drop(res);
    wait_until("the upstream request is dropped", || mock.endless_dropped.load(Ordering::SeqCst)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_play_cuts_its_streams() {
    let mock = Mock::start().await;
    let server = Server::start().await.unwrap();
    let play = server.open(source(&mock.url("/endless.mp4"), None)).await.unwrap();
    let mut res = client().get(&play.url).send().await.unwrap();
    assert!(res.chunk().await.unwrap().is_some());
    server.close(&play.session);
    // The body ends in an error, not a clean end: what AVPlayer had was cut short.
    let end = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match res.chunk().await {
                Ok(Some(_)) => continue,
                other => break other,
            }
        }
    })
    .await
    .expect("the stream is cut");
    assert!(end.is_err(), "cut, not finished: {end:?}");
    wait_until("the upstream request is dropped", || mock.endless_dropped.load(Ordering::SeqCst)).await;
    assert_eq!(get(&play.url).await.0, 410);
}

#[tokio::test(flavor = "multi_thread")]
async fn sessions_and_addresses() {
    let server = Server::start().await.unwrap();
    let origin = format!("http://127.0.0.1:{}", server.port());
    assert_eq!(get(&format!("{origin}/s/nope/master.m3u8")).await.0, 410);
    assert_eq!(get(&format!("{origin}/elsewhere")).await.0, 404);
    let res = client().post(format!("{origin}/s/nope/master.m3u8")).send().await.unwrap();
    assert_eq!(res.status(), 405);
    let bad = Source { url: "not a url".into(), headers: vec![], subtitle_url: None, title: String::new(), max_height: None };
    assert_eq!(server.open(bad).await.expect_err("refused"), "The stream's address isn't valid.");
    server.close("nope");

    // A file's play opens without asking upstream; plays left open beyond eight let the oldest go.
    let mut plays = Vec::new();
    for i in 0..9 {
        let play = server.open(source(&format!("http://127.0.0.1:9/{i}.mp4"), None)).await.unwrap();
        assert_eq!(play.session.len(), 16);
        assert!(play.session.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        plays.push(play);
    }
    // The oldest is gone; the others are there (port 9 refuses: a 502 that says so).
    assert_eq!(get(&plays[0].url).await.0, 410);
    let (status, _, body) = get(&plays[1].url).await;
    assert_eq!((status, &body[..]), (502, &b"Can't connect to the stream."[..]));
}

/// The variants a master playlist lists, by their playlist's name, in its order.
fn variants(master: &str) -> Vec<String> {
    master.lines().filter(|l| !l.starts_with('#')).filter_map(|l| l.rsplit('/').next()).map(str::to_string).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_picked_quality_caps_dash() {
    let mock = Mock::start().await;
    let server = Server::start().await.unwrap();
    // LOTR's one manifest: 0 = 1080p, 1 = 720p, 2 = 480p. Picking 720p leaves 1080p out: it is
    // neither listed nor served, and its init segment is never fetched.
    let play = server.open(capped(&mock.url("/dash/x/index.mpd"), 720)).await.unwrap();
    let master = get_text(&play.url).await;
    assert_eq!(variants(&master), ["1.m3u8", "2.m3u8"]);
    assert!(master.contains("CODECS=\"hvc1.1.6.L150.90,mp4a.40.2\"") && master.contains("#EXT-X-MEDIA:TYPE=AUDIO"));
    let base = format!("http://127.0.0.1:{}/s/{}", server.port(), play.session);
    assert_eq!(get(&format!("{base}/v/0.m3u8")).await.0, 404);
    assert_eq!(get(&format!("{base}/v/2.m3u8")).await.0, 200);
    assert_eq!(mock.asked("/dash/x/init-stream0.m4s"), 0);

    // Nearest 720p first (AVPlayer starts there); a cap nothing fits keeps the smallest.
    for (cap, expected) in [(None, &["1.m3u8", "2.m3u8", "0.m3u8"][..]), (Some(1080), &["1.m3u8", "2.m3u8", "0.m3u8"]), (Some(480), &["2.m3u8"]), (Some(240), &["2.m3u8"])] {
        let play = server.open(Source { max_height: cap, ..source(&mock.url("/dash/x/index.mpd"), None) }).await.unwrap();
        assert_eq!(variants(&get_text(&play.url).await), expected, "cap {cap:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_cookie_is_a_403() {
    let mock = Mock::start().await;
    let server = Server::start().await.unwrap();
    let origin = format!("http://127.0.0.1:{}", server.port());
    let dash = server.open(source(&mock.url("/dash/x/index.mpd"), None)).await.unwrap();
    let hls = server.open(source(&mock.url("/hls/master.m3u8"), None)).await.unwrap();
    let file = server.open(source(&mock.url("/file/movie.mp4"), None)).await.unwrap();
    let hls_variant = get_text(&hls.url).await.lines().filter(|l| !l.is_empty() && !l.starts_with('#')).last().unwrap().to_string();

    // The CDN's signed cookie runs out: AVPlayer (and the app, from its error log) gets 403, which
    // says "expired", not 502 "broken".
    mock.expired.store(true, Ordering::SeqCst);
    let base = format!("{origin}/s/{}", dash.session);
    for url in [format!("{base}/seg/1/0.m4s"), format!("{base}/init/3.mp4"), hls.url.clone(), format!("{origin}{hls_variant}"), file.url.clone()] {
        let (status, _, body) = get(&url).await;
        assert_eq!(status, 403, "{url}: {}", String::from_utf8_lossy(&body));
    }
    // What was read at open still answers; a play opened now says why it can't.
    assert_eq!(get(&dash.url).await.0, 200);
    assert_eq!(server.open(source(&mock.url("/dash/x/index.mpd"), None)).await.expect_err("expired"), "The stream answered 403.");
}
