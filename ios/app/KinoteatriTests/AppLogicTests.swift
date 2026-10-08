// The app layer's rules, without the network: times and stream facts, subtitle languages (the
// core's table), the next episode, which stream Play picks, the search filter, the Now Playing
// info, what the car's lists say, and that the CarPlay scene Info.plist declares is a real class.

import CarPlay
import MediaPlayer
import XCTest
@testable import Kinoteatri

final class AppLogicTests: XCTestCase {
    private let movie = Title(id: "m1", title: "Inception", year: "2010", kind: "movie", poster: "https://img/m1.jpg", rating: "8.8")
    private let series = Title(id: "s1", title: "Lanterns", year: "2026", kind: "series", poster: nil, rating: nil)

    // MARK: Format

    func testClock() {
        XCTAssertEqual(Format.clock(0), "0:00")
        XCTAssertEqual(Format.clock(2530), "42:10")
        XCTAssertEqual(Format.clock(3730), "1:02:10")
        XCTAssertEqual(Format.clock(.nan), "0:00")
        XCTAssertEqual(Format.clock(-5), "0:00")
    }

    func testStreamFacts() {
        let stream = Stream(index: 0, quality: "1080p", sizeBytes: nil, codec: "hevc", audio: "English", label: "1080p hevc")
        XCTAssertEqual(Format.facts(stream), "HEVC · English")
        let bare = Stream(index: 1, quality: nil, sizeBytes: nil, codec: nil, audio: "", label: "x")
        XCTAssertEqual(Format.facts(bare), "")
    }

    // MARK: Subtitles

    func testSubtitleLanguagesMatchTheCoresNames() {
        XCTAssertEqual(SubtitleLanguages.code(for: "English"), "en")
        XCTAssertEqual(SubtitleLanguages.code(for: " english "), "en")
        XCTAssertEqual(SubtitleLanguages.code(for: "Georgian"), "ka")
        XCTAssertEqual(SubtitleLanguages.code(for: "Filipino"), "fil")
        XCTAssertNil(SubtitleLanguages.code(for: "Klingon"))
        XCTAssertEqual(SubtitleLanguages.all.count, 36)
        XCTAssertEqual(Set(SubtitleLanguages.all.map(\.code)).count, 36, "A code twice")
    }

    // MARK: Episodes and streams

    func testNextEpisode() {
        let seasons = [
            SeasonInfo(season: 2, episodes: [EpisodeInfo(episode: 1, title: "S2 one")]),
            SeasonInfo(season: 1, episodes: [EpisodeInfo(episode: 2, title: "Two"), EpisodeInfo(episode: 1, title: "One")]),
            SeasonInfo(season: 3, episodes: []),
        ]
        XCTAssertEqual(nextEpisode(after: 1, 1, in: seasons), EpisodeRef(season: 1, episode: 2, title: "Two"))
        XCTAssertEqual(nextEpisode(after: 1, 2, in: seasons), EpisodeRef(season: 2, episode: 1, title: "S2 one"))
        XCTAssertNil(nextEpisode(after: 2, 1, in: seasons), "Season 3 has no episodes")
        XCTAssertNil(nextEpisode(after: 9, 1, in: seasons))
    }

    func testPlayQualityPicks() {
        let streams = [
            Stream(index: 0, quality: "1080p", sizeBytes: 4_000_000_000, codec: nil, audio: nil, label: "1080p"),
            Stream(index: 1, quality: "720p", sizeBytes: 2_000_000_000, codec: nil, audio: nil, label: "720p"),
            Stream(index: 2, quality: "360p", sizeBytes: 500_000_000, codec: nil, audio: nil, label: "360p"),
        ]
        XCTAssertEqual(PlayQuality.best.pick(from: streams)?.index, 0)
        XCTAssertEqual(PlayQuality.light.pick(from: streams)?.index, 2)
        XCTAssertNil(PlayQuality.best.pick(from: []))
    }

    func testKindFilter() {
        XCTAssertEqual(KindFilter.all.apply([movie, series]).map(\.id), ["m1", "s1"])
        XCTAssertEqual(KindFilter.movies.apply([movie, series]).map(\.id), ["m1"])
        XCTAssertEqual(KindFilter.series.apply([movie, series]).map(\.id), ["s1"])
    }

    func testLibraryTitleKeepsTheSearchId() {
        let details = Details(
            id: "dub-7", title: "Inception", year: "2010", kind: "movie", description: nil, poster: "https://img/p.jpg",
            rating: "8.8", duration: "2h 28m", genres: [], seasons: [], audio: []
        )
        let shown = details.libraryTitle(id: "m1", fallback: Title(id: "m1", title: "Inception", year: nil, kind: "movie", poster: nil, rating: nil))
        XCTAssertEqual(shown.id, "m1")
        XCTAssertEqual(shown.poster, "https://img/p.jpg")
        XCTAssertEqual(shown.year, "2010")
    }

