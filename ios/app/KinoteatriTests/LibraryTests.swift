// The library kept on the phone: history (one entry per title, newest first, positions), Continue
// watching (part watched, or watched with a next episode), favorites, recently viewed, searches,
// and the file it's saved in.

import XCTest
@testable import Kinoteatri

@MainActor
final class LibraryTests: XCTestCase {
    private func title(_ id: String, kind: String = "movie", poster: String? = nil) -> Title {
        Title(id: id, title: "Title \(id)", year: "2010", kind: kind, poster: poster, rating: nil)
    }

    private func entry(_ id: String, position: Double = 0, duration: Double? = nil, kind: String = "movie", season: Int = 0, episode: Int = 0, next: EpisodeRef? = nil) -> WatchEntry {
        WatchEntry(
            title: title(id, kind: kind), playId: "\(id)-dub", dubLabel: nil, season: season, episode: episode, episodeTitle: nil,
            stream: 0, streamLabel: "1080p", position: position, duration: duration, updated: Date(), next: next
        )
    }

    func testHistoryKeepsOneEntryPerTitleNewestFirst() {
        let library = LibraryStore(file: nil)
        library.record(entry("a"))
        library.record(entry("b"))
        library.record(entry("a", position: 30))
        XCTAssertEqual(library.history.map(\.id), ["a", "b"])
        XCTAssertEqual(library.entry(for: "a")?.position, 30)
    }

    func testHistoryIsCapped() {
        let library = LibraryStore(file: nil)
        for index in 0..<(LibraryStore.historyLimit + 5) {
            library.record(entry("t\(index)"))
        }
        XCTAssertEqual(library.history.count, LibraryStore.historyLimit)
        XCTAssertEqual(library.history.first?.id, "t\(LibraryStore.historyLimit + 4)")
    }

    func testProgressUpdatesTheEntry() {
        let library = LibraryStore(file: nil)
        library.record(entry("a"))
        library.updateProgress(titleId: "a", position: 600, duration: 6000)
        XCTAssertEqual(library.entry(for: "a")?.position, 600)
        XCTAssertEqual(library.entry(for: "a")?.duration, 6000)
        XCTAssertEqual(library.entry(for: "a")?.progress ?? 0, 0.1, accuracy: 0.0001)
        // Not a number, nothing played, another title: no change.
        library.updateProgress(titleId: "a", position: .nan, duration: nil)
        library.updateProgress(titleId: "a", position: 0, duration: nil)
        library.updateProgress(titleId: "zzz", position: 10, duration: nil)
        XCTAssertEqual(library.entry(for: "a")?.position, 600)
    }

    func testContinueWatching() {
        let library = LibraryStore(file: nil)
        library.record(entry("barely", position: 2, duration: 6000))
        library.record(entry("halfway", position: 3000, duration: 6000))
        library.record(entry("credits", position: 5950, duration: 6000))
        library.record(entry("episode", position: 2700, duration: 2760, kind: "series", season: 1, episode: 3, next: EpisodeRef(season: 1, episode: 4, title: "Four")))
        XCTAssertEqual(library.continueWatching.map(\.id), ["episode", "halfway"])
        XCTAssertTrue(library.entry(for: "credits")?.isFinished == true)
        XCTAssertTrue(library.entry(for: "episode")?.isFinished == true)
        XCTAssertEqual(library.entry(for: "episode")?.episodeTag, "S1 · E3")
        XCTAssertNil(library.entry(for: "halfway")?.episodeTag)
    }

    func testFavorites() {
        let library = LibraryStore(file: nil)
        XCTAssertTrue(library.toggleFavorite(title("a")))
        XCTAssertTrue(library.toggleFavorite(title("b")))
        XCTAssertEqual(library.favorites.map(\.id), ["b", "a"])
        XCTAssertTrue(library.isFavorite("a"))
        XCTAssertFalse(library.toggleFavorite(title("a")))
        XCTAssertFalse(library.isFavorite("a"))
    }

    func testSearchesAreDedupedCaseInsensitivelyAndCapped() {
        let library = LibraryStore(file: nil)
        library.searched("  Inception ")
        library.searched("dune")
        library.searched("inception")
        XCTAssertEqual(library.recentSearches, ["inception", "dune"])
        library.searched("   ")
        XCTAssertEqual(library.recentSearches.count, 2)
        for index in 0..<20 {
            library.searched("q\(index)")
        }
        XCTAssertEqual(library.recentSearches.count, LibraryStore.searchesLimit)
        XCTAssertEqual(library.recentSearches.first, "q19")
    }

    func testDetailsImproveSavedTitles() {
        let library = LibraryStore(file: nil)
        library.toggleFavorite(title("a"))
        library.opened(title("a"))
        library.record(entry("a"))
        library.improve(title("a", poster: "https://img/a.jpg"))
        XCTAssertEqual(library.favorites.first?.title.poster, "https://img/a.jpg")
        XCTAssertEqual(library.recentTitles.first?.poster, "https://img/a.jpg")
        XCTAssertEqual(library.history.first?.title.poster, "https://img/a.jpg")
    }

    func testSavedAndReadBack() throws {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("kino-library-test-\(UUID().uuidString)")
            .appendingPathComponent("library.json")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let library = LibraryStore(file: file)
        library.record(entry("a", position: 42, duration: 100))
        library.toggleFavorite(title("b"))
        library.opened(title("c"))
        library.searched("dune")
        library.saveNow()

        let again = LibraryStore(file: file)
        // Dates are kept to the second.
        XCTAssertEqual(again.history.map(\.id), ["a"])
        XCTAssertEqual(again.history.first?.position, 42)
        XCTAssertEqual(again.history.first?.duration, 100)
        XCTAssertEqual(again.history.first?.streamLabel, "1080p")
        XCTAssertEqual(again.history.first?.updated.timeIntervalSince1970 ?? 0, library.history[0].updated.timeIntervalSince1970, accuracy: 1)
        XCTAssertEqual(again.favorites.map(\.id), ["b"])
        XCTAssertEqual(again.recentTitles.map(\.id), ["c"])
        XCTAssertEqual(again.recentSearches, ["dune"])
    }

    func testAnUnreadableFileStartsEmpty() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("kino-library-bad-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        try Data("not json".utf8).write(to: file)
        let library = LibraryStore(file: file)
        XCTAssertTrue(library.history.isEmpty)
        XCTAssertTrue(library.favorites.isEmpty)
    }
}
