// The JSON the core answers with: the contract in ios/GUIDE.md (Rust side: ios/core/src/api.rs).
// Field names are the contract; change them only together with GUIDE.md and api.rs.

import Foundation

/// `{"op":"version"}`
struct CoreVersion: Codable, Equatable {
    let core: String
    let engine: String
    /// "engine" (MovieBox) or "stub" (canned titles, Apple's test stream).
    let mode: String
}

/// A search result.
struct Title: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let year: String?
    /// "movie" or "series".
    let kind: String
    let poster: String?
    let rating: String?
}

struct Details: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let year: String?
    let kind: String
    let description: String?
    let poster: String?
    let rating: String?
    let duration: String?
    let genres: [String]
    /// Empty for movies.
    let seasons: [SeasonInfo]
    /// Other dubs of the same title (each is a title of its own, with its own id).
    let audio: [AudioTrack]
}

struct SeasonInfo: Codable, Hashable {
    let season: Int
    let episodes: [EpisodeInfo]
}

struct EpisodeInfo: Codable, Hashable {
    let episode: Int
    let title: String?
}

struct AudioTrack: Codable, Hashable, Identifiable {
    let id: String
    let label: String
}

/// One playable version of a title or episode, as `streams` lists them.
struct Stream: Codable, Hashable, Identifiable {
    /// What `play` takes as `stream`.
    let index: Int
    let quality: String?
    let sizeBytes: UInt64?
    let codec: String?
    let audio: String?
    let label: String

    var id: Int { index }

    enum CodingKeys: String, CodingKey {
        case index, quality, codec, audio, label
        case sizeBytes = "size_bytes"
    }
}

/// Where AVPlayer finds a play: URLs on the core's local server (127.0.0.1).
struct Play: Codable, Hashable, Identifiable {
    /// Passed back to `stop`.
    let session: String
    let url: String
    /// "hls" or "file".
    let kind: String
    /// WebVTT subtitles (HLS plays also list them in their playlist).
    let subtitles: String?
    let title: String

    var id: String { session }
}

extension Title {
    var isSeries: Bool { kind == "series" }
}

extension Details {
    var isSeries: Bool { kind == "series" }

    /// The dub to start with, by the TUI's rule: Original, else English, else the first
    /// (the same matching as kino-smoke's `preferred_audio`).
    var preferredAudio: AudioTrack? { Self.preferredAudio(in: audio) }

    static func preferredAudio(in tracks: [AudioTrack]) -> AudioTrack? {
        func find(_ patterns: [String]) -> AudioTrack? {
            tracks.first { track in
                let label = track.label.lowercased()
                return patterns.contains { label.contains($0) }
            }
        }
        return find(["original", "orig"]) ?? find(["english", "eng"]) ?? tracks.first
    }
}

/// "2010 · Movie" and the like.
func kindLine(year: String?, kind: String, extra: [String?] = []) -> String {
    let kindName = kind == "series" ? "Series" : kind == "movie" ? "Movie" : kind.capitalized
    return ([year, kindName] + extra).compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
}
