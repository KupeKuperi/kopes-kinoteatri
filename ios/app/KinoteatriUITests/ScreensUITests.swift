// The app's own screens, used as a person would. Search, open the first title, play its first
// stream (with the engine: the best quality) full screen; turn the phone to landscape: the player
// fills the window; back to portrait; close with the player's own button: back on the title.
// English subtitles (on by default) show by themselves in Inception. About copies the diagnostics.
// Keeps a screenshot of each screen (CI exports them from the .xcresult). Works with either core:
// it reads the mode off the search screen.

import XCTest

final class ScreensUITests: XCTestCase {
    private struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    private var app: XCUIApplication!
    private var notes: [String] = []
    private var summary = "summary-ui"

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app = XCUIApplication()
        // The player describes itself (frame, orientation, subtitles) to the tests: "player-video".
        app.launchEnvironment["KINO_UI_TEST"] = "1"
    }

    override func tearDownWithError() throws {
        XCUIDevice.shared.orientation = .portrait
        if !notes.isEmpty {
            let attachment = XCTAttachment(string: notes.joined(separator: "\n"))
            attachment.name = summary
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }

    func testSearchOpenPlayFullScreenClose() throws {
        summary = "summary-ui-fullscreen"
        app.launch()
        let engine = try waitForCore()
        shot("1-search")
        try checkAbout()

        try search(engine ? "The Lord of the Rings: The Fellowship of the Ring" : "bip bop")
        shot("2-results")
        app.cells.firstMatch.tap()

        let stream = element("stream-0")
        try wait(for: stream, 90, "No streams on the title screen")
        let toggle = element("english-subtitles")
        let switchValue = toggle.exists ? String(describing: toggle.value ?? "?") : "missing"
        note("English subtitles switch: \(switchValue)")
        shot("3-title")
        stream.tap()

        let video = element("player-video")
        try wait(for: video, 90, "The player didn't open")
        // Let it play a little (a film may open in the dark).
        Thread.sleep(forTimeInterval: 7)
        try checkNoAlert()
        shot("4-player-portrait")
        attachTree("player-tree-portrait")
        try checkFillsWindow(video, landscape: false)

        XCUIDevice.shared.orientation = .landscapeLeft
        try waitUntil(20, "the player in landscape") { facts(video)["orientation"] == "landscape" }
        Thread.sleep(forTimeInterval: 3)
        try checkNoAlert()
        shot("5-player-landscape")
        try checkFillsWindow(video, landscape: true)

        XCUIDevice.shared.orientation = .portrait
        try waitUntil(20, "the player in portrait again") { facts(video)["orientation"] == "portrait" }
        Thread.sleep(forTimeInterval: 1)
        shot("6-player-portrait-again")
        try closePlayer(video)

        try wait(for: stream, 30, "Didn't come back to the title from the player")
        try checkNoAlert()
        shot("7-closed")
    }

    /// English subtitles are on by default and the player shows them by itself: Inception (English
    /// captions in the core's smoke test), started 10 minutes in, where people talk.
    func testEnglishSubtitlesShowByThemselves() throws {
        summary = "summary-ui-subtitles"
        app.launchEnvironment["KINO_UITEST_START_AT"] = "600"
        app.launch()
        let engine = try waitForCore()
        try XCTSkipUnless(engine, "The stub core has no subtitles.")

        try search("Inception")
        shot("8-inception-results")
        app.cells.firstMatch.tap()
        let stream = element("stream-0")
        try wait(for: stream, 90, "No streams for Inception")
        let toggle = element("english-subtitles")
        try wait(for: toggle, 10, "No English subtitles switch on the title screen")
        XCTAssertEqual(toggle.value as? String, "1", "English subtitles should be on by default")
        shot("9-inception-title")
        stream.tap()

        let video = element("player-video")
        try wait(for: video, 120, "The player didn't open")
        try waitUntil(90, "English subtitles selected in the player") { facts(video)["subtitles"] == "en" }
        let options = facts(video)["options"]?.split(separator: ",").map(String.init) ?? []
        XCTAssertTrue(options.contains("en"), "No English subtitle option: \(facts(video))")
        // A line on screen for the screenshot (best effort: not every moment has dialogue).
        let line = (try? waitUntil(60, "a subtitle line on screen") { facts(video)["cue"] == "yes" }) != nil
        note("subtitles: \(facts(video)); a line on screen: \(line)")
        try checkNoAlert()
        shot("10-subtitles")
        try closePlayer(video)
        try wait(for: stream, 30, "Didn't come back to the title from the player")
    }

    // MARK: Steps

    /// Waits for the core's version on the search screen; true with the real engine.
    private func waitForCore() throws -> Bool {
        let version = element("core-version")
        try wait(for: version, 60, "The core didn't start (no version on the search screen)")
        note("core: \(version.label)")
        return version.label.hasSuffix("engine")
    }

    /// About (the search screen's toolbar): Copy diagnostics, then Done.
    private func checkAbout() throws {
        let about = app.buttons.matching(NSPredicate(format: "identifier == 'about' OR label == 'About'")).firstMatch
        try wait(for: about, 10, "No About button on the search screen")
        about.tap()
        let copy = element("copy-diagnostics")
        try wait(for: copy, 10, "No Copy diagnostics in About")
        copy.tap()
        try waitUntil(5, "\"Copied\"") { copy.label.contains("Copied") }
        shot("1b-about")
        element("about-done").tap()
        try waitUntil(10, "About closed") { !copy.exists }
    }

    private func search(_ text: String) throws {
        let field = app.searchFields.firstMatch
        try wait(for: field, 10, "No search field")
        field.tap()
        field.typeText(text + "\n")
        try wait(for: app.cells.firstMatch, 90, "No search results for \(text)")
    }

    /// The player covers the window, as XCUITest sees it and as the app reports it; in landscape
    /// the window is wider than tall and the video spans its width or height.
    private func checkFillsWindow(_ video: XCUIElement, landscape: Bool) throws {
        let reported = facts(video)
        let window = app.windows.firstMatch.frame
        let frame = video.frame
        note("\(landscape ? "landscape" : "portrait"): window \(window), player \(frame); the app says \(reported)")

        XCTAssertEqual(frame.minX, window.minX, accuracy: 1, "The player doesn't start at the window's left")
        XCTAssertEqual(frame.minY, window.minY, accuracy: 1, "The player doesn't start at the window's top")
        XCTAssertEqual(frame.width, window.width, accuracy: 1, "The player isn't as wide as the window")
        XCTAssertEqual(frame.height, window.height, accuracy: 1, "The player isn't as tall as the window")

        let player = try XCTUnwrap(rect(reported["player"]), "No player frame in \(reported)")
        let screen = try XCTUnwrap(size(reported["window"]), "No window size in \(reported)")
        XCTAssertEqual(player.minX, 0, accuracy: 1)
        XCTAssertEqual(player.minY, 0, accuracy: 1)
        XCTAssertEqual(player.width, screen.width, accuracy: 1, "The player isn't as wide as the window: \(reported)")
        XCTAssertEqual(player.height, screen.height, accuracy: 1, "The player isn't as tall as the window: \(reported)")
        XCTAssertEqual(reported["orientation"], landscape ? "landscape" : "portrait")
        if landscape {
            XCTAssertGreaterThan(screen.width, screen.height, "The window isn't landscape: \(reported)")
        }
        if let shown = rect(reported["video"]), shown.width > 0, shown.height > 0 {
            let fill = max(shown.width / screen.width, shown.height / screen.height)
            XCTAssertGreaterThan(fill, 0.85, "The video is small in the player: \(reported)")
        } else {
            note("video bounds not known yet: \(reported["video"] ?? "-")")
        }
    }

    /// Closes the player with its own close button. It shows with the player's controls, which
    /// hide while a film plays: a tap on the picture (off the middle, where play/pause is) brings
    /// them back.
    private func closePlayer(_ video: XCUIElement) throws {
        for attempt in 0..<6 {
            let close = closeButton()
            if close.exists {
                if close.isHittable {
                    note("closing with the player's button \"\(close.label)\" (\(close.identifier)); buttons: \(buttonNames())")
                    close.tap()
                    return
                }
                if attempt >= 2 {
                    // Seen but not "hittable" (the controls' glass can read so): tap where it is.
                    note("close button \"\(close.label)\" not hittable: tapping its place")
                    close.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                    if gone(video, within: 3) { return }
                }
            }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.42)).tap()
            Thread.sleep(forTimeInterval: 1)
        }
        attachTree("player-tree-no-close")
        throw Failure(description: "No close button on the player; buttons: \(buttonNames())")
    }

    private func closeButton() -> XCUIElement {
        let names = ["Close", "Done", "Dismiss"]
        let predicate = NSPredicate(
            format: "label IN[c] %@ OR identifier IN[c] %@ OR label BEGINSWITH[c] 'close' OR label BEGINSWITH[c] 'dismiss'",
            names, names
        )
        return app.buttons.matching(predicate).firstMatch
    }

    private func buttonNames() -> [String] {
        app.buttons.allElementsBoundByIndex.map { "\($0.label) [\($0.identifier)]" }
    }

    private func gone(_ element: XCUIElement, within seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while element.exists {
            if Date() > deadline { return false }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return true
    }

    // MARK: Helpers

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// The player's own description (KINO_UI_TEST): "player=0,0,402x874; window=402x874; …".
    private func facts(_ video: XCUIElement) -> [String: String] {
        guard video.exists, let value = video.value as? String else { return [:] }
        var facts: [String: String] = [:]
        for part in value.components(separatedBy: "; ") {
            let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
            if pair.count == 2 {
                facts[pair[0]] = pair[1]
            }
        }
        return facts
    }

    /// "402x874"
    private func size(_ text: String?) -> CGSize? {
        guard let parts = text?.split(separator: "x"), parts.count == 2,
              let width = Double(parts[0]), let height = Double(parts[1])
        else { return nil }
        return CGSize(width: width, height: height)
    }

    /// "0,0,402x874"
    private func rect(_ text: String?) -> CGRect? {
        guard let parts = text?.split(separator: ","), parts.count == 3,
              let x = Double(parts[0]), let y = Double(parts[1]), let extent = size(String(parts[2]))
        else { return nil }
        return CGRect(origin: CGPoint(x: x, y: y), size: extent)
    }

    /// Waits for `element`; fails early when the app shows an error alert instead.
    private func wait(for element: XCUIElement, _ seconds: TimeInterval, _ what: String) throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !element.waitForExistence(timeout: 1) {
            try checkNoAlert()
            if Date() > deadline {
                shot("timeout")
                attachTree("tree-timeout")
                throw Failure(description: "\(what) after \(Int(seconds)) s")
            }
        }
    }

    /// Polls `condition` every 0.5 s for at most `seconds`; fails early on an alert.
    private func waitUntil(_ seconds: TimeInterval, _ what: String, _ condition: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            try checkNoAlert()
            if Date() > deadline {
                shot("timeout")
                attachTree("tree-timeout")
                throw Failure(description: "Waited \(Int(seconds)) s for \(what)")
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    /// The app shows its errors as alerts, the player's as "Playback stopped" with "Try again".
    private func checkNoAlert() throws {
        let alert = app.alerts.firstMatch
        if alert.exists {
            shot("alert")
            let text = alert.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " / ")
            throw Failure(description: "The app shows an alert: \(text)")
        }
        if element("try-again").exists {
            shot("playback-stopped")
            let text = app.staticTexts.allElementsBoundByIndex.map(\.label).joined(separator: " / ")
            throw Failure(description: "The player stopped: \(text)")
        }
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// The app's element tree (what XCUITest sees), to find the player's controls by.
    private func attachTree(_ name: String) {
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func note(_ text: String) {
        print("[kino] \(text)")
        notes.append(text)
    }
}
