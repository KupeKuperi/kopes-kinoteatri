// The app's state that every screen and the car share: the tab shown, the core's version, the
// library and the one playback. One instance (AppModel.shared): CarPlay can launch the app without
// its phone window, and both scenes must drive the same play.

import SwiftUI

enum AppTab: Hashable {
    case home
    case search
    case library
    case settings
}

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published var tab: AppTab = .home
    /// Library opens on Favorites (Home's "See all").
    @Published var libraryShowsFavorites = false
    /// Home's search pill: the Search tab focuses its field.
    @Published var focusSearch = false
    /// The core's versions (nil until it answered).
    @Published private(set) var version: CoreVersion?
    /// Why the core didn't start, if it didn't.
    @Published private(set) var coreFailure: String?
    @Published private(set) var carPlayConnected = false

    let library: LibraryStore
    let playback: PlaybackCenter
    let search: SearchStore

    private init() {
        library = LibraryStore(file: LibraryStore.defaultFile())
        playback = PlaybackCenter.shared
        search = SearchStore(library: library)
        playback.attach(library: library)
    }

    /// Starts the core (Application Support/Kinoteatri) and reads its version, once.
    func startCore() async {
        guard version == nil else { return }
        do {
            version = try await KinoCore.shared.version()
            coreFailure = nil
        } catch {
            coreFailure = describe(error)
        }
    }

    /// "core 0.1.0 · engine 0.1.26 · engine"
    var engineLine: String? {
        version.map { "core \($0.core) · engine \($0.engine) · \($0.mode)" }
    }

    func openSearch() {
        tab = .search
        focusSearch = true
    }

    func openFavorites() {
        libraryShowsFavorites = true
        tab = .library
    }

    func carPlay(connected: Bool) {
        carPlayConnected = connected
        playback.carConnected = connected
        Diagnostics.shared.log("CarPlay \(connected ? "connected" : "disconnected")")
    }
}
