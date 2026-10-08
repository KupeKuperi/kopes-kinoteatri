// A title: the poster big over its own blurred glow, the name and facts, then Play (or Resume
// where it stopped, or the chosen episode) and the heart. Below: the description, the dubs, for a
// series the seasons and episodes, and the streams with the subtitle switch. A stream plays at
// once; Play picks one by the quality setting. Plays go through PlaybackCenter, which opens the
// full-screen player.

import SwiftUI

struct TitleDetailView: View {
    @StateObject private var store: TitleStore
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var playback: PlaybackCenter
    @AppStorage(Preferences.Key.subtitlesOn) private var subtitlesOn = Preferences.Default.subtitlesOn
    @AppStorage(Preferences.Key.subtitleLanguage) private var subtitleLanguage = Preferences.Default.subtitleLanguage
    @AppStorage(Preferences.Key.quality) private var quality = Preferences.Default.quality
    @State private var expanded = false
    /// The stream whose play is starting (its row shows a spinner).
    @State private var startingStream: Int?

    init(title: Title) {
        _store = StateObject(wrappedValue: TitleStore(title: title, library: AppModel.shared.library))
    }

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    TitleHero(title: store.libraryTitle, details: store.details)
                    actions
                    if case .failed(let message) = store.detailsLoad {
                        ErrorCard(title: L.titleFailed, message: message) {
                            Task { await store.reload() }
                        }
                        .padding(.horizontal, Theme.gutter)
                    }
                    description
                    if store.audio.count > 1 {
                        dubs
                    }
                    if store.isSeries, !store.seasons.isEmpty {
                        episodesSection(scroller)
                    }
                    if store.details != nil || store.detailsLoad == .loading {
                        streamsSection
                            .id("streams")
                    }
                }
                .padding(.bottom, 36)
            }
            .scrollIndicators(.hidden)
        }
        .ignoresSafeArea(edges: .top)
        // The status bar and the back button stay readable over text scrolled under them.
        .overlay(alignment: .top) {
            // Under the status bar (an overlay keeps to the safe area unless it ignores it too) and
            // 50 points more, past the back button; never over Play.
            LinearGradient(
                stops: [
                    .init(color: Theme.house, location: 0),
                    .init(color: Theme.house.opacity(0.8), location: 0.5),
                    .init(color: Theme.house.opacity(0), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
                .frame(height: 50)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
        .houseBackground()
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .task {
            library.opened(store.title)
            await store.load()
        }
        .task(id: store.streamsTaskKey) { await store.loadStreams() }
        .errorAlert($store.failure)
    }

    // MARK: Play and favorite

    private var entry: WatchEntry? {
        library.entry(for: store.title.id)
    }

    /// The history entry when Play would resume it: same dub and episode, stopped part way.
    private var resumable: WatchEntry? {
        guard let entry, let details = store.details, entry.playId == details.id, !entry.isFinished, entry.position >= 5 else { return nil }
        if details.isSeries, entry.season != store.season || entry.episode != store.episode {
            return nil
        }
        return entry
    }

    private var playLabel: String {
        if let resumable {
            return L.resumeAt(Format.clock(resumable.position))
        }
        if store.isSeries, store.episode > 0 {
            return L.playEpisode(store.season, store.episode)
        }
        return L.play
    }

    private var actions: some View {
        let favorite = library.isFavorite(store.title.id)
        return HStack(spacing: 12) {
            Button {
                playMain()
            } label: {
                Label(playLabel, systemImage: resumable == nil ? "play.fill" : "play.circle.fill")
                    .lineLimit(1)
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(store.details == nil || playback.starting != nil || (store.isSeries && store.episode == 0))
            .accessibilityIdentifier("play")

            Button {
                let added = library.toggleFavorite(store.libraryTitle)
                Haptics.favorite(added: added)
            } label: {
                Image(systemName: favorite ? "heart.fill" : "heart")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(favorite ? Theme.bulb : Theme.screen)
                    .contentTransition(.opacity)
            }
            .buttonStyle(TileButtonStyle())
            .accessibilityLabel(favorite ? L.removeFavorite : L.addFavorite)
            .accessibilityValue(favorite ? "1" : "0")
            .accessibilityIdentifier("favorite")
        }
        .padding(.horizontal, Theme.gutter)
        .animation(.easeOut(duration: 0.2), value: favorite)
    }

    private func playMain() {
        if let resumable {
            run { try await playback.resume(resumable, from: .phone) }
            return
        }
        guard let info = store.playInfo else { return }
        let choice: StreamChoice
        if let stream = (PlayQuality(rawValue: quality) ?? .best).pick(from: store.streams) {
            choice = .stream(stream)
            startingStream = stream.index
        } else {
            choice = .quality(PlayQuality(rawValue: quality) ?? .best)
        }
        run { try await playback.play(info, choice, from: .phone) }
    }

    private func play(_ stream: Stream) {
        guard let info = store.playInfo, playback.starting == nil else { return }
        startingStream = stream.index
        run { try await playback.play(info, .stream(stream), from: .phone) }
    }

    /// A play: a tap of the Taptic Engine, the play, its error in an alert.
    private func run(_ play: @escaping () async throws -> Bool) {
        Haptics.play()
        Task {
            defer { startingStream = nil }
            do {
                _ = try await play()
            } catch {
                Haptics.failure()
                playback.failure = describe(error)
            }
        }
    }

    // MARK: About it

    @ViewBuilder private var description: some View {
        if let text = store.details?.description, !text.isEmpty {
            let long = text.count > 220
            VStack(alignment: .leading, spacing: 8) {
                Text(text)
                    .font(.callout)
                    .foregroundStyle(Theme.usher)
                    .lineLimit(expanded || !long ? nil : 4)
                    .fixedSize(horizontal: false, vertical: true)
                if long {
                    Button(expanded ? L.less : L.more) {
                        withAnimation(.easeInOut(duration: 0.25)) { expanded.toggle() }
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.bulb)
                }
            }
            .padding(.horizontal, Theme.gutter)
        } else if store.detailsLoad == .loading {
            VStack(alignment: .leading, spacing: 8) {
                SkeletonBlock(cornerRadius: 4).frame(height: 12)
                SkeletonBlock(cornerRadius: 4).frame(height: 12)
                SkeletonBlock(cornerRadius: 4).frame(width: 180, height: 12)
            }
            .padding(.horizontal, Theme.gutter)
        }
    }

    /// The dubs as chips; the one shown is lit, the others switch to theirs.
    private var dubs: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: L.audio)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(store.audio) { track in
                        Button {
                            Haptics.select()
                            Task { await store.switchAudio(to: track) }
                        } label: {
                            HStack(spacing: 6) {
                                Chip(text: track.label, selected: track.id == store.details?.id, systemImage: "speaker.wave.2.fill")
                                if store.switchingAudio == track.id {
                                    ProgressView()
                                        .tint(Theme.bulb)
                                }
                            }
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(store.switchingAudio != nil || track.id == store.details?.id)
                    }
                }
                .padding(.horizontal, Theme.gutter)
            }
        }
    }

    // MARK: Episodes

    private func episodesSection(_ scroller: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: L.episodes)
            if store.seasons.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(store.seasons, id: \.season) { info in
                            Button {
                                Haptics.select()
                                store.select(season: info.season)
                            } label: {
                                Chip(text: L.season(info.season), selected: info.season == store.season)
                            }
                            .buttonStyle(PressableStyle())
                        }
                    }
                    .padding(.horizontal, Theme.gutter)
                }
            }
            LazyVStack(spacing: 8) {
                ForEach(store.episodes, id: \.episode) { info in
                    Button {
                        Haptics.select()
                        store.select(episode: info.episode)
                        withAnimation(.easeInOut(duration: 0.35)) {
                            scroller.scrollTo("streams", anchor: .top)
                        }
                    } label: {
                        EpisodeRow(
                            info: info,
                            selected: info.episode == store.episode,
                            standing: standing(of: info)
                        )
                    }
                    .buttonStyle(PressableStyle(scale: 0.98))
                    .accessibilityIdentifier("episode-\(info.episode)")
                }
            }
            .padding(.horizontal, Theme.gutter)
        }
    }

    /// How far the person got in an episode: only the history's (last played) one is known.
    private func standing(of info: EpisodeInfo) -> WatchEntry? {
        guard let entry, entry.playId == store.details?.id, entry.season == store.season, entry.episode == info.episode else { return nil }
        return entry
    }

    // MARK: Streams

    private var streamsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: store.isSeries && store.episode > 0 ? L.streamsFor(store.season, store.episode) : L.streams)
            VStack(spacing: 8) {
                subtitlesSwitch
                streamRows
            }
            .padding(.horizontal, Theme.gutter)
            Text(L.subtitlesFooter)
                .font(.footnote)
                .foregroundStyle(Theme.dim)
                .padding(.horizontal, Theme.gutter)
        }
    }

    private var subtitlesSwitch: some View {
        Toggle(isOn: $subtitlesOn) {
            Label(L.subtitlesSwitch(SubtitleLanguages.displayName(for: Preferences.subtitleLanguage)), systemImage: "captions.bubble.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.screen)
        }
        .tint(Theme.bulb)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .fill(Theme.velvet)
                .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).strokeBorder(Theme.seam))
        )
        .accessibilityIdentifier("subtitles")
        .onChange(of: subtitlesOn) { _ in Haptics.select() }
    }

    @ViewBuilder private var streamRows: some View {
        switch store.streamsLoad {
        case .idle:
            if store.isSeries, store.episode == 0, store.details != nil {
                Text(L.pickEpisode)
                    .font(.callout)
                    .foregroundStyle(Theme.usher)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if store.details == nil {
                ForEach(0..<3, id: \.self) { _ in SkeletonRow() }
            }
        case .loading:
            ForEach(0..<3, id: \.self) { _ in SkeletonRow() }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(L.findingStreams)
        case .failed(let message):
            ErrorCard(title: L.somethingWrong, message: message) {
                Task { await store.retryStreams() }
            }
        case .loaded:
            if store.streams.isEmpty {
                Text(L.noStreams)
                    .font(.callout)
                    .foregroundStyle(Theme.usher)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(store.streams.enumerated()), id: \.element.index) { position, stream in
                    Button {
                        play(stream)
                    } label: {
                        StreamRow(stream: stream, isBest: position == 0 && store.streams.count > 1, isStarting: startingStream == stream.index)
                    }
                    .buttonStyle(PressableStyle(scale: 0.98))
                    .disabled(playback.starting != nil)
                    .accessibilityIdentifier("stream-\(stream.index)")
                }
            }
        }
    }
}

