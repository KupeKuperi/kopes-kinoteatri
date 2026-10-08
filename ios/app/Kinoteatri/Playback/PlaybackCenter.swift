// One playback for the whole app. The phone's full-screen player, the mini player, Now Playing (lock
// screen, Control Center) and CarPlay all show and steer the same PlayerModel, so a film started on
// the phone can be paused in the car and the other way round. A play starts here (a title's Play or
// stream, Continue watching, the car, "next episode"), goes into the library's history, and keeps
// its position there while it plays. Now Playing is published here, not by Apple's player, so it is
// the same whether the player is on screen or not (the car starts plays without the picture).

import AVFoundation
import Combine
import UIKit

/// What's playing, as the library, the mini player, Now Playing and CarPlay describe it.
struct PlayInfo: Equatable {
    /// The title as found (the library's key).
    var title: Title
    /// The dub's id: what `streams` and `play` take.
    var playId: String
    var dubLabel: String?
    /// 0 for movies.
    var season: Int
    var episode: Int
    var episodeTitle: String?
    var next: EpisodeRef?

    var isEpisode: Bool { title.isSeries && episode > 0 }

    /// "S1 · E3 · Pilot" for an episode, "2010 · Movie" for a film.
    var subtitleLine: String {
        guard isEpisode else { return kindLine(year: title.year, kind: title.kind) }
        return ["S\(season) · E\(episode)", episodeTitle].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    init(title: Title, playId: String, dubLabel: String? = nil, season: Int = 0, episode: Int = 0, episodeTitle: String? = nil, next: EpisodeRef? = nil) {
        self.title = title
        self.playId = playId
        self.dubLabel = dubLabel
        self.season = season
        self.episode = episode
        self.episodeTitle = episodeTitle
        self.next = next
    }

    /// The play a history entry was.
    init(entry: WatchEntry) {
        self.init(
            title: entry.title, playId: entry.playId, dubLabel: entry.dubLabel, season: entry.season,
            episode: entry.episode, episodeTitle: entry.episodeTitle, next: entry.next
        )
    }
}

/// Where a play was asked for: the phone shows it full screen; the car plays the sound (the phone's
/// mini player offers the picture); the lock screen's or car's "next" keeps whatever was shown.
enum PlayOrigin {
    case phone
    case car
    case controls
}

/// Which stream to play.
enum StreamChoice {
    /// One the person picked from the list.
    case stream(Stream)
    /// The one played before (Resume), by its index.
    case index(Int, label: String?)
    /// By quality, from the streams of the film or episode.
    case quality(PlayQuality)
}

@MainActor
final class PlaybackCenter: ObservableObject {
    static let shared = PlaybackCenter()

    /// What plays now (nil: nothing).
    @Published private(set) var info: PlayInfo?
    @Published private(set) var isPlaying = false
    /// A play the core is resolving: the "Starting…" card on the phone.
    @Published private(set) var starting: PlayInfo?
    /// The phone's full-screen player is up.
    @Published private(set) var isScreenShown = false
    /// Why a play from the phone didn't start (an alert).
    @Published var failure: String?
    /// The poster of what plays (Now Playing, the mini player, CarPlay).
    @Published private(set) var artwork: UIImage?

    private(set) var model: PlayerModel?
    private var screen: PlayerScreen?
    private weak var library: LibraryStore?
    private var subscriptions: Set<AnyCancellable> = []
    /// Bumped by each play and by Cancel: a play that resolves after either is dropped.
    private var generation = 0

    /// Set by CarPlay. While connected, closing the phone's player or locking the phone keeps the
    /// sound going in the car.
    var carConnected = false {
        didSet { applyBackgroundPolicy() }
    }

    /// The UI tests start films further in (KINO_UITEST_START_AT, seconds).
    static let testStartAt = ProcessInfo.processInfo.environment["KINO_UITEST_START_AT"].flatMap { Double($0) }

    private init() {
        RemoteCommands.install()
        RemoteCommands.update(playing: false, next: false)
    }

    func attach(library: LibraryStore) {
        self.library = library
    }

    /// The phone's mini player shows while something plays without the full-screen player.
    var showsMiniPlayer: Bool { info != nil && !isScreenShown }

    // MARK: Starting

