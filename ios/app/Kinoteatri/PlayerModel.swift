// What plays: the core's local URL in an AVPlayer. The title goes in the item's metadata (Apple's
// player shows it). English subtitles are selected by themselves when the app asked the core for
// them. "Try again" after a failure (MovieBox's CDN cookie can expire during a long film) asks the
// core for the stream afresh and resumes where it stopped. Closing stops the core's session. The
// player's status goes to the diagnostics log. On screen: PlayerScreen.swift.

import AVFoundation

/// A play on screen: the core's answer, and what was asked (for "Try again").
struct Playing: Identifiable {
    let request: PlayRequest
    let play: Play

    var id: String { play.session }
}

/// The player's state. Used on the main thread only.
final class PlayerModel: ObservableObject {
    let request: PlayRequest
    let player = AVPlayer()
    @Published private(set) var title: String
    /// Why playback stopped, shown with "Try again"; nil while all is well.
    @Published private(set) var failure: String?
    @Published private(set) var retrying = false
    /// The subtitle languages the stream offers ("en"), once the player has read them.
    @Published private(set) var subtitleOptions: [String] = []
    /// Where playback had got to (seconds), for "Try again".
    private(set) var lastTime: Double = 0
    /// Whether a subtitle line is on screen now.
    private(set) var cueShowing = false
    private(set) var isClosed = false

    private var play: Play
    /// Where to seek once the stream is ready (after "Try again", or a start time).
    private var pendingSeek: Double?
    /// Show English subtitles when the stream has them: the app asked the core for them, and the
    /// person hasn't turned them off in the player's menu since.
    private var wantsSubtitles: Bool
    private var legibleGroup: AVMediaSelectionGroup?
    private let cues = CueWatcher()
    private var itemStatus: NSKeyValueObservation?
    private var playerStatus: NSKeyValueObservation?
    private var itemObservers: [NSObjectProtocol] = []
    private var timeObserver: Any?
    private var started = false
    private var lastError = ""
    private var errorRepeats = 0
    private var cueLogged = false

    /// `startAt`: where to start, in seconds (nil: the beginning).
    init(playing: Playing, startAt: Double? = nil) {
        request = playing.request
        play = playing.play
        title = playing.play.title
        wantsSubtitles = playing.request.subtitles != nil
        if let startAt, startAt > 0 {
            pendingSeek = startAt
        }
        cues.onChange = { [weak self] showing in
            self?.cueChanged(showing)
        }
    }

    /// The core's session of the play.
    var session: String { play.session }

    /// The subtitles on screen ("en"); nil while they're off.
    var shownSubtitleLanguage: String? {
        guard let item = player.currentItem, let group = legibleGroup,
              let option = item.currentMediaSelection.selectedMediaOption(in: group)
        else { return nil }
        return Self.languageTag(option)
    }

