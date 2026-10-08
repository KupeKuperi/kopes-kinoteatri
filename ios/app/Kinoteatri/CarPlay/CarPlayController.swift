// The car's screen, as templates (CarPlay draws them; apps can't draw their own). Three tabs:
// Continue (plays on where it stopped), Favorites and Searches (the phone's recent searches: an
// audio app can't type in the car). A title opens a list: Resume or Play (the lightest stream: the
// sound is the same, it costs far less mobile data), then its streams, or for a series its seasons
// and episodes. Starting a play shows Now Playing, whose buttons drive the phone's one playback.
// The lists follow the library and what plays. The picture stays on the phone (ios/CARPLAY.md).

import CarPlay
import Combine
import UIKit

@MainActor
final class CarPlayController {
    private let interface: CPInterfaceController
    private let app: AppModel
    private let continueList = CPListTemplate(title: L.carContinue, sections: [])
    private let favoritesList = CPListTemplate(title: L.favorites, sections: [])
    private let searchesList = CPListTemplate(title: L.carSearches, sections: [])
    private var subscriptions: Set<AnyCancellable> = []
    /// What each tab shows now, so an unchanged list isn't rebuilt (it would lose its place).
    private var shown: [ObjectIdentifier: [CarRow]] = [:]
    /// CarPlay allows 5 templates in the stack, the tab bar included.
    private let maximumDepth = 5

    private var library: LibraryStore { app.library }
    private var playback: PlaybackCenter { app.playback }

    init(interface: CPInterfaceController, app: AppModel) {
        self.interface = interface
        self.app = app
    }

    func connect() {
        continueList.tabTitle = L.carContinue
        continueList.tabImage = UIImage(systemName: "play.circle.fill")
        continueList.emptyViewTitleVariants = [L.carContinueEmpty]
        continueList.emptyViewSubtitleVariants = [L.carContinueEmptyBody]
        favoritesList.tabTitle = L.favorites
        favoritesList.tabImage = UIImage(systemName: "heart.fill")
        favoritesList.emptyViewTitleVariants = [L.favoritesEmptyTitle]
        favoritesList.emptyViewSubtitleVariants = [L.carFavoritesEmptyBody]
        searchesList.tabTitle = L.carSearches
        searchesList.tabImage = UIImage(systemName: "magnifyingglass")
        searchesList.emptyViewTitleVariants = [L.carSearchesEmpty]
        searchesList.emptyViewSubtitleVariants = [L.carSearchesEmptyBody]

        let tabs: [CPTemplate] = [continueList, favoritesList, searchesList]
        let root = CPTabBarTemplate(templates: Array(tabs.prefix(max(1, CPTabBarTemplate.maximumTabCount))))
        interface.setRootTemplate(root, animated: false, completion: nil)

        // Films have no "up next" queue or album: those buttons stay off.
        CPNowPlayingTemplate.shared.isUpNextButtonEnabled = false
        CPNowPlayingTemplate.shared.isAlbumArtistButtonEnabled = false

        refresh()
        library.objectWillChange
            .merge(with: playback.objectWillChange)
            .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
            .sink { [weak self] _ in self?.refresh() }
            .store(in: &subscriptions)
        Diagnostics.shared.log("CarPlay: tabs up (\(CPTabBarTemplate.maximumTabCount) allowed, lists up to \(CPListTemplate.maximumItemCount) items)")
    }

    func disconnect() {
        subscriptions.removeAll()
    }

    // MARK: The tabs

    private func refresh() {
        let playing = playback.info
        let limit = CPListTemplate.maximumItemCount

        let entries = CarPlayContent.capped(library.continueWatching, limit)
        update(continueList, rows: entries.map { CarPlayContent.continueRow($0, playing: playing) }) { [weak self] index, done in
            self?.resume(entries[index], done: done)
        }

        let favorites = CarPlayContent.capped(library.favorites.map(\.title), limit)
        update(favoritesList, rows: favorites.map { CarPlayContent.titleRow($0, playing: playing) }) { [weak self] index, done in
            self?.open(favorites[index], done: done)
        }

        let searches = CarPlayContent.capped(library.recentSearches, limit)
        update(searchesList, rows: searches.map(CarPlayContent.searchRow), systemImage: "magnifyingglass") { [weak self] index, done in
            self?.search(searches[index], done: done)
        }
    }

