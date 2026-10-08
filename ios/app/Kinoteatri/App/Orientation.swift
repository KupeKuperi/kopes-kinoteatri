// Which way the app may turn. Browsing is portrait; the player is landscape-only with "Play in
// landscape" (Settings, on by default), else it turns with the phone. UIKit asks the app delegate;
// a change rotates the screen at once (iOS 16's geometry request).

import UIKit

@MainActor
enum Orientation {
    /// What the app allows now.
    private(set) static var allowed: UIInterfaceOrientationMask = .portrait

    /// Browsing: portrait.
    static func browsing() {
        allow(.portrait)
    }

    /// The player is on screen: landscape when locked, else any way but upside down.
    static func player(locked: Bool) {
        allow(locked ? .landscape : .allButUpsideDown)
    }

    private static func allow(_ mask: UIInterfaceOrientationMask) {
        guard mask != allowed else { return }
        allowed = mask
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for window in scene.windows {
                var controller = window.rootViewController
                while let current = controller {
                    current.setNeedsUpdateOfSupportedInterfaceOrientations()
                    controller = current.presentedViewController
                }
            }
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
                Diagnostics.shared.log("orientation: \(error.localizedDescription)")
            }
        }
    }
}

/// UIKit's questions to the app: which orientations, for now.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        Orientation.allowed
    }
}
