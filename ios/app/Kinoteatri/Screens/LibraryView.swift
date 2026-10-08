// Library: History (everything played, where it stopped; Resume plays on, a swipe removes) and
// Favorites (a poster grid). Kept on the phone; the car's lists show the same.

import SwiftUI

struct LibraryView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var playback: PlaybackCenter
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                Picker(L.library, selection: $app.libraryShowsFavorites) {
                    Text(L.history).tag(false)
                    Text(L.favorites).tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, Theme.gutter)
                .padding(.vertical, 10)
                .onChange(of: app.libraryShowsFavorites) { _ in Haptics.select() }

                if app.libraryShowsFavorites {
                    favorites
                } else {
                    history
                }
            }
            .houseBackground()
            .navigationTitle(L.library)
            .navigationDestination(for: Title.self) { TitleDetailView(title: $0) }
        }
        .miniPlayerInset()
    }

    // MARK: History

    @ViewBuilder private var history: some View {
        if library.history.isEmpty {
            ScrollView {
                EmptyState(systemImage: "clock.arrow.circlepath", title: L.historyEmptyTitle, message: L.historyEmptyBody)
                    .padding(.top, 60)
            }
        } else {
            List {
                ForEach(library.history) { entry in
                    HistoryRow(entry: entry, starting: playback.starting != nil) {
                        resume(entry)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { path.append(entry.title) }
                    .accessibilityAddTraits(.isButton)
                    .listRowBackground(Theme.house)
                    .listRowSeparatorTint(Theme.seam)
                    .listRowInsets(EdgeInsets(top: 10, leading: Theme.gutter, bottom: 10, trailing: Theme.gutter))
                    .swipeActions {
                        Button(role: .destructive) {
                            library.removeFromHistory(entry.id)
                        } label: {
                            Label(L.remove, systemImage: "trash")
                        }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    private func resume(_ entry: WatchEntry) {
        Haptics.play()
        Task {
            do {
                try await playback.resume(entry, from: .phone)
            } catch {
                Haptics.failure()
                playback.failure = describe(error)
            }
        }
    }

    // MARK: Favorites

    @ViewBuilder private var favorites: some View {
        ScrollView {
            if library.favorites.isEmpty {
                EmptyState(systemImage: "heart", title: L.favoritesEmptyTitle, message: L.favoritesEmptyBody)
                    .padding(.top, 60)
            } else {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 104, maximum: 190), spacing: 14, alignment: .top)],
                    alignment: .leading,
                    spacing: 22
                ) {
                    ForEach(Array(library.favorites.enumerated()), id: \.element.id) { index, favorite in
                        Button {
                            path.append(favorite.title)
                        } label: {
                            PosterCard(title: favorite.title)
                        }
                        .buttonStyle(PressableStyle())
                        .accessibilityIdentifier("library-favorite-\(index)")
                        .contextMenu {
                            Button(role: .destructive) {
                                library.toggleFavorite(favorite.title)
                            } label: {
                                Label(L.removeFavorite, systemImage: "heart.slash")
                            }
                        }
                    }
                }
                .padding(.horizontal, Theme.gutter)
                .padding(.vertical, 8)
            }
        }
    }
}

/// A watched title: poster, name, the episode and where it stands, when, a bar; Resume.
struct HistoryRow: View {
    let entry: WatchEntry
    let starting: Bool
    let resume: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            PosterArt(url: entry.title.poster, title: entry.title.title, cornerRadius: 8, maxPixels: 200)
                .frame(width: 54)
            VStack(alignment: .leading, spacing: 5) {
                Text(entry.title.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.screen)
                    .lineLimit(2)
                Text([entry.episodeTag, Format.standing(entry)].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(Theme.usher)
                    .lineLimit(1)
                Text(Format.ago(entry.updated))
                    .font(.caption2)
                    .foregroundStyle(Theme.dim)
                if let progress = entry.progress, !entry.isFinished, entry.position >= 5 {
                    ProgressBar(value: progress, height: 3)
                        .frame(maxWidth: 160)
                }
            }
            Spacer(minLength: 8)
            Button(action: resume) {
                Image(systemName: "play.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Theme.house)
                    .frame(width: 40, height: 40)
                    .background(Theme.bulb, in: Circle())
            }
            .buttonStyle(.borderless)
            .disabled(starting)
            .accessibilityLabel("\(L.resume) \(entry.title.title)")
        }
    }
}
