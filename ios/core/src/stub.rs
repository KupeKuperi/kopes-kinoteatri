//! The core without the engine (`--no-default-features`): canned titles, and Apple's public HLS
//! test stream to play. Lets the app and CI be built and tested apart from the engine.

use crate::api::{Details, EpisodeInfo, SeasonInfo, Source, Stream, Title};

pub const ENGINE_VERSION: &str = "stub";

/// Apple's own HLS example (H.264, several qualities): always online, plays everywhere.
const TEST_STREAM: &str = "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8";

pub async fn init() -> Result<(), String> {
    Ok(())
}

fn titles() -> Vec<Title> {
    vec![
        Title {
            id: "stub-movie".into(),
            title: "Bip Bop (test movie)".into(),
            year: Some("2010".into()),
            kind: "movie".into(),
            poster: None,
            rating: Some("7.5".into()),
        },
        Title {
            id: "stub-series".into(),
            title: "Bip Bop (test series)".into(),
            year: Some("2012".into()),
            kind: "series".into(),
            poster: None,
            rating: None,
        },
    ]
}

pub async fn search(query: &str) -> Result<Vec<Title>, String> {
    let q = query.trim().to_lowercase();
    Ok(titles().into_iter().filter(|t| q.is_empty() || t.title.to_lowercase().contains(&q) || "bip bop test".contains(&q)).collect())
}

pub async fn details(id: &str) -> Result<Details, String> {
    let t = titles().into_iter().find(|t| t.id == id).ok_or_else(|| format!("No title {id}."))?;
    let seasons = if t.kind == "series" {
        vec![SeasonInfo { season: 1, episodes: (1..=3).map(|e| EpisodeInfo { episode: e, title: Some(format!("Episode {e}")) }).collect() }]
    } else {
        vec![]
    };
    Ok(Details {
        id: t.id,
        title: t.title,
        year: t.year,
        kind: t.kind,
        description: Some("Apple's HLS test stream, standing in for a film while the engine isn't built in.".into()),
        poster: None,
        rating: t.rating,
        duration: Some("30m".into()),
        genres: vec!["Test".into()],
        seasons,
        audio: vec![],
    })
}

pub async fn streams(id: &str, _season: usize, _episode: usize) -> Result<Vec<Stream>, String> {
    details(id).await?;
    Ok(vec![Stream { index: 0, quality: Some("Auto".into()), size_bytes: None, codec: Some("H.264".into()), audio: None, label: "Apple test stream".into() }])
}

pub async fn resolve(id: &str, season: usize, episode: usize, stream: usize, _subtitles: Option<&str>) -> Result<Source, String> {
    let list = streams(id, season, episode).await?;
    list.get(stream).ok_or_else(|| format!("No stream {stream}."))?;
    let title = details(id).await?.title;
    Ok(Source { url: TEST_STREAM.into(), headers: vec![], subtitle_url: None, subtitle_lang: None, title, max_height: None })
}
