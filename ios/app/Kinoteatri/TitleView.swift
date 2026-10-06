// A title: poster, facts, description; for a series a season picker and its episodes; then the
// streams of the film (or the chosen episode). A stream opens the player.

import SwiftUI

struct TitleView: View {
    let title: Title

    @State private var details: Details?
    @State private var season = 0
    @State private var episode = 0
    @State private var streams: [Stream] = []
    @State private var loadingStreams = false
    /// The season/episode the streams are for, so coming back from the player doesn't reload them.
    @State private var streamsKey: String?
    /// The stream being started.
    @State private var starting: Int?
    @State private var play: Play?
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
            if let details, details.isSeries, !details.seasons.isEmpty {
                episodesSection(details)
            }
            if let details {
                Section {
                    streamRows
                } header: {
                    Text(details.isSeries ? "Streams · S\(season) E\(episode)" : "Streams")
                }
                if !details.audio.isEmpty {
                    Section("Other audio") {
                        ForEach(details.audio) { track in
                            NavigationLink(value: Title(id: track.id, title: "\(details.title) · \(track.label)", year: details.year, kind: details.kind, poster: details.poster, rating: details.rating)) {
                                Label(track.label, systemImage: "speaker.wave.2")
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(title.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadDetails() }
        .task(id: "\(details?.id ?? "")/\(season)/\(episode)") { await loadStreams() }
        .fullScreenCover(item: $play) { PlayerView(play: $0) }
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
            let loaded = try await KinoCore.shared.details(id: title.id)
            // Together, so the streams load once, for the first episode of a series.
            if loaded.isSeries, let first = loaded.seasons.first {
                season = first.season
                episode = first.episodes.first?.episode ?? 0
            }
            details = loaded
        } catch {
            self.error = describe(error)
        }
    }

    private func loadStreams() async {
        guard let details else { return }
        let key = "\(season)/\(episode)"
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
        do {
            play = try await KinoCore.shared.play(id: details.id, season: season, episode: episode, stream: stream.index)
        } catch {
            self.error = describe(error)
        }
    }
}
