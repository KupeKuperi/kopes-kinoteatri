// Kope's Kinoteatri for iPhone, step 1: a plain test app over the core (search, a title, its
// streams, the player). Step 2 replaces this UI. Plan: ios/GUIDE.md.

import AVFoundation
import SwiftUI

@main
struct KinoteatriApp: App {
    /// True while the app only hosts the unit tests: they start the core themselves (in a temporary
    /// folder), so the app stays out of the way.
    static let isHostingTests: Bool = {
        let env = ProcessInfo.processInfo.environment
        return env["XCTestConfigurationFilePath"] != nil || env["XCTestBundlePath"] != nil || env["XCTestSessionIdentifier"] != nil
    }()

    init() {
        // Films keep playing with the ringer switch on silent, in the background and in picture in
        // picture.
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        } catch {
            print("Audio session: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if Self.isHostingTests {
                    Color.black.ignoresSafeArea()
                } else {
                    SearchView()
                }
            }
            .preferredColorScheme(.dark)
        }
    }
}

extension View {
    /// Shows `message` (when set) in an alert; OK clears it.
    func errorAlert(_ message: Binding<String?>, title: String = "Something went wrong") -> some View {
        alert(
            title,
            isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } }),
            actions: { Button("OK", role: .cancel) {} },
            message: { Text(message.wrappedValue ?? "") }
        )
    }
}

/// The text to show for an error from the core or the player.
func describe(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
}
