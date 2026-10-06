//! DASH manifests as HLS playlists, HEVC init segments labelled for Apple's player, subtitles as
//! WebVTT: a port of the desktop app's src/main/phone/{dash,mp4,subs}.ts. OWNER: agent "hls".

mod dash;
mod mp4;
mod subs;

pub use dash::{
    DashManifest, HlsPaths, MediaType, Rendition, Segment, SubtitleTrack, XmlNode, cap_height, iso_seconds, language_tag, master_playlist,
    media_playlist, parse_mpd, parse_xml, subtitle_playlist,
};
pub use mp4::{codec_string, hvc1};
pub use subs::{read_subtitles, to_webvtt};