    /// Asks the core for the play and starts it (see PlayOrigin for where it shows). Throws the
    /// core's error; false when another play or Cancel came first.
    @discardableResult
    func play(_ asked: PlayInfo, _ choice: StreamChoice, resumeAt: Double? = nil, from origin: PlayOrigin) async throws -> Bool {
        guard starting == nil else { return false }
        generation += 1
        let mine = generation
        var info = asked
        starting = info
        defer {
            if generation == mine {
                starting = nil
            }
        }
        let present: Bool
        switch origin {
        case .phone: present = true
        case .car: present = false
        case .controls: present = isScreenShown
        }
        Diagnostics.shared.log("play from the \(origin): \(info.title.title)\(info.isEpisode ? " " + info.subtitleLine : "")")
        do {
            // "Up next" knows the episode after this one, so the next play can offer it again.
            if info.isEpisode, info.next == nil, let details = try? await KinoCore.shared.details(id: info.playId) {
                info.next = nextEpisode(after: info.season, info.episode, in: details.seasons)
            }
            let (index, label) = try await stream(for: info, choice)
            let request = PlayRequest(id: info.playId, season: info.season, episode: info.episode, stream: index, subtitles: Preferences.subtitles)
            let play = try await KinoCore.shared.play(request)
            guard generation == mine else {
                Diagnostics.shared.log("play dropped (cancelled), stop session \(play.session)")
                Task.detached { try? await KinoCore.shared.stop(session: play.session) }
                return false
            }
            library?.record(WatchEntry(
                title: info.title, playId: info.playId, dubLabel: info.dubLabel, season: info.season, episode: info.episode,
                episodeTitle: info.episodeTitle, stream: index, streamLabel: label, position: resumeAt ?? 0,
                duration: library?.entry(for: info.title.id).flatMap { $0.season == info.season && $0.episode == info.episode ? $0.duration : nil },
                updated: Date(), next: info.next
            ))
            start(Playing(request: request, play: play), info: info, startAt: resumeAt, present: present)
            return true
        } catch {
            guard generation == mine else { return false }
            throw error
        }
    }

    /// The stream's index (and label) for the choice; a quality choice lists the streams first.
    private func stream(for info: PlayInfo, _ choice: StreamChoice) async throws -> (Int, String?) {
        switch choice {
        case .stream(let stream):
            return (stream.index, stream.label)
        case .index(let index, let label):
            return (index, label)
        case .quality(let quality):
            let streams = try await KinoCore.shared.streams(id: info.playId, season: info.season, episode: info.episode)
            guard let stream = quality.pick(from: streams) else { throw KinoError.core(L.noStreams) }
            return (stream.index, stream.label)
        }
    }

    /// Plays a history entry on: where it stopped, or "Up next" once it was watched. The car (and
    /// a stream gone from the list) takes a stream by quality.
    @discardableResult
    func resume(_ entry: WatchEntry, from origin: PlayOrigin) async throws -> Bool {
        var info = PlayInfo(entry: entry)
        var startAt: Double? = entry.position >= 5 ? max(0, entry.position - 5) : nil
        var choice = StreamChoice.index(entry.stream, label: entry.streamLabel)
        if entry.isFinished {
            startAt = nil
            if let next = entry.next {
                info.season = next.season
                info.episode = next.episode
                info.episodeTitle = next.title
                info.next = nil
                choice = .quality(Preferences.quality)
            }
        }
        if origin == .car {
            choice = .quality(.light)
        }
        do {
            return try await play(info, choice, resumeAt: startAt, from: origin)
        } catch {
            // The stream list can change between days: the same quality choice once more.
            guard case .index = choice else { throw error }
            Diagnostics.shared.log("resume: stream \(entry.stream) didn't play, picking by quality")
            return try await play(info, .quality(Preferences.quality), resumeAt: startAt, from: origin)
        }
    }

    /// The episode after the one playing (the lock screen's and the car's "next").
    func playNextEpisode(from origin: PlayOrigin) async throws {
        guard let current = info, let next = current.next else { return }
        var info = current
        info.season = next.season
        info.episode = next.episode
        info.episodeTitle = next.title
        info.next = nil
        try await play(info, .quality(carConnected ? .light : Preferences.quality), from: origin)
    }

    /// Cancel on the "Starting…" card: whatever the core answers is dropped.
    func cancelStarting() {
        guard starting != nil else { return }
        generation += 1
        starting = nil
        Diagnostics.shared.log("play: cancelled while starting")
    }