    func start() {
        guard !started, !isClosed else { return }
        started = true
        try? AVAudioSession.sharedInstance().setActive(true)
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main) { [weak self] time in
            guard let self, self.pendingSeek == nil, time.isNumeric, time.seconds > 0 else { return }
            self.lastTime = time.seconds
        }
        playerStatus = player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            DispatchQueue.main.async { self?.timeControlChanged(player) }
        }
        load(play)
    }

    /// Plays `play`: from the start, or from `pendingSeek` once the stream is ready.
    private func load(_ play: Play) {
        removeItemObservers()
        guard let url = URL(string: play.url) else {
            fail(message: "Bad stream address.")
            return
        }
        let item = AVPlayerItem(url: url)
        item.externalMetadata = Self.metadata(title: play.title)
        // Tells when a subtitle line shows (diagnostics, the UI tests); the player still draws them.
        let legible = AVPlayerItemLegibleOutput(mediaSubtypesForNativeRepresentation: [])
        legible.setDelegate(cues, queue: .main)
        item.add(legible)
        legibleGroup = nil
        subtitleOptions = []
        cueShowing = false
        itemStatus = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async { self?.statusChanged(item) }
        }
        let center = NotificationCenter.default
        itemObservers = [
            // Failures in the middle of playback often show only here, not in the item's status.
            center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] note in
                let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
                Diagnostics.shared.log("player: failed to play to the end: \(PlayerModel.brief(error))")
                self?.fail(error)
            },
            center.addObserver(forName: .AVPlayerItemNewErrorLogEntry, object: item, queue: .main) { [weak self] _ in
                self?.errorLogged(item)
            },
            center.addObserver(forName: .AVPlayerItemNewAccessLogEntry, object: item, queue: .main) { [weak self] _ in
                self?.accessLogged(item)
            },
            center.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) { _ in
                Diagnostics.shared.log("player: stalled")
            },
        ]
        Diagnostics.shared.log("player: loading session \(play.session)")
        player.replaceCurrentItem(with: item)
        if pendingSeek == nil {
            player.play()
        }
    }

    private func statusChanged(_ item: AVPlayerItem) {
        guard item === player.currentItem, !isClosed else { return }
        switch item.status {
        case .failed:
            Diagnostics.shared.log("player: item failed: \(Self.brief(item.error))")
            fail(item.error)
        case .readyToPlay:
            Diagnostics.shared.log("player: ready to play")
            pickSubtitles(item)
            guard let seconds = pendingSeek else { return }
            let time = CMTime(seconds: seconds, preferredTimescale: 600)
            player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self, !self.isClosed else { return }
                    self.pendingSeek = nil
                    self.player.play()
                }
            }
        default:
            break
        }
    }

    /// Reads the stream's subtitle languages; when English is wanted, selects it, so it shows
    /// without the player's menu (where the person can still turn it off).
    private func pickSubtitles(_ item: AVPlayerItem) {
        Task { @MainActor [weak self] in
            let group = try? await item.asset.loadMediaSelectionGroup(for: .legible)
            guard let self, item === self.player.currentItem, !self.isClosed else { return }
            guard let group, !group.options.isEmpty else {
                if self.request.subtitles != nil {
                    Diagnostics.shared.log("subtitles: the stream has none")
                }
                return
            }
            self.legibleGroup = group
            self.subtitleOptions = group.options.map(PlayerModel.languageTag)
            Diagnostics.shared.log("subtitles offered: \(self.subtitleOptions.joined(separator: ", "))")
            guard self.wantsSubtitles else { return }
            guard let english = group.options.first(where: { PlayerModel.languageTag($0) == "en" }) else {
                Diagnostics.shared.log("subtitles: no English among them")
                return
            }
            item.select(english, in: group)
            Diagnostics.shared.log("subtitles: English selected")
        }
    }

    private func timeControlChanged(_ player: AVPlayer) {
        guard !isClosed else { return }
        switch player.timeControlStatus {
        case .playing:
            Diagnostics.shared.log("player: playing")
        case .paused:
            Diagnostics.shared.log("player: paused")
        case .waitingToPlayAtSpecifiedRate:
            Diagnostics.shared.log("player: waiting (\(player.reasonForWaitingToPlay?.rawValue ?? "?"))")
        @unknown default:
            break
        }
    }

    /// The newest error log entry, in short; an error that keeps coming (-12318 can come with every
    /// segment) only every 20th time.
    private func errorLogged(_ item: AVPlayerItem) {
        guard let event = item.errorLog()?.events.last else { return }
        let key = "\(event.errorDomain) \(event.errorStatusCode)"
        if key == lastError {
            errorRepeats += 1
            guard errorRepeats % 20 == 0 else { return }
        } else {
            lastError = key
            errorRepeats = 0
        }
        let times = errorRepeats > 0 ? " (\(errorRepeats + 1) times)" : ""
        let path = event.uri.flatMap { URL(string: $0)?.path } ?? ""
        Diagnostics.shared.log("error log: \(key) \(event.errorComment ?? "")\(times) \(path)")
    }

    private func accessLogged(_ item: AVPlayerItem) {
        guard let event = item.accessLog()?.events.last else { return }
        Diagnostics.shared.log(
            "access log: indicated \(Self.kilobits(event.indicatedBitrate)), observed \(Self.kilobits(event.observedBitrate)), "
                + "stalls \(event.numberOfStalls), dropped frames \(event.numberOfDroppedVideoFrames)"
        )
    }

    private func cueChanged(_ showing: Bool) {
        cueShowing = showing
        if showing, !cueLogged {
            cueLogged = true
            Diagnostics.shared.log(String(format: "subtitles: first line on screen at %.1f s", player.currentTime().seconds))
        }
    }

    func fail(_ error: Error?) {
        fail(message: error.map(describe) ?? "The stream stopped.")
    }

    private func fail(message: String) {
        guard !isClosed, !retrying, failure == nil else { return }
        player.pause()
        failure = message
    }

    /// "Try again": the core resolves the stream afresh (a new CDN cookie), the old session ends
    /// and playback resumes where it stopped. Once per tap, never on its own.
    func retry() {
        guard !retrying, !isClosed else { return }
        if request.subtitles != nil, legibleGroup != nil {
            // Subtitles turned off in the player's menu stay off.
            wantsSubtitles = shownSubtitleLanguage != nil
        }
        retrying = true
        failure = nil
        let old = play
        let resume = lastTime
        Diagnostics.shared.log("try again: session \(old.session), at \(Int(resume)) s")
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let fresh = try await KinoCore.shared.play(self.request)
                self.retrying = false
                if fresh.session != old.session {
                    PlayerModel.stop(old.session)
                }
                if self.isClosed {
                    PlayerModel.stop(fresh.session)
                    return
                }
                self.play = fresh
                self.title = fresh.title
                self.pendingSeek = resume > 0 ? resume : nil
                self.load(fresh)
            } catch {
                self.retrying = false
                self.fail(message: describe(error))
            }
        }
    }

    /// Stops playing and tells the core the session is over (once).
    func close() {
        guard !isClosed else { return }
        isClosed = true
        itemStatus = nil
        playerStatus = nil
        removeItemObservers()
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }
        player.pause()
        player.replaceCurrentItem(with: nil)
        Diagnostics.shared.log("player: closed, stop session \(play.session)")
        Self.stop(play.session)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func removeItemObservers() {
        for observer in itemObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        itemObservers = []
    }

    private static func stop(_ session: String) {
        Task.detached {
            try? await KinoCore.shared.stop(session: session)
        }
    }

    // MARK: Helpers

    /// The title Apple's player shows (and Now Playing, and picture in picture).
    private static func metadata(title: String) -> [AVMetadataItem] {
        let item = AVMutableMetadataItem()
        item.identifier = .commonIdentifierTitle
        item.value = title as NSString
        item.extendedLanguageTag = "und"
        return [item]
    }

    /// A subtitle option's language as a short tag: "en" for English.
    static func languageTag(_ option: AVMediaSelectionOption) -> String {
        let tag = option.extendedLanguageTag ?? option.locale?.identifier ?? option.displayName
        let primary = tag.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? tag
        return primary.lowercased()
    }

    /// "CoreMediaErrorDomain -12660 The operation couldn't be completed. ← NSURLErrorDomain -1004"
    static func brief(_ error: Error?) -> String {
        guard let error else { return "no error" }
        let ns = error as NSError
        var text = "\(ns.domain) \(ns.code) \(ns.localizedDescription)"
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            text += " ← \(underlying.domain) \(underlying.code)"
        }
        return text
    }

    private static func kilobits(_ bitsPerSecond: Double) -> String {
        bitsPerSecond.isFinite && bitsPerSecond >= 0 ? "\(Int(bitsPerSecond / 1000)) kb/s" : "?"
    }
}

/// Tells whether the player shows a subtitle line now (the item's legible output reports each
/// change).
final class CueWatcher: NSObject, AVPlayerItemLegibleOutputPushDelegate {
    var onChange: ((Bool) -> Void)?

    func legibleOutput(
        _ output: AVPlayerItemLegibleOutput,
        didOutputAttributedStrings strings: [NSAttributedString],
        nativeSampleBuffers nativeSamples: [Any],
        forItemTime itemTime: CMTime
    ) {
        let text = strings.map(\.string).joined().trimmingCharacters(in: .whitespacesAndNewlines)
        onChange?(!text.isEmpty)
    }
}
