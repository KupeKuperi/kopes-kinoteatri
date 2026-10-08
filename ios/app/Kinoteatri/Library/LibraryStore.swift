// The person's library, kept on the phone (the core has no favorites or history op): favorites,
// what they watched and where they stopped (Continue watching, History), titles they opened
// (Recently viewed) and their searches. One JSON file in Application Support, written a moment
// after each change. The phone's screens and CarPlay read the same store.

import Foundation

/// An episode of a series: where "Up next" goes once one is watched.
struct EpisodeRef: Codable, Hashable {
    var season: Int
    var episode: Int
    var title: String?
}

/// A title someone played, and where they got to. One per title (the last episode of a series).
struct WatchEntry: Codable, Hashable, Identifiable {
    /// The title as it was found (its id is the search result's, the library's key).
    var title: Title
    /// The dub that played: the id `streams` and `play` take.
    var playId: String
    var dubLabel: String?
    /// 0 for movies.
    var season: Int
    var episode: Int
    var episodeTitle: String?
    /// The stream that played (its index in `streams`) and its label ("1080p hevc").
    var stream: Int
    var streamLabel: String?
    /// Seconds.
    var position: Double
    var duration: Double?
    var updated: Date
    /// The episode after this one, to offer once this one is watched.
    var next: EpisodeRef?

    var id: String { title.id }
    var isSeries: Bool { title.isSeries }

    /// Watched to the end (the last 2 minutes or 6 % count as the end: credits).
    var isFinished: Bool {
        guard let duration, duration > 0 else { return false }
        return position >= duration * 0.94 || duration - position < 120
    }

    /// 0…1, when the length is known.
    var progress: Double? {
        guard let duration, duration > 0 else { return nil }
        return min(1, max(0, position / duration))
    }

    /// In Continue watching: stopped part way, or watched with a next episode to go.
    var showsInContinue: Bool {
        isFinished ? next != nil : position >= 5
    }

    /// "S1 · E3" for an episode, nil for a movie.
    var episodeTag: String? {
        isSeries && episode > 0 ? "S\(season) · E\(episode)" : nil
    }
}

/// A favorite: the title and when it was added.
struct FavoriteEntry: Codable, Hashable, Identifiable {
    var title: Title
    var added: Date

    var id: String { title.id }
}

@MainActor
final class LibraryStore: ObservableObject {
    static let historyLimit = 100
    static let recentTitlesLimit = 24
    static let searchesLimit = 12

    /// Newest first.
    @Published private(set) var history: [WatchEntry] = []
    /// Newest first.
    @Published private(set) var favorites: [FavoriteEntry] = []
    /// Titles opened, newest first.
    @Published private(set) var recentTitles: [Title] = []
    /// Newest first.
    @Published private(set) var recentSearches: [String] = []

    private struct Snapshot: Codable {
        var version = 1
        var history: [WatchEntry] = []
        var favorites: [FavoriteEntry] = []
        var recentTitles: [Title] = []
        var recentSearches: [String] = []
    }

    /// nil: kept in memory only (tests).
    private let file: URL?
    private var saveTask: Task<Void, Never>?

    init(file: URL?) {
        self.file = file
        load()
    }

