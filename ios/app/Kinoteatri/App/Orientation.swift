// Which way the app may turn. Browsing is portrait. While the player is up the app allows any way
// but upside down, and the player itself says which (KinoPlayerViewController): landscape only with
// "Play in landscape" (Settings, on by default), else any. UIKit asks the app delegate for the app's
// part and the player on screen for its own; a change rotates the screen at once (iOS 16's
// geometry request). Order matters: the app must allow landscape before a landscape-only player is
// presented, and go back to portrait only once it's gone (UIKit throws when they share no way).

import AVKit
import UIKit

@MainActor
enum Orientation {
    /// What the app allows now.
    private(set) static var allowed: UIInterfaceOrientationMask = .portrait
    /// How often UIKit asked the app delegate (the UI tests read it through the player's facts).
    static var asked = 0

    /// Browsing: portrait (after the player has left the screen).
    static func browsing() {
        allow(.portrait, rotate: true)
    }

    /// The player is about to be presented: the app lets it turn as it says.
    static func player() {
        allow(.allButUpsideDown, rotate: false)
    }

    /// The player is up: UIKit reads its orientations again; sideways at once when it's
    /// landscape only.
    static func turn(_ player: UIViewController, to mask: UIInterfaceOrientationMask) {
        player.setNeedsUpdateOfSupportedInterfaceOrientations()
        guard mask == .landscape, let scene = player.view.window?.windowScene else { return }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
            Diagnostics.shared.log("orientation: \(error.localizedDescription)")
        }
    }

    private static func allow(_ mask: UIInterfaceOrientationMask, rotate: Bool) {
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
            if rotate {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
                    Diagnostics.shared.log("orientation: \(error.localizedDescription)")
                }
            }
        }
    }

    /// "landscape", "portrait", "all", or the raw value.
    static func name(_ mask: UIInterfaceOrientationMask) -> String {
        switch mask {
        case .landscape: return "landscape"
        case .portrait: return "portrait"
        case .allButUpsideDown: return "all"
        default: return "\(mask.rawValue)"
        }
    }
}

/// UIKit's questions to the app: which orientations, for now.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        Orientation.asked += 1
        return Orientation.allowed
    }
}

/// Apple's player, saying which way it may turn: UIKit asks the full-screen player itself, not only
/// the app. Only these two answers are changed; everything else is AVPlayerViewController's own
/// (Apple advises against subclassing it for anything more).
final class KinoPlayerViewController: AVPlayerViewController {
    /// `.landscape` with the landscape lock, else any way but upside down.
    var allowedOrientations: UIInterfaceOrientationMask = .allButUpsideDown

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        allowedOrientations
    }

    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        guard allowedOrientations == .landscape else { return super.preferredInterfaceOrientationForPresentation }
        // The side the phone is already turned to (a device turned right shows the interface left).
        return UIDevice.current.orientation == .landscapeRight ? .landscapeLeft : .landscapeRight
    }
}
