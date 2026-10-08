// A light tap of the Taptic Engine for the moments that matter: Play, a favorite, a choice.
// The system leaves them out when the person turned system haptics off.

import UIKit

@MainActor
enum Haptics {
    /// A play is starting.
    static func play() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    /// A favorite added (success) or removed (a softer tap).
    static func favorite(added: Bool) {
        if added {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } else {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }

    /// A choice among several (season, episode, dub, filter).
    static func select() {
        UISelectionFeedbackGenerator().selectionChanged()
    }

    static func failure() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
}
