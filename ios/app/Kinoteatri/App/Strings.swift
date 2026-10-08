// Every text the app shows, in one table. English for now; another language is a String Catalog
// (Localizable.xcstrings) with these keys, Georgian first like the desktop app. Texts with a value
// in them are functions; the key stays fixed, the value goes in as %@.

import Foundation

enum L {
    // MARK: Tabs

    static let home = String(localized: "tab.home", defaultValue: "Home")
    static let search = String(localized: "tab.search", defaultValue: "Search")
    static let library = String(localized: "tab.library", defaultValue: "Library")
    static let settings = String(localized: "tab.settings", defaultValue: "Settings")

    // MARK: Brand

    static let brandEyebrow = String(localized: "brand.eyebrow", defaultValue: "Kope's")
    static let brandName = String(localized: "brand.name", defaultValue: "Kinoteatri")

    // MARK: Home

    static let continueWatching = String(localized: "home.continue", defaultValue: "Continue watching")
    static let favorites = String(localized: "home.favorites", defaultValue: "Favorites")
    static let recentlyViewed = String(localized: "home.recent", defaultValue: "Recently viewed")
    static let seeAll = String(localized: "home.seeAll", defaultValue: "See all")
    static let searchPill = String(localized: "home.searchPill", defaultValue: "Search movies and series")
    static let homeEmptyTitle = String(localized: "home.empty.title", defaultValue: "Find something to watch")
    static let homeEmptyBody = String(
        localized: "home.empty.body",
        defaultValue: "Search MovieBox for movies and series. Whatever you play shows up here, with where you stopped."
    )
    static let startSearching = String(localized: "home.empty.action", defaultValue: "Start searching")
    static let removeFromContinue = String(localized: "home.removeContinue", defaultValue: "Remove from Continue watching")
    static let details = String(localized: "home.details", defaultValue: "Details")

    // MARK: Search

    static let searchPrompt = String(localized: "search.prompt", defaultValue: "Movies and series")
    static let searchIdleTitle = String(localized: "search.idle.title", defaultValue: "Search a movie or series")
    static let searchIdleBody = String(localized: "search.idle.body", defaultValue: "Results show as you type. Titles open with their streams, ready to play.")
    static let recentSearches = String(localized: "search.recent", defaultValue: "Recent searches")
    static let clear = String(localized: "search.clear", defaultValue: "Clear")
    static let filterAll = String(localized: "search.filter.all", defaultValue: "All")
    static let filterMovies = String(localized: "search.filter.movies", defaultValue: "Movies")
    static let filterSeries = String(localized: "search.filter.series", defaultValue: "Series")
    static func nothingFound(_ query: String) -> String {
        String(localized: "search.nothing", defaultValue: "Nothing found for “\(query)”")
    }
    static let nothingFoundBody = String(localized: "search.nothing.body", defaultValue: "Check the spelling, or try the original title.")
    static func nothingOfKind(_ kind: String) -> String {
        String(localized: "search.nothingOfKind", defaultValue: "No \(kind.lowercased()) among the results")
    }
    static let searchFailed = String(localized: "search.failed", defaultValue: "The search didn't work")
    static let tryAgain = String(localized: "common.tryAgain", defaultValue: "Try again")

    // MARK: Title

    static let play = String(localized: "title.play", defaultValue: "Play")
    static func playEpisode(_ season: Int, _ episode: Int) -> String {
        String(localized: "title.playEpisode", defaultValue: "Play S\(season) E\(episode)")
    }
    static func resumeAt(_ time: String) -> String {
        String(localized: "title.resumeAt", defaultValue: "Resume from \(time)")
    }
    static func upNext(_ season: Int, _ episode: Int) -> String {
        String(localized: "title.upNext", defaultValue: "Up next: S\(season) E\(episode)")
    }
    static let addFavorite = String(localized: "title.favorite.add", defaultValue: "Add to favorites")
    static let removeFavorite = String(localized: "title.favorite.remove", defaultValue: "Remove from favorites")
    static let more = String(localized: "title.more", defaultValue: "More")
    static let less = String(localized: "title.less", defaultValue: "Less")
    static let audio = String(localized: "title.audio", defaultValue: "Audio")
    static let episodes = String(localized: "title.episodes", defaultValue: "Episodes")
    static func season(_ number: Int) -> String {
        String(localized: "title.season", defaultValue: "Season \(number)")
    }
    static func episodeFallback(_ number: Int) -> String {
        String(localized: "title.episode", defaultValue: "Episode \(number)")
    }
    static let streams = String(localized: "title.streams", defaultValue: "Streams")
    static func streamsFor(_ season: Int, _ episode: Int) -> String {
        String(localized: "title.streamsFor", defaultValue: "Streams · S\(season) E\(episode)")
    }
    static let findingStreams = String(localized: "title.findingStreams", defaultValue: "Finding streams…")
    static let noStreams = String(localized: "title.noStreams", defaultValue: "No streams for this one right now.")
    static let pickEpisode = String(localized: "title.pickEpisode", defaultValue: "Pick an episode to see its streams.")
    static func subtitlesSwitch(_ language: String) -> String {
        String(localized: "title.subtitles", defaultValue: "\(language) subtitles")
    }
    static let subtitlesFooter = String(
        localized: "title.subtitles.footer",
        defaultValue: "Shown when the film has them; the player's subtitle menu turns them off."
    )
    static let best = String(localized: "title.best", defaultValue: "Best")
    static let titleFailed = String(localized: "title.failed", defaultValue: "This title didn't load")
    static let watched = String(localized: "title.watched", defaultValue: "Watched")
    static func timeLeft(_ time: String) -> String {
        String(localized: "title.timeLeft", defaultValue: "\(time) left")
    }

    // MARK: Playing

