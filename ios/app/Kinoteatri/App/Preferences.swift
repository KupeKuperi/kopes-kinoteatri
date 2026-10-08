// What people set (Settings, and the subtitle switch on a title), in UserDefaults. Views bind with
// @AppStorage(Preferences.Key…); the rest of the app reads the values here. The UI tests can set
// any of them at launch ("-playerLandscapeLock NO").

import Foundation

enum Preferences {
    enum Key {
        /// Ask the core for subtitles with each play (step 1's English switch, same key).
        static let subtitlesOn = "englishSubtitles"
        /// Which language: an English name the core knows ("English").
        static let subtitleLanguage = "subtitleLanguage"
        /// The player opens in landscape and stays there.
        static let landscapeLock = "playerLandscapeLock"
        /// What Play picks: "best" (the first stream) or "light" (the last).
        static let quality = "playQuality"
    }

    enum Default {
        static let subtitlesOn = true
        static let subtitleLanguage = "English"
        static let landscapeLock = true
        static let quality = PlayQuality.best.rawValue
    }

    private static var defaults: UserDefaults { .standard }

    static var subtitlesOn: Bool {
        defaults.object(forKey: Key.subtitlesOn) as? Bool ?? Default.subtitlesOn
    }

    static var subtitleLanguage: String {
        let name = defaults.string(forKey: Key.subtitleLanguage) ?? Default.subtitleLanguage
        return SubtitleLanguages.code(for: name) == nil ? Default.subtitleLanguage : name
    }

    /// What `play` gets as `subtitles`: the language, or nil when they're off.
    static var subtitles: String? {
        subtitlesOn ? subtitleLanguage : nil
    }

    static var landscapeLock: Bool {
        defaults.object(forKey: Key.landscapeLock) as? Bool ?? Default.landscapeLock
    }

    static var quality: PlayQuality {
        PlayQuality(rawValue: defaults.string(forKey: Key.quality) ?? Default.quality) ?? .best
    }
}

/// Which of a title's streams Play picks. The core lists the best quality first.
enum PlayQuality: String, CaseIterable, Identifiable {
    case best
    case light

    var id: String { rawValue }

    var label: String {
        switch self {
        case .best: return L.qualityBest
        case .light: return L.qualityLight
        }
    }

    /// The stream to play from `streams` (in the core's order), or nil when there are none.
    func pick(from streams: [Stream]) -> Stream? {
        switch self {
        case .best: return streams.first
        case .light: return streams.last
        }
    }
}

/// The subtitle languages the core can look for (ios/core/src/server.rs `language_code`, the
/// desktop relay's table): the name the core takes, and the code AVPlayer's subtitle option has.
enum SubtitleLanguages {
    static let all: [(name: String, code: String)] = [
        ("English", "en"), ("Georgian", "ka"), ("Russian", "ru"), ("Spanish", "es"), ("French", "fr"),
        ("German", "de"), ("Italian", "it"), ("Portuguese", "pt"), ("Turkish", "tr"), ("Ukrainian", "uk"),
        ("Arabic", "ar"), ("Hindi", "hi"), ("Japanese", "ja"), ("Korean", "ko"), ("Chinese", "zh"),
        ("Polish", "pl"), ("Dutch", "nl"), ("Greek", "el"), ("Hebrew", "he"), ("Persian", "fa"),
        ("Indonesian", "id"), ("Malay", "ms"), ("Thai", "th"), ("Vietnamese", "vi"), ("Bengali", "bn"),
        ("Tamil", "ta"), ("Telugu", "te"), ("Urdu", "ur"), ("Czech", "cs"), ("Danish", "da"),
        ("Finnish", "fi"), ("Hungarian", "hu"), ("Norwegian", "no"), ("Romanian", "ro"), ("Swedish", "sv"),
        ("Filipino", "fil"),
    ]

    /// "English" → "en"; nil for a language the core doesn't know.
    static func code(for name: String) -> String? {
        let wanted = name.trimmingCharacters(in: .whitespaces)
        return all.first { $0.name.caseInsensitiveCompare(wanted) == .orderedSame }?.code
    }

    /// The language as this phone's language calls it ("Englisch" on a German phone), else the
    /// English name.
    static func displayName(for name: String) -> String {
        guard let code = code(for: name), let local = Locale.current.localizedString(forLanguageCode: code) else { return name }
        return local.prefix(1).uppercased() + local.dropFirst()
    }
}
