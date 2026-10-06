//! The engine (moviebox-tui, ios/engine) as the core uses it: search, details, streams, and
//! resolving a stream to what a video player would get. OWNER: agent "engine" (see GUIDE.md).
//! Placeholder until then: every call reports that it isn't built yet.

use crate::api::{Details, Source, Stream, Title};

pub const ENGINE_VERSION: &str = "0.1.26";

const TODO: &str = "The engine bridge isn't built yet.";

pub async fn init() -> Result<(), String> {
    Ok(())
}

pub async fn search(_query: &str) -> Result<Vec<Title>, String> {
    Err(TODO.into())
}

pub async fn details(_id: &str) -> Result<Details, String> {
    Err(TODO.into())
}

pub async fn streams(_id: &str, _season: usize, _episode: usize) -> Result<Vec<Stream>, String> {
    Err(TODO.into())
}

pub async fn resolve(_id: &str, _season: usize, _episode: usize, _stream: usize, _subtitles: Option<&str>) -> Result<Source, String> {
    Err(TODO.into())
}
