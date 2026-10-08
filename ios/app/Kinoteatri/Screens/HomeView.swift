// Home: the marquee (Kope's Kinoteatri), a search pill, then what the person has going: Continue
// watching (a tap plays on where it stopped), Favorites and Recently viewed. A new library gets a
// typographic welcome that points at Search. MovieBox has no home lists the core exposes, so Home is
// the person's own.

import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var library: LibraryStore
    @EnvironmentObject private var playback: PlaybackCenter
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 30) {
                    header
                    if isEmpty {
                        EmptyState(
                            systemImage: "popcorn",
                            title: L.homeEmptyTitle,
                            message: L.homeEmptyBody,
                            action: (L.startSearching, { app.openSearch() })
                        )
                        .padding(.top, 24)
                    } else {
                        if !library.continueWatching.isEmpty {
                            continueSection
                        }
                        if !library.favorites.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                SectionHeader(title: L.favorites, action: (L.seeAll, { app.openFavorites() }))
                                PosterRow(titles: library.favorites.map(\.title), idPrefix: "home-favorite") { path.append($0) }
                            }
                        }
                        if !recent.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                SectionHeader(title: L.recentlyViewed)
                                PosterRow(titles: recent, idPrefix: "home-recent") { path.append($0) }
                            }
                        }
                    }
                }
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .houseBackground()
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Title.self) { TitleDetailView(title: $0) }
        }
        .miniPlayerInset()
    }

    private var isEmpty: Bool {
        library.continueWatching.isEmpty && library.favorites.isEmpty && library.recentTitles.isEmpty
    }

    /// Opened titles that aren't already in the rows above.
    private var recent: [Title] {
        let shown = Set(library.favorites.map(\.id)).union(library.continueWatching.map(\.id))
        return Array(library.recentTitles.filter { !shown.contains($0.id) }.prefix(12))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(L.brandEyebrow)
                        .eyebrowFont()
                    Text(L.brandName)
                        .displayFont(.largeTitle)
                        .foregroundStyle(Theme.screen)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                Spacer()
                MarqueeBulbs()
                    .padding(.bottom, 10)
            }
            Button {
                app.openSearch()
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.body.weight(.semibold))
                    Text(L.searchPill)
                    Spacer()
                }
                .font(.body)
                .foregroundStyle(Theme.usher)
                .padding(.horizontal, 16)
                .frame(minHeight: 50)
                .background(
                    Capsule(style: .continuous)
                        .fill(Theme.velvet)
                        .overlay(Capsule(style: .continuous).strokeBorder(Theme.seam))
                )
            }
            .buttonStyle(PressableStyle(scale: 0.98))
            .accessibilityIdentifier("home-search")
        }
        .padding(.horizontal, Theme.gutter)
    }

    private var continueSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: L.continueWatching)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 12) {
                    ForEach(Array(library.continueWatching.enumerated()), id: \.element.id) { index, entry in
                        Button {
                            resume(entry)
                        } label: {
                            ContinueCard(entry: entry)
                        }
                        .buttonStyle(PressableStyle())
                        .disabled(playback.starting != nil)
                        .accessibilityIdentifier("continue-\(index)")
                        .contextMenu {
                            Button {
                                path.append(entry.title)
                            } label: {
                                Label(L.details, systemImage: "info.circle")
                            }
                            Button(role: .destructive) {
                                library.removeFromHistory(entry.id)
                            } label: {
                                Label(L.removeFromContinue, systemImage: "xmark.circle")
                            }
                        }
                    }
                }
                .padding(.horizontal, Theme.gutter)
            }
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
}

/// A short row of marquee bulbs, the desktop's signature, lit unevenly.
struct MarqueeBulbs: View {
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<6, id: \.self) { index in
                Circle()
                    .fill(Theme.bulb.opacity([1, 0.55, 0.85, 0.4, 0.75, 0.3][index]))
                    .frame(width: 5, height: 5)
                    .shadow(color: Theme.bulb.opacity(0.6), radius: 3)
            }
        }
        .accessibilityHidden(true)
    }
}
