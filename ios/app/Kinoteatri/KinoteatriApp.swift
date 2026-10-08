// Kope's Kinoteatri for iPhone, step 2: the app over the core (Home, Search, a title, Library,
// Settings; the full-screen player; CarPlay). Plan and contract: ios/GUIDE.md; the car: ios/CARPLAY.md.

import AVFoundation
import SwiftUI

@main
struct KinoteatriApp: App {
    /// Answers UIKit's orientation question (browsing portrait, the player landscape).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    /// True while the app only hosts the unit tests: they start the core themselves (in a temporary
    /// folder), so the app stays out of the way.
    static let isHostingTests: Bool = {
        let env = ProcessInfo.processInfo.environment
        return env["XCTestConfigurationFilePath"] != nil || env["XCTestBundlePath"] != nil || env["XCTestSessionIdentifier"] != nil
    }()

    init() {
        Diagnostics.shared.log("app \(Diagnostics.appVersion) started · \(Diagnostics.deviceModel) · \(ProcessInfo.processInfo.operatingSystemVersionString)")
        // Films keep playing with the ringer switch on silent, in the background, in picture in
        // picture and in the car.
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
                    RootView()
                        .environmentObject(AppModel.shared)
                        .environmentObject(AppModel.shared.library)
                        .environmentObject(AppModel.shared.playback)
                }
            }
            .preferredColorScheme(.dark)
            .tint(Theme.bulb)
        }
    }
}

extension View {
    /// Shows `message` (when set) in an alert; OK clears it.
    func errorAlert(_ message: Binding<String?>, title: String = L.somethingWrong) -> some View {
        alert(
            title,
            isPresented: Binding(get: { message.wrappedValue != nil }, set: { if !$0 { message.wrappedValue = nil } }),
            actions: { Button(L.ok, role: .cancel) {} },
            message: { Text(message.wrappedValue ?? "") }
        )
    }
}

/// The text to show for an error from the core or the player.
func describe(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
}
