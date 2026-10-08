// Now Playing: what the lock screen, Control Center, AirPlay and CarPlay's Now Playing screen show
// about the play (title, episode, poster, time), and the buttons they have (play/pause, 15 seconds
// back and forward, scrubbing, next episode). They all act on PlaybackCenter.

import AVFoundation
import MediaPlayer
import UIKit

enum NowPlaying {
    /// The skip buttons' step, seconds.
    static let skipInterval: Double = 15

    /// The info for `info` playing in `player`.
    static func info(for info: PlayInfo, elapsed: Double, rate: Float, duration: Double?) -> [String: Any] {
        // A Double either way (in an `Any` dictionary a bare 0 would be an Int).
        let position: Double = elapsed.isFinite ? max(0, elapsed) : 0
        var now: [String: Any] = [
            MPMediaItemPropertyTitle: info.title.title,
            MPMediaItemPropertyArtist: info.subtitleLine,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: Double(rate),
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        ]
        if let duration, duration.isFinite, duration > 0 {
            now[MPMediaItemPropertyPlaybackDuration] = duration
        }
        return now
    }

    @MainActor
    static func show(_ info: PlayInfo, player: AVPlayer, duration: Double?, artwork: UIImage?) {
        var now = Self.info(for: info, elapsed: player.currentTime().seconds, rate: player.rate, duration: duration)
        if let artwork {
            now[MPMediaItemPropertyArtwork] = Self.artwork(artwork)
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = now
    }

    @MainActor
    static func clear() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// The system asks for the image on a queue of its own: the closure keeps no actor.
    private static func artwork(_ image: UIImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }
}

/// The lock screen's, Control Center's and the car's buttons.
enum RemoteCommands {
    /// Once, at start. The handlers hop to the main actor and answer at once.
    static func install() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { _ in RemoteCommands.run { $0.resumePlayback() } }
        center.pauseCommand.addTarget { _ in RemoteCommands.run { $0.pause() } }
        center.togglePlayPauseCommand.addTarget { _ in RemoteCommands.run { $0.togglePlayPause() } }
        center.skipForwardCommand.preferredIntervals = [NSNumber(value: NowPlaying.skipInterval)]
        center.skipForwardCommand.addTarget { _ in RemoteCommands.run { $0.skip(by: NowPlaying.skipInterval) } }
        center.skipBackwardCommand.preferredIntervals = [NSNumber(value: NowPlaying.skipInterval)]
        center.skipBackwardCommand.addTarget { _ in RemoteCommands.run { $0.skip(by: -NowPlaying.skipInterval) } }
        center.changePlaybackPositionCommand.addTarget { event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let time = event.positionTime
            return RemoteCommands.run { $0.seek(to: time) }
        }
        center.nextTrackCommand.addTarget { _ in
            Task { @MainActor in
                do {
                    try await PlaybackCenter.shared.playNextEpisode(from: .controls)
                } catch {
                    Diagnostics.shared.log("next episode: \(describe(error))")
                }
            }
            return .success
        }
        // Not for films: off, so the system doesn't show them.
        for command in [
            center.previousTrackCommand, center.changePlaybackRateCommand, center.seekForwardCommand,
            center.seekBackwardCommand, center.likeCommand, center.dislikeCommand, center.bookmarkCommand,
            center.changeRepeatModeCommand, center.changeShuffleModeCommand,
        ] as [MPRemoteCommand] {
            command.isEnabled = false
        }
    }

    /// Which buttons work now: the controls while something plays, "next" when there's a next
    /// episode.
    static func update(playing: Bool, next: Bool) {
        let center = MPRemoteCommandCenter.shared()
        for command in [
            center.playCommand, center.pauseCommand, center.togglePlayPauseCommand, center.skipForwardCommand,
            center.skipBackwardCommand, center.changePlaybackPositionCommand,
        ] as [MPRemoteCommand] {
            command.isEnabled = playing
        }
        center.nextTrackCommand.isEnabled = playing && next
    }

    private static func run(_ action: @escaping @MainActor (PlaybackCenter) -> Void) -> MPRemoteCommandHandlerStatus {
        Task { @MainActor in
            action(PlaybackCenter.shared)
        }
        return .success
    }
}
