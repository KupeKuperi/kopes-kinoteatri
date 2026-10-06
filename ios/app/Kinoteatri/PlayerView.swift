// The player: full screen, Apple's own (AVPlayerViewController), playing the core's local URL.
// Picture in picture is allowed. Closing it tells the core to stop the session.

import AVKit
import SwiftUI

struct PlayerView: View {
    let play: Play

    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: PlayerModel

    init(play: Play) {
        self.play = play
        _model = StateObject(wrappedValue: PlayerModel(play: play))
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
                Text(play.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
            }
            .foregroundStyle(.white)
            .padding(.horizontal)
            .padding(.vertical, 8)

            if let player = model.player {
                PlayerController(player: player)
                    .ignoresSafeArea(edges: .bottom)
            } else {
                Spacer()
            }
        }
        .background(Color.black.ignoresSafeArea())
        .onAppear { model.start() }
        .onDisappear { model.close() }
        .errorAlert($model.error, title: "Can't play this")
    }
}

final class PlayerModel: ObservableObject {
    let play: Play
    let player: AVPlayer?
    @Published var error: String?

    private var status: NSKeyValueObservation?
    private var closed = false

    init(play: Play) {
        self.play = play
        if let url = URL(string: play.url) {
            player = AVPlayer(url: url)
        } else {
            player = nil
            error = "Bad stream address: \(play.url)"
        }
    }

    func start() {
        guard let player, !closed else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        status = player.currentItem?.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .failed else { return }
            let message = item.error.map(describe) ?? "The stream failed."
            DispatchQueue.main.async { self?.error = message }
        }
        player.play()
    }

    /// Stops playing and tells the core the session is over (once).
    func close() {
        guard !closed else { return }
        closed = true
        status = nil
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        let session = play.session
        Task.detached {
            try? await KinoCore.shared.stop(session: session)
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
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
