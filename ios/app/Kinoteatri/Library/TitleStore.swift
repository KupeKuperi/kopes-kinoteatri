// A title's screen, without the screen: its details (on the TUI's default dub: Original, else
// English, else the first; or the dub last played), the other dubs, the season and episode
// chosen (where the person left off, for a series they watch), and the streams of the film or that
// episode. CarPlay uses the same loading rules.

import Foundation

@MainActor
final class TitleStore: ObservableObject {
    enum Load: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    /// The title as it was opened (search result, favorite, history).
    let title: Title

    /// The details of the dub shown: its id is what streams and play use.
    @Published private(set) var details: Details?
    @Published private(set) var detailsLoad: Load = .idle
    /// Every dub of the title (the details of each list them all).
    @Published private(set) var audio: [AudioTrack] = []
    /// The dub being loaded.
    @Published private(set) var switchingAudio: String?
    @Published private(set) var season = 0
    @Published private(set) var episode = 0
    @Published private(set) var streams: [Stream] = []
    @Published private(set) var streamsLoad: Load = .idle
    /// A dub that didn't load (an alert).
    @Published var failure: String?

    /// The dub/season/episode the streams are for, so coming back from the player doesn't reload
    /// them.
    private var streamsKey: String?
    private let library: LibraryStore

    init(title: Title, library: LibraryStore) {
        self.title = title
        self.library = library
    }

    /// The title with what the details add (poster, year, rating), under the title's own id.
    var libraryTitle: Title {
        details?.libraryTitle(id: title.id, fallback: title) ?? title
    }

    var isSeries: Bool {
        details?.isSeries ?? title.isSeries
    }

    /// Changes when the streams to show change (the view reloads them with it).
    var streamsTaskKey: String {
        "\(details?.id ?? "")/\(season)/\(episode)"
    }

    var currentDub: AudioTrack? {
        audio.first { $0.id == details?.id }
    }

    /// The seasons, in order.
    var seasons: [SeasonInfo] {
        (details?.seasons ?? []).sorted { $0.season < $1.season }
    }

    var episodes: [EpisodeInfo] {
        seasons.first { $0.season == season }?.episodes.sorted { $0.episode < $1.episode } ?? []
    }

    /// What Play would play now (nil until the details came).
    var playInfo: PlayInfo? {
        guard let details else { return nil }
        let series = details.isSeries
        return PlayInfo(
            title: libraryTitle,
            playId: details.id,
            dubLabel: currentDub?.label,
            season: series ? season : 0,
            episode: series ? episode : 0,
            episodeTitle: series ? details.episodeTitle(season: season, episode: episode) : nil,
            next: series ? nextEpisode(after: season, episode, in: details.seasons) : nil
        )
    }

    // MARK: Loading

    func load() async {
        guard details == nil, detailsLoad != .loading else { return }
        detailsLoad = .loading
        let last = library.entry(for: title.id)
        do {
            let (loaded, tracks) = try await Self.preferredDetails(id: title.id, preferring: last?.playId)
            remember(tracks)
            show(loaded, keeping: Self.resumeEpisode(last))
            detailsLoad = .loaded
            library.improve(libraryTitle)
        } catch {
            detailsLoad = .failed(describe(error))
        }
    }

    func reload() async {
        details = nil
        detailsLoad = .idle
        await load()
    }

    /// The details to open on: `preferring` (the dub played last) when the title has it, else the
    /// TUI's default dub; and every dub the title has.
    static func preferredDetails(id: String, preferring dubId: String? = nil) async throws -> (Details, [AudioTrack]) {
        var loaded = try await KinoCore.shared.details(id: id)
        var tracks = loaded.audio
        let wanted = dubId.flatMap { dub in loaded.audio.first { $0.id == dub } } ?? loaded.preferredAudio
        if let wanted, wanted.id != loaded.id {
            do {
                loaded = try await KinoCore.shared.details(id: wanted.id)
                if !loaded.audio.isEmpty {
                    tracks = loaded.audio
                }
            } catch {
                Diagnostics.shared.log("dub \(wanted.label) didn't load, staying on \(loaded.id): \(describe(error))")
            }
        }
        return (loaded, tracks)
    }

    /// For a series watched before: the episode it stopped in, or the next one once that was watched.
    static func resumeEpisode(_ entry: WatchEntry?) -> (season: Int, episode: Int)? {
        guard let entry, entry.isSeries, entry.episode > 0 else { return nil }
        if entry.isFinished, let next = entry.next {
            return (next.season, next.episode)
        }
        return (entry.season, entry.episode)
    }

    func switchAudio(to track: AudioTrack) async {
        guard let current = details, track.id != current.id, switchingAudio == nil else { return }
        switchingAudio = track.id
        defer { switchingAudio = nil }
        do {
            let loaded = try await KinoCore.shared.details(id: track.id)
            remember(loaded.audio)
            show(loaded, keeping: (season: season, episode: episode))
        } catch {
            failure = describe(error)
        }
    }

    func select(season chosen: Int) {
        guard chosen != season else { return }
        season = chosen
        episode = episodes.first?.episode ?? 0
    }

    func select(episode chosen: Int) {
        episode = chosen
    }

    private func remember(_ tracks: [AudioTrack]) {
        if !tracks.isEmpty {
            audio = tracks
        }
    }

    /// Shows a dub: the same episode if it has it (`keeping`), else its first one. Changing the
    /// details' id reloads the streams.
    private func show(_ loaded: Details, keeping: (season: Int, episode: Int)? = nil) {
        var chosen = (season: 0, episode: 0)
        if loaded.isSeries {
            let ordered = loaded.seasons.sorted { $0.season < $1.season }
            if let keeping, loaded.seasons.contains(where: { $0.season == keeping.season && $0.episodes.contains { $0.episode == keeping.episode } }) {
                chosen = keeping
            } else if let first = ordered.first(where: { !$0.episodes.isEmpty }) ?? ordered.first {
                chosen = (season: first.season, episode: first.episodes.map(\.episode).min() ?? 0)
            }
        }
        season = chosen.season
        episode = chosen.episode
        details = loaded
    }

    func loadStreams() async {
        guard let details else { return }
        let key = "\(details.id)/\(season)/\(episode)"
        guard key != streamsKey else { return }
        streams = []
        streamsKey = nil
        if details.isSeries && episode == 0 {
            streamsLoad = .idle
            return
        }
        streamsLoad = .loading
        do {
            let list = try await KinoCore.shared.streams(id: details.id, season: season, episode: episode)
            guard !Task.isCancelled else { return }
            streams = list
            streamsKey = key
            streamsLoad = .loaded
        } catch {
            guard !Task.isCancelled else { return }
            streamsLoad = .failed(describe(error))
        }
    }

    func retryStreams() async {
        streamsKey = nil
        await loadStreams()
    }
}
