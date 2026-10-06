// End to end in the iOS Simulator, with whichever core the app was built with (stub or engine):
// search, open the first title, list its streams, play the first one. AVPlayer must really play it:
// ready to play, then its clock advances at least 5 seconds. Leaves a frame of the video and a
// summary as attachments (CI exports them from the .xcresult).

import AVFoundation
import AVKit
import VideoToolbox
import XCTest
@testable import Kinoteatri

final class PlaybackTests: XCTestCase {
    private let core = KinoCore.shared
    private var notes: [String] = []

    override func setUp() async throws {
        // One core per process: the first start wins, so the tests start it before anyone else.
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("kino-tests", isDirectory: true)
        try await core.start(dataDir: folder)
    }

    @MainActor
    func testSearchOpenAndPlay() async throws {
        defer { attachNotes() }
        note("data folder: \(core.startedDataDir?.path ?? "?")")

        let version = try await core.version()
        note("core \(version.core), engine \(version.engine), mode \(version.mode)")

        let query = version.mode == "engine" ? "The Lord of the Rings" : "bip bop"
        let results = try await core.search(query)
        note("search \"\(query)\": \(results.count) titles: \(results.prefix(5).map { "\($0.title) (\($0.kind), \($0.id))" })")
        let first = try XCTUnwrap(results.first, "Nothing found for \(query)")

        let details = try await core.details(id: first.id)
        XCTAssertFalse(details.title.isEmpty)
        var season = 0
        var episode = 0
        if details.isSeries {
            let firstSeason = try XCTUnwrap(details.seasons.first, "A series without seasons")
            season = firstSeason.season
            episode = try XCTUnwrap(firstSeason.episodes.first, "Season \(season) has no episodes").episode
        }
        note("details: \(details.title), \(details.kind), \(details.seasons.count) seasons, \(details.audio.count) other dubs")

        let streams = try await core.streams(id: details.id, season: season, episode: episode)
        note("streams (S\(season) E\(episode)): \(streams.map(\.label))")
        let stream = try XCTUnwrap(streams.first, "No streams")

        let play = try await core.play(id: details.id, season: season, episode: episode, stream: stream.index)
        note("play: \(play.kind) \(play.url), session \(play.session)")
        let url = try XCTUnwrap(URL(string: play.url), "Bad URL \(play.url)")

        let item = AVPlayerItem(url: url)
        let frames = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)])
        item.add(frames)
        let player = AVPlayer(playerItem: item)
        // On screen as in the app (the CI recording shows it).
        let shown = present(player)

        let outcome = await watch(player, item)
        note(outcome.summary)
        if let frame = await grabFrame(frames) {
            let attachment = XCTAttachment(image: frame)
            attachment.name = "video-frame"
            attachment.lifetime = .keepAlways
            add(attachment)
            note("video frame: \(Int(frame.size.width))x\(Int(frame.size.height))")
        } else {
            note("no video frame captured")
        }

        player.pause()
        shown?.dismiss(animated: false)
        try await core.stop(session: play.session)
        note("stopped \(play.session)")

        if let failure = outcome.failure {
            XCTFail(failure)
        }
        XCTAssertGreaterThanOrEqual(outcome.advanced, 5, "The video didn't advance 5 s: \(outcome.summary)")
    }

    // MARK: Playing

    private struct Outcome {
        var readyAfter: TimeInterval?
        var advanced: Double = 0
        var failure: String?
        var summary = ""
    }

    /// Waits until the item is ready to play (90 s at most), plays, and waits until the clock has
    /// advanced 5 s (90 s at most).
    @MainActor
    private func watch(_ player: AVPlayer, _ item: AVPlayerItem) async -> Outcome {
        var outcome = Outcome()
        let began = Date()
        while item.status != .readyToPlay {
            if item.status == .failed || Date().timeIntervalSince(began) > 90 {
                outcome.failure = "Not ready to play after \(Int(Date().timeIntervalSince(began))) s: \(describe(item, player))"
                outcome.summary = outcome.failure ?? ""
                return outcome
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        outcome.readyAfter = Date().timeIntervalSince(began)

        player.play()
        let start = player.currentTime().seconds
        let playing = Date()
        while outcome.advanced < 5 {
            if item.status == .failed || Date().timeIntervalSince(playing) > 90 {
                outcome.failure = "Played \(String(format: "%.1f", outcome.advanced)) s in \(Int(Date().timeIntervalSince(playing))) s: \(describe(item, player))"
                break
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
            outcome.advanced = player.currentTime().seconds - start
        }
        outcome.summary = String(
            format: "ready after %.1f s; advanced %.1f s in %.1f s; %@",
            outcome.readyAfter ?? -1, outcome.advanced, Date().timeIntervalSince(playing), describe(item, player)
        )
        return outcome
    }

    private func describe(_ item: AVPlayerItem, _ player: AVPlayer) -> String {
        let state: String
        switch player.timeControlStatus {
        case .paused: state = "paused"
        case .waitingToPlayAtSpecifiedRate: state = "waiting"
        case .playing: state = "playing"
        @unknown default: state = "?"
        }
        var parts = [
            "item status \(item.status.rawValue)",
            "player \(state)",
            "size \(Int(item.presentationSize.width))x\(Int(item.presentationSize.height))",
        ]
        if let reason = player.reasonForWaitingToPlay { parts.append("waiting: \(reason.rawValue)") }
        if let error = item.error { parts.append("error: \(error)") }
        if let events = item.errorLog()?.events, !events.isEmpty {
            parts.append("error log: \(events.suffix(3).map { "\($0.errorStatusCode) \($0.errorComment ?? "") \($0.uri ?? "")" })")
        }
        if let event = item.accessLog()?.events.last {
            parts.append("bitrate \(Int(event.indicatedBitrate)), stalls \(event.numberOfStalls)")
        }
        return parts.joined(separator: "; ")
    }

    /// The player full screen in the host app's window, as the app shows it.
    @MainActor
    private func present(_ player: AVPlayer) -> AVPlayerViewController? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let root = (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController else {
            note("no window to show the player in")
            return nil
        }
        let controller = AVPlayerViewController()
        controller.player = player
        controller.modalPresentationStyle = .fullScreen
        root.present(controller, animated: false)
        return controller
    }

    /// The frame on screen now, decoded by the player. (VideoToolbox, not Core Image: a CIContext
    /// takes ~25 s to set up on CI's virtual Macs.)
    @MainActor
    private func grabFrame(_ output: AVPlayerItemVideoOutput) async -> UIImage? {
        for _ in 0..<20 {
            let time = output.itemTime(forHostTime: CACurrentMediaTime())
            if let buffer = output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil) {
                var image: CGImage?
                VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &image)
                if let image {
                    return UIImage(cgImage: image)
                }
            }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        return nil
    }

    // MARK: Notes

    private func note(_ text: String) {
        print("[kino] \(text)")
        notes.append(text)
    }

    private func attachNotes() {
        let attachment = XCTAttachment(string: notes.joined(separator: "\n"))
        attachment.name = "summary"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