    /// Starts `playing` (the core's answer); on the phone's full screen when `present`. Any other
    /// play ends first.
    @discardableResult
    func start(_ playing: Playing, info: PlayInfo?, startAt: Double?, present: Bool) -> PlayerScreen? {
        end()
        let model = PlayerModel(playing: playing, startAt: startAt ?? Self.testStartAt)
        let shown = info ?? PlayInfo(
            title: Title(id: playing.request.id, title: playing.play.title, year: nil, kind: "movie", poster: nil, rating: nil),
            playId: playing.request.id
        )
        model.subtitleLine = shown.isEpisode ? shown.subtitleLine : nil
        self.model = model
        self.info = shown
        applyBackgroundPolicy()
        observe(model)
        model.start()
        loadArtwork(for: model, poster: shown.title.poster)
        update()
        return present ? showPlayer() : nil
    }

    // MARK: The phone's player

    /// The full-screen player for what plays (Play, the mini player).
    @discardableResult
    func showPlayer() -> PlayerScreen? {
        guard let model else { return nil }
        if let screen, !screen.isFinished {
            return screen
        }
        guard let shown = PlayerScreen.show(model, onClosed: { [weak self] closed in self?.screenClosed(closed) }) else {
            return nil
        }
        screen = shown
        isScreenShown = true
        applyBackgroundPolicy()
        return shown
    }

    private func screenClosed(_ closed: PlayerScreen) {
        guard closed === screen else { return }
        screen = nil
        isScreenShown = false
        applyBackgroundPolicy()
        if carConnected, let model, !model.isClosed {
            Diagnostics.shared.log("player closed on the phone; the car keeps the play")
            update()
            return
        }
        end()
    }

    // MARK: Controls

    func togglePlayPause() {
        model?.togglePlayPause()
    }

    func pause() {
        model?.pause()
    }

    func resumePlayback() {
        model?.resume()
    }

    func skip(by seconds: Double) {
        model?.skip(by: seconds) { [weak self] in self?.update() }
    }

    func seek(to seconds: Double) {
        model?.seek(to: seconds) { [weak self] in self?.update() }
    }

    /// Ends the play: where it got to goes to the history, the player closes, the session stops.
    func stop() {
        end()
    }

    private func end() {
        guard let model else { return }
        saveProgress()
        library?.saveNow()
        subscriptions.removeAll()
        let shown = screen
        screen = nil
        isScreenShown = false
        shown?.dismissQuietly()
        model.close()
        self.model = nil
        info = nil
        isPlaying = false
        artwork = nil
        update()
    }

    // MARK: Keeping up

    private func observe(_ model: PlayerModel) {
        model.$isPlaying
            .removeDuplicates()
            .sink { [weak self] playing in
                self?.isPlaying = playing
                self?.update()
            }
            .store(in: &subscriptions)
        // Scrubbing in the player, a seek from the car.
        NotificationCenter.default.publisher(for: AVPlayerItem.timeJumpedNotification)
            .filter { [weak model] note in (note.object as AnyObject?) === model?.player.currentItem }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.update() }
            .store(in: &subscriptions)
        Timer.publish(every: 5, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                self?.saveProgress()
                self?.update()
            }
            .store(in: &subscriptions)
    }

    private func saveProgress() {
        guard let model, let info, !model.isClosed, model.lastTime > 0 else { return }
        library?.updateProgress(titleId: info.title.id, position: model.lastTime, duration: model.duration)
    }

    /// Now Playing and the remote commands, as things stand.
    private func update() {
        RemoteCommands.update(playing: model != nil, next: info?.next != nil)
        guard let model, let info else {
            NowPlaying.clear()
            return
        }
        NowPlaying.show(info, player: model.player, duration: model.duration, artwork: artwork)
    }

    private func loadArtwork(for model: PlayerModel, poster: String?) {
        guard let poster else { return }
        Task { @MainActor [weak self, weak model] in
            guard let image = await ImageCache.shared.image(poster, maxPixels: 600) else { return }
            guard let self, let model, self.model === model else { return }
            self.artwork = image
            if let data = image.jpegData(compressionQuality: 0.85) {
                model.setArtwork(data)
            }
            self.update()
        }
    }

    /// The sound goes on in the background when the car plays it or no picture is on the phone
    /// (a play from the car, the mini player); with the full-screen player and no car, the system's
    /// usual rule (video pauses in the background unless in picture in picture).
    private func applyBackgroundPolicy() {
        model?.player.audiovisualBackgroundPlaybackPolicy = carConnected || !isScreenShown ? .continuesIfPossible : .automatic
    }
}