    /// Application Support/KinoteatriApp/library.json (apart from the engine's folder). The UI
    /// tests (KINO_UI_TEST=1) get an empty library in a temporary file each launch.
    static func defaultFile() -> URL? {
        if ProcessInfo.processInfo.environment["KINO_UI_TEST"] == "1" {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("kino-uitest-library.json")
            try? FileManager.default.removeItem(at: file)
            return file
        }
        guard let support = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true) else {
            return nil
        }
        return support.appendingPathComponent("KinoteatriApp", isDirectory: true).appendingPathComponent("library.json")
    }

    // MARK: Continue watching and history

    var continueWatching: [WatchEntry] {
        history.filter(\.showsInContinue)
    }

    func entry(for titleId: String) -> WatchEntry? {
        history.first { $0.id == titleId }
    }

    /// A play started (or resumed): the title goes to the front.
    func record(_ entry: WatchEntry) {
        history.removeAll { $0.id == entry.id }
        history.insert(entry, at: 0)
        if history.count > Self.historyLimit {
            history.removeLast(history.count - Self.historyLimit)
        }
        changed()
    }

    /// Where the play of `titleId` has got to.
    func updateProgress(titleId: String, position: Double, duration: Double?) {
        guard position.isFinite, position > 0, let index = history.firstIndex(where: { $0.id == titleId }) else { return }
        var entry = history[index]
        entry.position = position
        if let duration, duration.isFinite, duration > 0 {
            entry.duration = duration
        }
        entry.updated = Date()
        history[index] = entry
        changed()
    }

    func removeFromHistory(_ titleId: String) {
        history.removeAll { $0.id == titleId }
        changed()
    }

    func clearHistory() {
        history = []
        changed()
    }

    // MARK: Favorites

    func isFavorite(_ titleId: String) -> Bool {
        favorites.contains { $0.id == titleId }
    }

    /// Adds or removes; true when it's a favorite now.
    @discardableResult
    func toggleFavorite(_ title: Title) -> Bool {
        if isFavorite(title.id) {
            favorites.removeAll { $0.id == title.id }
            changed()
            return false
        }
        favorites.insert(FavoriteEntry(title: title, added: Date()), at: 0)
        changed()
        return true
    }

    // MARK: Recently viewed and searches

    /// A title screen opened.
    func opened(_ title: Title) {
        recentTitles.removeAll { $0.id == title.id }
        recentTitles.insert(title, at: 0)
        if recentTitles.count > Self.recentTitlesLimit {
            recentTitles.removeLast(recentTitles.count - Self.recentTitlesLimit)
        }
        changed()
    }

    func searched(_ query: String) {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        recentSearches.removeAll { $0.caseInsensitiveCompare(text) == .orderedSame }
        recentSearches.insert(text, at: 0)
        if recentSearches.count > Self.searchesLimit {
            recentSearches.removeLast(recentSearches.count - Self.searchesLimit)
        }
        changed()
    }

    func removeSearch(_ query: String) {
        recentSearches.removeAll { $0 == query }
        changed()
    }

    func clearSearches() {
        recentSearches = []
        changed()
    }

    /// The title's details came: entries saved from a search result without a poster (or year,
    /// rating) get them.
    func improve(_ title: Title) {
        func better(_ old: Title) -> Title {
            Title(
                id: old.id,
                title: old.title.isEmpty ? title.title : old.title,
                year: old.year ?? title.year,
                kind: old.kind,
                poster: old.poster ?? title.poster,
                rating: old.rating ?? title.rating
            )
        }
        var any = false
        for index in favorites.indices where favorites[index].id == title.id {
            let improved = better(favorites[index].title)
            if improved != favorites[index].title {
                favorites[index].title = improved
                any = true
            }
        }
        for index in recentTitles.indices where recentTitles[index].id == title.id {
            let improved = better(recentTitles[index])
            if improved != recentTitles[index] {
                recentTitles[index] = improved
                any = true
            }
        }
        for index in history.indices where history[index].id == title.id {
            let improved = better(history[index].title)
            if improved != history[index].title {
                history[index].title = improved
                any = true
            }
        }
        if any {
            changed()
        }
    }

    // MARK: The file

    private func load() {
        guard let file, let data = try? Data(contentsOf: file) else { return }
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            let snapshot = try decoder.decode(Snapshot.self, from: data)
            history = snapshot.history
            favorites = snapshot.favorites
            recentTitles = snapshot.recentTitles
            recentSearches = snapshot.recentSearches
        } catch {
            Diagnostics.shared.log("library: unreadable, starting empty: \(error)")
        }
    }

    private func changed() {
        guard file != nil else { return }
        saveTask?.cancel()
        saveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            guard !Task.isCancelled else { return }
            self?.saveNow()
        }
    }

    /// Writes the file now (also when the app goes to the background).
    func saveNow() {
        saveTask?.cancel()
        saveTask = nil
        guard let file else { return }
        let snapshot = Snapshot(history: history, favorites: favorites, recentTitles: recentTitles, recentSearches: recentSearches)
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(snapshot)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: file, options: [.atomic])
        } catch {
            Diagnostics.shared.log("library: not saved: \(error)")
        }
    }
}