    /// Puts `rows` in `template` (unless they're what it shows); `select` runs for a tapped row and
    /// calls `done` when its work is over (the car shows a spinner on the row until then).
    private func update(
        _ template: CPListTemplate,
        rows: [CarRow],
        systemImage: String = "film",
        select: @escaping (Int, @escaping () -> Void) -> Void
    ) {
        let key = ObjectIdentifier(template)
        guard shown[key] != rows else { return }
        shown[key] = rows
        template.updateSections([section(rows, systemImage: systemImage, select: select)])
    }

    private func section(_ rows: [CarRow], header: String? = nil, systemImage: String = "film", select: @escaping (Int, @escaping () -> Void) -> Void) -> CPListSection {
        let items = rows.enumerated().map { index, row -> CPListItem in
            let item = listItem(row, systemImage: systemImage)
            item.handler = { _, done in select(index, done) }
            return item
        }
        return CPListSection(items: items, header: header, sectionIndexTitle: nil)
    }

    /// A list item; the poster comes in when it's loaded.
    private func listItem(_ row: CarRow, systemImage: String) -> CPListItem {
        let size = CPListItem.maximumImageSize
        let maxPixels = max(size.width, size.height) * max(interface.carTraitCollection.displayScale, 2)
        let cached = ImageCache.shared.cached(row.poster, maxPixels: maxPixels)
        let item = CPListItem(text: row.text, detailText: row.detail, image: cached ?? UIImage(systemName: systemImage))
        item.isPlaying = row.playing
        item.playingIndicatorLocation = .trailing
        item.accessoryType = row.opens ? .disclosureIndicator : .none
        if cached == nil, let poster = row.poster {
            Task { [weak item] in
                guard let image = await ImageCache.shared.image(poster, maxPixels: maxPixels) else { return }
                item?.setImage(image)
            }
        }
        return item
    }

    // MARK: Lists below the tabs

    /// A title: Resume / Play, then its streams (a film) or its seasons and episodes (a series).
    private func open(_ title: Title, done: @escaping () -> Void) {
        Task {
            defer { done() }
            do {
                let entry = library.entry(for: title.id)
                let (details, audio) = try await TitleStore.preferredDetails(id: title.id, preferring: entry?.playId)
                let libraryTitle = details.libraryTitle(id: title.id, fallback: title)
                let dub = audio.first { $0.id == details.id }?.label
                var sections: [CPListSection] = []
                if let entry, entry.playId == details.id, let row = CarPlayContent.resumeRow(entry) {
                    sections.append(section([row]) { [weak self] _, done in self?.resume(entry, done: done) })
                }
                if details.isSeries {
                    let seasons = details.seasons.sorted { $0.season < $1.season }.filter { !$0.episodes.isEmpty }
                    if seasons.count == 1, let only = seasons.first {
                        sections.append(episodesSection(libraryTitle, details, dub: dub, season: only))
                    } else {
                        let rows = CarPlayContent.capped(seasons, CPListTemplate.maximumItemCount).map(CarPlayContent.seasonRow)
                        sections.append(section(rows, header: L.carSeasons, systemImage: "list.number") { [weak self] index, done in
                            self?.openSeason(libraryTitle, details, dub: dub, season: seasons[index])
                            done()
                        })
                    }
                } else {
                    let info = PlayInfo(title: libraryTitle, playId: details.id, dubLabel: dub)
                    sections.append(section([CarPlayContent.playRow(libraryTitle)], systemImage: "play.fill") { [weak self] _, done in
                        self?.play(info, .quality(.light), done: done)
                    })
                    let streams = try await KinoCore.shared.streams(id: details.id)
                    let shown = CarPlayContent.capped(streams, CPListTemplate.maximumItemCount - 2)
                    if !shown.isEmpty {
                        sections.append(section(shown.map(CarPlayContent.streamRow), header: L.carAllStreams, systemImage: "play.rectangle") { [weak self] index, done in
                            self?.play(info, .stream(shown[index]), done: done)
                        })
                    }
                }
                push(CPListTemplate(title: libraryTitle.title, sections: sections))
            } catch {
                show(error)
            }
        }
    }

