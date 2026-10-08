// What the car's lists say, worked out apart from CarPlay's classes (so it can be tested without a
// car): one CarRow per list item, from the library and the core's answers.

import Foundation

/// A row of a car list, before it becomes a CPListItem.
struct CarRow: Equatable {
    var text: String
    var detail: String?
    /// The poster shown at the row's start.
    var poster: String?
    /// The row is what plays now (CarPlay's playing indicator).
    var playing = false
    /// Opens a list (a title, a season, search results) rather than playing.
    var opens = false
}

enum CarPlayContent {
    /// Continue watching: plays on where it stopped (or Up next).
    static func continueRow(_ entry: WatchEntry, playing: PlayInfo?) -> CarRow {
        let detail: String
        if entry.isFinished, let next = entry.next {
            detail = L.upNext(next.season, next.episode)
        } else {
            detail = [entry.episodeTag, Format.standing(entry)].compactMap { $0 }.joined(separator: " · ")
        }
        return CarRow(text: entry.title.title, detail: detail, poster: entry.title.poster, playing: playing?.title.id == entry.id)
    }

    /// A favorite or a search result: opens the title.
    static func titleRow(_ title: Title, playing: PlayInfo?) -> CarRow {
        CarRow(
            text: title.title,
            detail: kindLine(year: title.year, kind: title.kind, extra: [title.rating.map { "★ \($0)" }]),
            poster: title.poster,
            playing: playing?.title.id == title.id,
            opens: true
        )
    }

    static func searchRow(_ query: String) -> CarRow {
        CarRow(text: query, opens: true)
    }

    /// Resume on a title's list, when its history has somewhere to go on from.
    static func resumeRow(_ entry: WatchEntry) -> CarRow? {
        guard entry.showsInContinue else { return nil }
        let text: String
        if entry.isFinished, let next = entry.next {
            text = L.upNext(next.season, next.episode)
        } else if entry.position >= 5 {
            text = L.resumeAt(Format.clock(entry.position))
        } else {
            return nil
        }
        return CarRow(text: text, detail: entry.episodeTag, poster: entry.title.poster)
    }

    /// "Play" on a film's list: the lightest stream.
    static func playRow(_ title: Title) -> CarRow {
        CarRow(text: L.play, detail: L.carLightest, poster: title.poster)
    }

    static func streamRow(_ stream: Stream) -> CarRow {
        let facts = Format.facts(stream)
        return CarRow(text: stream.label, detail: facts.isEmpty ? nil : facts)
    }

    static func seasonRow(_ season: SeasonInfo) -> CarRow {
        CarRow(text: L.season(season.season), detail: "\(season.episodes.count)", opens: true)
    }

    /// An episode: plays it (the lightest stream); the last played one says where it stood.
    static func episodeRow(_ info: EpisodeInfo, season: Int, entry: WatchEntry?, playing: PlayInfo?, titleId: String) -> CarRow {
        let mine = entry.flatMap { $0.season == season && $0.episode == info.episode ? $0 : nil }
        let isPlaying = playing.map { $0.title.id == titleId && $0.season == season && $0.episode == info.episode } ?? false
        return CarRow(
            text: "\(info.episode). \(info.title ?? L.episodeFallback(info.episode))",
            detail: mine.map(Format.standing),
            playing: isPlaying
        )
    }

    /// At most `limit` (the car's list limit; some cars take 12).
    static func capped<Item>(_ items: [Item], _ limit: Int) -> [Item] {
        Array(items.prefix(max(1, limit)))
    }
}
