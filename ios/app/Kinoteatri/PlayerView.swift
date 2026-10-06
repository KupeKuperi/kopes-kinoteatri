// The player: full screen, Apple's own (AVPlayerViewController), playing the core's local URL.
// Picture in picture is allowed. If the stream fails (MovieBox's CDN cookie can expire during a
// long film), "Try again" asks the core for the stream afresh and resumes where it stopped. Closing
// the player tells the core to stop the session.

import AVKit
import SwiftUI

/// A play on screen: the core's answer, and what was asked (for "Try again").
struct Playing: Identifiable {
    let request: PlayRequest
    let play: Play

    var id: String { play.session }
}

struct PlayerView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: PlayerModel

    init(playing: Playing) {
        _model = StateObject(wrappedValue: PlayerModel(playing: playing))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.headline)
                        .frame(width: 36, height: 36)
                        .background(Color.white.opacity(0.15), in: Circle())
                }
                .accessibilityLabel("Close")
                .accessibilityIdentifier("close-player")
                Text(model.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
            }
            .foregroundStyle(.white)
            .padding(.horizontal)
            .padding(.vertical, 8)

            ZStack {
                PlayerController(player: model.player)
                    .ignoresSafeArea(edges: .bottom)
                if let failure = model.failure {
                    failed(failure)
                } else if model.retrying {
                    ProgressView("Reconnecting…")
                        .padding(20)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
        }
        .background(Color.black.ignoresSafeArea())
        .onAppear { model.start() }
        .onDisappear { model.close() }
    }

    private func failed(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.largeTitle)
                .foregroundStyle(Color.accentColor)
            Text("Playback stopped")
                .font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                model.retry()
            } label: {
                Label("Try again", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("try-again")
        }
        .padding(24)
        .frame(maxWidth: 360)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding()
    }
}

/// The player's state. Used on the main thread only.
final class PlayerModel: ObservableObject {
    let request: PlayRequest
    let player = AVPlayer()
    @Published private(set) var title: String
    /// Why playback stopped, shown with "Try again"; nil while all is well.
    @Published private(set) var failure: String?
    @Published private(set) var retrying = false
    /// Where playback had got to (seconds), for "Try again".
    private(set) var lastTime: Double = 0

    private var play: Play
    /// Where to seek once the retried stream is ready.
    private var pendingSeek: Double?
    private var itemStatus: NSKeyValueObservation?
    private var itemFailed: NSObjectProtocol?
    private var timeObserver: Any?
    private var started = false
    private var closed = false

    init(playing: Playing) {
        request = playing.request
        play = playing.play
        title = playing.play.title
    }

    func start() {
        guard !started, !closed else { return }
        started = true
        try? AVAudioSession.sharedInstance().setActive(true)
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1, preferredTimescale: 600), queue: .main) { [weak self] time in
            guard let self, self.pendingSeek == nil, time.isNumeric, time.seconds > 0 else { return }
            self.lastTime = time.seconds
        }
        load(play)
    }

    /// Plays `play`: from the start, or from `pendingSeek` once the stream is ready.
    private func load(_ play: Play) {
        if let itemFailed {
            NotificationCenter.default.removeObserver(itemFailed)
        }
        guard let url = URL(string: play.url) else {
            fail(message: "Bad stream address: \(play.url)")
            return
        }
        let item = AVPlayerItem(url: url)
        itemStatus = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async { self?.statusChanged(item) }
        }
        // Failures in the middle of playback often show only here, not in the item's status.
        itemFailed = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] note in
            self?.fail(note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)
        }
        player.replaceCurrentItem(with: item)
        if pendingSeek == nil {
            player.play()
        }
    }

    private func statusChanged(_ item: AVPlayerItem) {
        guard item === player.currentItem, !closed else { return }
        switch item.status {
        case .failed:
            fail(item.error)
        case .readyToPlay:
            guard let seconds = pendingSeek else { return }
            let time = CMTime(seconds: seconds, preferredTimescale: 600)
            player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self, !self.closed else { return }
                    self.pendingSeek = nil
                    self.player.play()
                }
            }
        default:
            break
        }
    }

    func fail(_ error: Error?) {
        fail(message: error.map(describe) ?? "The stream stopped.")
    }

    private func fail(message: String) {
        guard !closed, !retrying, failure == nil else { return }
        player.pause()
        failure = message
    }

    /// "Try again": the core resolves the stream afresh (a new CDN cookie), the old session ends
    /// and playback resumes where it stopped. Once per tap, never on its own.
    func retry() {
        guard !retrying, !closed else { return }
        retrying = true
        failure = nil
        let old = play
        let resume = lastTime
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let fresh = try await KinoCore.shared.play(self.request)
                self.retrying = false
                if fresh.session != old.session {
                    Self.stop(old.session)
                }
                if self.closed {
                    Self.stop(fresh.session)
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
        guard !closed else { return }
        closed = true
        itemStatus = nil
        if let itemFailed {
            NotificationCenter.default.removeObserver(itemFailed)
        }
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }
        player.pause()
        player.replaceCurrentItem(with: nil)
        Self.stop(play.session)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func stop(_ session: String) {
        Task.detached {
            try? await KinoCore.shared.stop(session: session)
        }
    }
}

/// Apple's player view controller in SwiftUI.
struct PlayerController: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.videoGravity = .resizeAspect
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player {
            controller.player = player
        }
    }
}
