//! The JSON the app and the core exchange (contract: ios/GUIDE.md, include/kino.h), and the
//! internal hand-off from the engine to the stream server. Field names are the contract: change
//! them only together with GUIDE.md and the app's Models.swift.

use serde::{Deserialize, Serialize};

/// One request from the app.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Version,
    Search {
        query: String,
    },
    Details {
        id: String,
    },
    Streams {
        id: String,
        #[serde(default)]
        season: usize,
        #[serde(default)]
        episode: usize,
    },
    Play {
        id: String,
        #[serde(default)]
        season: usize,
        #[serde(default)]
        episode: usize,
        stream: usize,
        /// A subtitle language ("English"); none when absent.
        #[serde(default)]
        subtitles: Option<String>,
    },
    Stop {
        session: String,
    },
}

/// A search result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Title {
    pub id: String,
    pub title: String,
    pub year: Option<String>,
    /// "movie" or "series".
    pub kind: String,
    pub poster: Option<String>,
    pub rating: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Details {
    pub id: String,
    pub title: String,
    pub year: Option<String>,
    pub kind: String,
    pub description: Option<String>,
    pub poster: Option<String>,
    pub rating: Option<String>,
    pub duration: Option<String>,
    pub genres: Vec<String>,
    /// Empty for movies.
    pub seasons: Vec<SeasonInfo>,
    /// Other dubs of the same title (each is a title of its own, with its own id).
    pub audio: Vec<AudioTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SeasonInfo {
    pub season: usize,
    pub episodes: Vec<EpisodeInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EpisodeInfo {
    pub episode: usize,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AudioTrack {
    pub id: String,
    pub label: String,
}

/// One playable version of a title or episode (quality, size, codec…), as `streams` lists them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stream {
    /// What `play` takes as `stream`.
    pub index: usize,
    pub quality: Option<String>,
    pub size_bytes: Option<u64>,
    pub codec: Option<String>,
    pub audio: Option<String>,
    pub label: String,
}

/// Where AVPlayer finds a play: URLs on the local server (127.0.0.1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Play {
    /// Passed back to `stop`.
    pub session: String,
    pub url: String,
    /// "hls" (DASH and HLS sources) or "file" (an MP4 and the like, with seeking).
    pub kind: String,
    /// WebVTT subtitles (HLS plays also list them in their playlist).
    pub subtitles: Option<String>,
    pub title: String,
}

/// What the engine hands a video player: the stream, the headers the source wants with every
/// request, and a subtitle file URL. The server relays it to AVPlayer.
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub subtitle_url: Option<String>,
    pub title: String,
}