/// The top of a title: its poster over a blurred glow of itself, the name, the facts, the genres.
struct TitleHero: View {
    let title: Title
    let details: Details?

    var body: some View {
        ZStack(alignment: .bottom) {
            // The glow: the poster, huge and blurred, fading into the room.
            Color.clear
                .frame(height: 470)
                .overlay {
                    RemoteImage(url: title.poster, maxPixels: 240) { Theme.velvet }
                        .blur(radius: 40)
                        .scaleEffect(1.4)
                        .opacity(0.6)
                }
                .clipped()
                .overlay(
                    LinearGradient(
                        stops: [
                            .init(color: Theme.house.opacity(0.25), location: 0),
                            .init(color: Theme.house.opacity(0.55), location: 0.55),
                            .init(color: Theme.house, location: 1),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .accessibilityHidden(true)

            VStack(spacing: 12) {
                PosterArt(url: title.poster, title: title.title, cornerRadius: 16, maxPixels: 700)
                    .frame(width: 176)
                    .shadow(color: .black.opacity(0.6), radius: 28, y: 16)
                    .padding(.bottom, 6)
                Text(details?.title ?? title.title)
                    .displayFont(.largeTitle)
                    .foregroundStyle(Theme.screen)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .minimumScaleFactor(0.7)
                    .accessibilityAddTraits(.isHeader)
                HStack(spacing: 10) {
                    Text(kindLine(year: details?.year ?? title.year, kind: details?.kind ?? title.kind, extra: [details?.duration]))
                        .metaFont()
                    if let rating = details?.rating ?? title.rating, !rating.isEmpty {
                        Label(rating, systemImage: "star.fill")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(Theme.bulb)
                            .labelStyle(.titleAndIcon)
                    }
                }
                if let genres = details?.genres, !genres.isEmpty {
                    Text(genres.prefix(4).joined(separator: " · "))
                        .font(.footnote)
                        .foregroundStyle(Theme.usher)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 104)
        }
    }
}

/// An episode in the list: its number, its name, how far it was watched; the chosen one is lit.
struct EpisodeRow: View {
    let info: EpisodeInfo
    let selected: Bool
    let standing: WatchEntry?

    var body: some View {
        HStack(spacing: 14) {
            Text("\(info.episode)")
                .font(.title3.weight(.heavy))
                .fontWidth(.condensed)
                .monospacedDigit()
                .foregroundStyle(selected ? Theme.bulb : Theme.dim)
                .frame(minWidth: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(info.title ?? L.episodeFallback(info.episode))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.screen)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if let standing {
                    if standing.isFinished {
                        Label(L.watched, systemImage: "checkmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.ok)
                    } else if let progress = standing.progress {
                        ProgressBar(value: progress, height: 3)
                            .frame(maxWidth: 140)
                    }
                }
            }
            Spacer(minLength: 8)
            if selected {
                Image(systemName: "checkmark")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Theme.bulb)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(selected ? Theme.curtain : Theme.velvet)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(selected ? Theme.bulb.opacity(0.5) : Theme.seam)
                )
        )
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
