// The app's own screens, used as a person would: search, open the first title, play its first
// stream (with the engine: the best quality), close the player. Keeps a screenshot of each screen
// (CI exports them from the .xcresult). Works with either core: it reads the mode off the search
// screen.

import XCTest

final class ScreensUITests: XCTestCase {
    private struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    func testSearchOpenPlayClose() throws {
        let version = element("core-version")
        try wait(for: version, 60, "The core didn't start (no version on the search screen)")
        let engine = version.label.hasSuffix("engine")
        shot("1-search")

        let field = app.searchFields.firstMatch
        try wait(for: field, 10, "No search field")
        field.tap()
        field.typeText(engine ? "The Lord of the Rings: The Fellowship of the Ring\n" : "bip bop\n")

        let result = app.cells.firstMatch
        try wait(for: result, 90, "No search results")
        shot("2-results")
        result.tap()

        let stream = element("stream-0")
        try wait(for: stream, 90, "No streams on the title screen")
        shot("3-title")
        stream.tap()

        let close = element("close-player")
        try wait(for: close, 60, "The player didn't open")
        // Let it play a little, look, and again later (a film may open in the dark).
        Thread.sleep(forTimeInterval: 7)
        try checkNoAlert()
        shot("4-player-7s")
        Thread.sleep(forTimeInterval: 8)
        try checkNoAlert()
        shot("5-player-15s")
        close.tap()

        try wait(for: stream, 30, "Didn't come back to the title from the player")
        try checkNoAlert()
        shot("6-closed")
    }

    // MARK: Helpers

    private func element(_ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// Waits for `element`; fails early when the app shows an error alert instead.
    private func wait(for element: XCUIElement, _ seconds: TimeInterval, _ what: String) throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !element.waitForExistence(timeout: 1) {
            try checkNoAlert()
            if Date() > deadline {
                shot("timeout")
                throw Failure(description: "\(what) after \(Int(seconds)) s")
            }
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
}