    static let starting = String(localized: "play.starting", defaultValue: "Starting…")
    static func lookingForSubtitles(_ language: String) -> String {
        String(localized: "play.lookingForSubtitles", defaultValue: "Looking for \(language) subtitles")
    }
    static let cancel = String(localized: "common.cancel", defaultValue: "Cancel")
    static let couldNotPlay = String(localized: "play.failed", defaultValue: "Couldn't play this")
    static let somethingWrong = String(localized: "common.error", defaultValue: "Something went wrong")
    static let ok = String(localized: "common.ok", defaultValue: "OK")
    static let nowPlaying = String(localized: "play.nowPlaying", defaultValue: "Now playing")
    static let pause = String(localized: "play.pause", defaultValue: "Pause")
    static let resume = String(localized: "play.resume", defaultValue: "Resume")
    static let stop = String(localized: "play.stop", defaultValue: "Stop")
    static let openPlayer = String(localized: "play.open", defaultValue: "Open the player")

    // MARK: Library

    static let history = String(localized: "library.history", defaultValue: "History")
    static let historyEmptyTitle = String(localized: "library.history.empty", defaultValue: "Nothing watched yet")
    static let historyEmptyBody = String(
        localized: "library.history.empty.body",
        defaultValue: "Films and episodes you play appear here, with where you stopped."
    )
    static let favoritesEmptyTitle = String(localized: "library.favorites.empty", defaultValue: "No favorites yet")
    static let favoritesEmptyBody = String(
        localized: "library.favorites.empty.body",
        defaultValue: "Tap the heart on any title to keep it here, and on the car's screen."
    )
    static let notStarted = String(localized: "library.notStarted", defaultValue: "Not started")
    static let remove = String(localized: "library.remove", defaultValue: "Remove")

    // MARK: Settings

    static let playback = String(localized: "settings.playback", defaultValue: "Playback")
    static let landscapeLock = String(localized: "settings.landscape", defaultValue: "Play in landscape")
    static let landscapeLockFooter = String(
        localized: "settings.landscape.footer",
        defaultValue: "The player opens sideways and stays that way. Off: it turns with the phone."
    )
    static let quality = String(localized: "settings.quality", defaultValue: "Play button quality")
    static let qualityBest = String(localized: "settings.quality.best", defaultValue: "Best")
    static let qualityLight = String(localized: "settings.quality.light", defaultValue: "Data saver")
    static let qualityFooter = String(
        localized: "settings.quality.footer",
        defaultValue: "What Play and Resume pick. Every stream is still listed on the title. In the car, the lightest one always plays."
    )
    static let subtitles = String(localized: "settings.subtitles", defaultValue: "Subtitles")
    static let subtitleLanguage = String(localized: "settings.subtitleLanguage", defaultValue: "Language")
    static let carPlay = String(localized: "settings.carplay", defaultValue: "CarPlay")
    static let carConnected = String(localized: "settings.carplay.on", defaultValue: "Connected")
    static let carNotConnected = String(localized: "settings.carplay.off", defaultValue: "Not connected")
    static let carPlayFooter = String(
        localized: "settings.carplay.footer",
        defaultValue: "On the car's screen: Continue watching, Favorites, recent searches and Now Playing. The picture stays on the iPhone; CarPlay doesn't show video from apps."
    )
    static let clearHistory = String(localized: "settings.clearHistory", defaultValue: "Clear history")
    static let clearSearches = String(localized: "settings.clearSearches", defaultValue: "Clear recent searches")
    static let clearHistoryConfirm = String(
        localized: "settings.clearHistory.confirm",
        defaultValue: "Continue watching and History will be empty. Favorites stay."
    )
    static let about = String(localized: "settings.about", defaultValue: "About")
    static let app = String(localized: "settings.app", defaultValue: "App")
    static let engine = String(localized: "settings.engine", defaultValue: "Engine")
    static let engineStarting = String(localized: "settings.engine.starting", defaultValue: "Starting…")
    static let engineFailed = String(localized: "settings.engine.failed", defaultValue: "Didn't start")
    static let copyDiagnostics = String(localized: "settings.copyDiagnostics", defaultValue: "Copy diagnostics")
    static let copied = String(localized: "settings.copied", defaultValue: "Copied")
    static func diagnosticsFooter(_ count: Int) -> String {
        String(
            localized: "settings.diagnostics.footer",
            defaultValue: "The last \(count) events: requests to the engine, play sessions and the player's status. Never cookies, headers or stream addresses."
        )
    }
    static let recentEvents = String(localized: "settings.recentEvents", defaultValue: "Recent events")

    // MARK: CarPlay

    static let carContinue = String(localized: "car.continue", defaultValue: "Continue")
    static let carSearches = String(localized: "car.searches", defaultValue: "Searches")
    static let carContinueEmpty = String(localized: "car.continue.empty", defaultValue: "Nothing to continue")
    static let carContinueEmptyBody = String(localized: "car.continue.empty.body", defaultValue: "Start a film or an episode on the iPhone.")
    static let carFavoritesEmptyBody = String(localized: "car.favorites.empty.body", defaultValue: "Add favorites on the iPhone.")
    static let carSearchesEmpty = String(localized: "car.searches.empty", defaultValue: "No recent searches")
    static let carSearchesEmptyBody = String(localized: "car.searches.empty.body", defaultValue: "Searches made on the iPhone show up here.")
    static let carLightest = String(localized: "car.lightest", defaultValue: "Lightest stream: same sound, less data")
    static let carAllStreams = String(localized: "car.allStreams", defaultValue: "All streams")
    static let carSeasons = String(localized: "car.seasons", defaultValue: "Seasons")
    static let carNothingFound = String(localized: "car.nothingFound", defaultValue: "Nothing found")
}