    private func openSeason(_ title: Title, _ details: Details, dub: String?, season: SeasonInfo) {
        push(CPListTemplate(title: "\(title.title) · \(L.season(season.season))", sections: [episodesSection(title, details, dub: dub, season: season)]))
    }

    /// A season's episodes; one plays the lightest stream.
    private func episodesSection(_ title: Title, _ details: Details, dub: String?, season: SeasonInfo) -> CPListSection {
        let entry = library.entry(for: title.id).flatMap { $0.playId == details.id ? $0 : nil }
        let episodes = CarPlayContent.capped(season.episodes.sorted { $0.episode < $1.episode }, CPListTemplate.maximumItemCount)
        let rows = episodes.map {
            CarPlayContent.episodeRow($0, season: season.season, entry: entry, playing: playback.info, titleId: title.id)
        }
        return section(rows, header: L.season(season.season), systemImage: "play.rectangle") { [weak self] index, done in
            let episode = episodes[index]
            let info = PlayInfo(
                title: title, playId: details.id, dubLabel: dub, season: season.season, episode: episode.episode,
                episodeTitle: episode.title, next: nextEpisode(after: season.season, episode.episode, in: details.seasons)
            )
            self?.play(info, .quality(.light), done: done)
        }
    }

    /// A recent search, run again: its results.
    private func search(_ query: String, done: @escaping () -> Void) {
        Task {
            defer { done() }
            do {
                let found = CarPlayContent.capped(try await KinoCore.shared.search(query), CPListTemplate.maximumItemCount)
                let template = CPListTemplate(title: query, sections: [])
                template.emptyViewTitleVariants = [L.carNothingFound]
                if !found.isEmpty {
                    template.updateSections([section(found.map { CarPlayContent.titleRow($0, playing: playback.info) }) { [weak self] index, done in
                        self?.open(found[index], done: done)
                    }])
                }
                push(template)
            } catch {
                show(error)
            }
        }
    }

    // MARK: Playing

    private func resume(_ entry: WatchEntry, done: @escaping () -> Void) {
        Task {
            defer { done() }
            do {
                if try await playback.resume(entry, from: .car) {
                    showNowPlaying()
                }
            } catch {
                show(error)
            }
        }
    }

    private func play(_ info: PlayInfo, _ choice: StreamChoice, done: @escaping () -> Void) {
        Task {
            defer { done() }
            do {
                if try await playback.play(info, choice, from: .car) {
                    showNowPlaying()
                }
            } catch {
                show(error)
            }
        }
    }

    /// Now Playing on top (only lists may go over it).
    private func showNowPlaying() {
        let nowPlaying = CPNowPlayingTemplate.shared
        if interface.topTemplate === nowPlaying {
            return
        }
        if interface.templates.contains(where: { $0 === nowPlaying }) {
            interface.pop(to: nowPlaying, animated: true, completion: nil)
            return
        }
        if interface.templates.count >= maximumDepth {
            interface.popToRootTemplate(animated: false, completion: nil)
        }
        interface.pushTemplate(nowPlaying, animated: true, completion: nil)
    }

    private func push(_ template: CPTemplate) {
        if interface.templates.count >= maximumDepth {
            interface.popToRootTemplate(animated: false, completion: nil)
        }
        interface.pushTemplate(template, animated: true, completion: nil)
    }

    /// An error, as the car shows them: an alert with OK.
    private func show(_ error: Error) {
        Diagnostics.shared.log("CarPlay: \(describe(error))")
        let alert = CPAlertTemplate(
            titleVariants: [String(describe(error).prefix(120)), L.couldNotPlay],
            actions: [
                CPAlertAction(title: L.ok, style: .cancel) { [weak self] _ in
                    self?.interface.dismissTemplate(animated: true, completion: nil)
                },
            ]
        )
        if interface.presentedTemplate != nil {
            interface.dismissTemplate(animated: false, completion: nil)
        }
        interface.presentTemplate(alert, animated: true, completion: nil)
    }
}
