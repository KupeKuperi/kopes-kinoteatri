// A title: poster, facts, description; for a series a season picker and its episodes; then the
// streams of the film (or the chosen episode). A stream opens the player. A title with several
// dubs opens on the TUI's default one (Original, else English); the Audio list switches dubs.

import SwiftUI

struct TitleView: View {
    let title: Title

    /// The details of the dub shown: its id is what streams and play use.
    @State private var details: Details?
    /// Every dub of the title (the details of each list them all).
    @State private var audio: [AudioTrack] = []
    /// The dub being loaded.
    @State private var switchingAudio: String?
    @State private var season = 0
    @State private var episode = 0
    @State private var streams: [Stream] = []
    @State private var loadingStreams = false
    /// The dub/season/episode the streams are for, so coming back from the player doesn't reload
    /// them.
    @State private var streamsKey: String?
    /// The stream being started.
    @State private var starting: Int?
    @State private var playing: Playing?
    @State private var error: String?

    var body: some View {
        List {
            Section {
                header
            }
            if let text = details?.description, !text.isEmpty {
                Section {
                    Text(text)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            if let details {
                if audio.count > 1 {
                    audioSection(current: details.id)
                }
                if details.isSeries, !details.seasons.isEmpty {
                    episodesSection(details)
                }
                Section {
                    streamRows
                } header: {
                    Text(details.isSeries ? "Streams · S\(season) E\(episode)" : "Streams")
                }
            }
        }
        .navigationTitle(details?.title ?? title.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadDetails() }
        .task(id: "\(details?.id ?? "")/\(season)/\(episode)") { await loadStreams() }
        .fullScreenCover(item: $playing) { PlayerView(playing: $0) }
        .errorAlert($error)
    }

    // MARK: Parts

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            PosterView(url: details?.poster ?? title.poster, width: 112)
            VStack(alignment: .leading, spacing: 6) {
                Text(details?.title ?? title.title)
                    .font(.title3.bold())
                Text(kindLine(year: details?.year ?? title.year, kind: details?.kind ?? title.kind, extra: [details?.duration]))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let rating = details?.rating ?? title.rating, !rating.isEmpty {
                    RatingView(rating: rating)
                }
                if let genres = details?.genres, !genres.isEmpty {
                    Text(genres.joined(separator: ", "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if details == nil {
                    ProgressView()
                        .padding(.top, 4)
                }
            }
        }
        .padding(.vertical, 6)
    }

    /// The dubs; the one shown has a checkmark, the others switch to theirs.
    private func audioSection(current: String) -> some View {
        Section("Audio") {
            ForEach(audio) { track in
                if track.id == current {
                    HStack {
                        Label(track.label, systemImage: "speaker.wave.2.fill")
                        Spacer()
                        Image(systemName: "checkmark")
                            .foregroundStyle(Color.accentColor)
                    }
                } else {
                    Button {
                        Task { await switchAudio(to: track) }
                    } label: {
                        HStack {
                            Label(track.label, systemImage: "speaker.wave.2")
                                .foregroundStyle(.primary)
                            Spacer()
                            if switchingAudio == track.id {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(switchingAudio != nil)
                }
            }
        }
    }

    private func episodesSection(_ details: Details) -> some View {
        let seasonBinding = Binding(
            get: { season },
            set: { chosen in
                // A new season starts at its first episode.
                season = chosen
                episode = details.seasons.first { $0.season == chosen }?.episodes.first?.episode ?? 0
            }
        )
        let episodes = details.seasons.first { $0.season == season }?.episodes ?? []
        return Section("Episodes") {
            Picker("Season", selection: seasonBinding) {
                ForEach(details.seasons, id: \.season) { info in
                    Text("Season \(info.season)").tag(info.season)
                }
            }
            ForEach(episodes, id: \.episode) { info in
                Button {
                    episode = info.episode
                } label: {
                    HStack {
                        Text("\(info.episode). \(info.title ?? "Episode \(info.episode)")")
                            .foregroundStyle(.primary)
                        Spacer()
                        if info.episode == episode {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var streamRows: some View {
        if loadingStreams {
            HStack {
                ProgressView()
                Text("Finding streams…")
                    .foregroundStyle(.secondary)
            }
        } else if streams.isEmpty {
            if streamsKey != nil {
                Text("No streams.")
                    .foregroundStyle(.secondary)
            }
        } else {
            ForEach(streams) { stream in
                Button {
                    Task { await start(stream) }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "play.circle.fill")
                            .font(.title2)
                            .foregroundStyle(Color.accentColor)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(stream.label)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                            let facts = Self.facts(stream)
                            if !facts.isEmpty {
                                Text(facts)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if starting == stream.index {
                            ProgressView()
                        }
                    }
                }
                .disabled(starting != nil)
                .accessibilityIdentifier("stream-\(stream.index)")
            }
        }
    }

    private static func facts(_ stream: Stream) -> String {
        let size = stream.sizeBytes.map { ByteCountFormatter.string(fromByteCount: Int64(clamping: $0), countStyle: .file) }
        return [stream.quality, stream.codec, stream.audio, size].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    // MARK: Loading

    private func loadDetails() async {
        guard details == nil else { return }
        do {
            var loaded = try await KinoCore.shared.details(id: title.id)
            remember(loaded.audio)
            // Several dubs: start on the TUI's default one, with its own id's details.
            if let preferred = loaded.preferredAudio, preferred.id != loaded.id {
                do {
                    loaded = try await KinoCore.shared.details(id: preferred.id)
                    remember(loaded.audio)
                } catch {
                    self.error = describe(error)
                }
            }
            show(loaded)
        } catch {
            self.error = describe(error)
        }
    }

    private func switchAudio(to track: AudioTrack) async {
        guard let current = details, track.id != current.id, switchingAudio == nil else { return }
        switchingAudio = track.id
        defer { switchingAudio = nil }
        do {
            let loaded = try await KinoCore.shared.details(id: track.id)
            remember(loaded.audio)
            show(loaded, keeping: (season: season, episode: episode))
        } catch {
            self.error = describe(error)
        }
    }

    private func remember(_ tracks: [AudioTrack]) {
        if !tracks.isEmpty {
            audio = tracks
        }
    }

    /// Shows a dub: the same episode if it has it (`keeping`), else its first one. Changing the
    /// details' id reloads the streams.
    private func show(_ loaded: Details, keeping: (season: Int, episode: Int)? = nil) {
        var chosen = (season: 0, episode: 0)
        if loaded.isSeries {
            if let keeping, loaded.seasons.contains(where: { $0.season == keeping.season && $0.episodes.contains { $0.episode == keeping.episode } }) {
                chosen = keeping
            } else if let first = loaded.seasons.first {
                chosen = (season: first.season, episode: first.episodes.first?.episode ?? 0)
            }
        }
        season = chosen.season
        episode = chosen.episode
        details = loaded
    }

    private func loadStreams() async {
        guard let details else { return }
        let key = "\(details.id)/\(season)/\(episode)"
        guard key != streamsKey else { return }
        streams = []
        streamsKey = nil
        if details.isSeries && episode == 0 {
            loadingStreams = false
            return
        }
        loadingStreams = true
        do {
            let list = try await KinoCore.shared.streams(id: details.id, season: season, episode: episode)
            guard !Task.isCancelled else { return }
            streams = list
            streamsKey = key
        } catch {
            guard !Task.isCancelled else { return }
            self.error = describe(error)
        }
        loadingStreams = false
    }

    private func start(_ stream: Stream) async {
        guard starting == nil, let details else { return }
        starting = stream.index
        defer { starting = nil }
        let request = PlayRequest(id: details.id, season: season, episode: episode, stream: stream.index)
        do {
            let play = try await KinoCore.shared.play(request)
            playing = Playing(request: request, play: play)
        } catch {
            self.error = describe(error)
        }
    }
}