    // MARK: Now Playing

    func testPlayInfoLines() {
        XCTAssertEqual(PlayInfo(title: movie, playId: "m1").subtitleLine, "2010 · Movie")
        let episode = PlayInfo(title: series, playId: "s1", season: 1, episode: 3, episodeTitle: "Pilot")
        XCTAssertTrue(episode.isEpisode)
        XCTAssertEqual(episode.subtitleLine, "S1 · E3 · Pilot")
    }

    func testNowPlayingInfo() {
        let info = NowPlaying.info(for: PlayInfo(title: movie, playId: "m1"), elapsed: 61.5, rate: 1, duration: 8880)
        XCTAssertEqual(info[MPMediaItemPropertyTitle] as? String, "Inception")
        XCTAssertEqual(info[MPMediaItemPropertyArtist] as? String, "2010 · Movie")
        XCTAssertEqual(info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double, 61.5)
        XCTAssertEqual(info[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 1)
        XCTAssertEqual(info[MPMediaItemPropertyPlaybackDuration] as? Double, 8880)
        XCTAssertEqual(info[MPNowPlayingInfoPropertyMediaType] as? UInt, MPNowPlayingInfoMediaType.video.rawValue)
        let paused = NowPlaying.info(for: PlayInfo(title: movie, playId: "m1"), elapsed: .nan, rate: 0, duration: nil)
        XCTAssertEqual(paused[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double, 0)
        XCTAssertEqual(paused[MPNowPlayingInfoPropertyPlaybackRate] as? Double, 0)
        XCTAssertNil(paused[MPMediaItemPropertyPlaybackDuration])
    }

    // MARK: CarPlay

    private func watched(_ title: Title, position: Double, duration: Double?, season: Int = 0, episode: Int = 0, next: EpisodeRef? = nil) -> WatchEntry {
        WatchEntry(
            title: title, playId: title.id, dubLabel: nil, season: season, episode: episode, episodeTitle: nil, stream: 0,
            streamLabel: nil, position: position, duration: duration, updated: Date(), next: next
        )
    }

    func testCarRows() {
        let halfway = watched(movie, position: 3000, duration: 6000)
        let row = CarPlayContent.continueRow(halfway, playing: PlayInfo(title: movie, playId: "m1"))
        XCTAssertEqual(row.text, "Inception")
        XCTAssertTrue(row.playing)
        XCTAssertFalse(row.opens)
        XCTAssertEqual(row.poster, "https://img/m1.jpg")

        let done = watched(series, position: 2750, duration: 2760, season: 1, episode: 3, next: EpisodeRef(season: 1, episode: 4, title: nil))
        XCTAssertEqual(CarPlayContent.continueRow(done, playing: nil).detail, "Up next: S1 E4")
        XCTAssertEqual(CarPlayContent.resumeRow(done)?.text, "Up next: S1 E4")
        XCTAssertEqual(CarPlayContent.resumeRow(halfway)?.text, "Resume from 50:00")
        XCTAssertNil(CarPlayContent.resumeRow(watched(movie, position: 1, duration: 6000)))

        let favorite = CarPlayContent.titleRow(movie, playing: nil)
        XCTAssertTrue(favorite.opens)
        XCTAssertEqual(favorite.detail, "2010 · Movie · ★ 8.8")

        let episode = CarPlayContent.episodeRow(EpisodeInfo(episode: 3, title: nil), season: 1, entry: done, playing: nil, titleId: "s1")
        XCTAssertEqual(episode.text, "3. Episode 3")
        XCTAssertEqual(episode.detail, "Watched")
        XCTAssertEqual(CarPlayContent.capped(Array(0..<30), 12).count, 12)
        XCTAssertEqual(CarPlayContent.capped([1, 2], 0), [1], "A list keeps at least one row")
    }

    /// Info.plist's CarPlay scene names a class the app has, and it is a CarPlay scene delegate.
    func testCarPlaySceneIsDeclared() throws {
        let manifest = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: "UIApplicationSceneManifest") as? [String: Any])
        let configurations = try XCTUnwrap(manifest["UISceneConfigurations"] as? [String: Any])
        let car = try XCTUnwrap((configurations["CPTemplateApplicationSceneSessionRoleApplication"] as? [[String: Any]])?.first)
        XCTAssertEqual(car["UISceneClassName"] as? String, "CPTemplateApplicationScene")
        let name = try XCTUnwrap(car["UISceneDelegateClassName"] as? String)
        let type = try XCTUnwrap(NSClassFromString(name) as? NSObject.Type, "No class \(name)")
        XCTAssertTrue(type.conforms(to: CPTemplateApplicationSceneDelegate.self), "\(name) isn't a CarPlay scene delegate")
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
        XCTAssertTrue(modes.contains("audio"), "CarPlay audio needs the audio background mode")
    }
}
