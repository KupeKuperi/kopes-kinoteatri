//! The local stream server AVPlayer plays from (127.0.0.1): relays each play with its source's
//! headers, DASH as HLS. OWNER: agent "hls" (see GUIDE.md).
//! Placeholder until then: `open` hands back the source URL itself (fine for the stub's public
//! HLS test stream, which needs no headers).

use crate::api::{Play, Source};

pub struct Server {
    port: u16,
}

impl Server {
    pub async fn start() -> Result<Server, String> {
        Ok(Server { port: 0 })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub async fn open(&self, source: Source) -> Result<Play, String> {
        Ok(Play { session: "direct".into(), url: source.url, kind: "hls".into(), subtitles: None, title: source.title })
    }

    pub fn close(&self, _session: &str) {}
}
