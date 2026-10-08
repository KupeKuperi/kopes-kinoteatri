// The app's frame: four tabs (Home, Search, Library, Settings), the mini player over the tab bar
// while something plays without the full-screen player, the "Starting…" card while the core
// resolves a play, and the alert when a play doesn't start.

import SwiftUI

struct RootView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var playback: PlaybackCenter
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $app.tab) {
            HomeView()
                .tabItem { Label(L.home, systemImage: "house.fill") }
                .tag(AppTab.home)
            SearchView(store: app.search)
                .tabItem { Label(L.search, systemImage: "magnifyingglass") }
                .tag(AppTab.search)
            LibraryView()
                .tabItem { Label(L.library, systemImage: "rectangle.stack.fill") }
                .tag(AppTab.library)
            SettingsView()
                .tabItem { Label(L.settings, systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
        .overlay {
            if let starting = playback.starting {
                StartingOverlay(info: starting, subtitles: Preferences.subtitles) {
                    playback.cancelStarting()
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: playback.starting)
        .errorAlert($playback.failure, title: L.couldNotPlay)
        .task { await app.startCore() }
        .onChange(of: scenePhase) { phase in
            if phase == .background {
                app.library.saveNow()
            }
        }
    }
}

/// While the core resolves a play (up to ~15 s more when it looks for subtitles): the poster,
/// what's starting, and Cancel.
struct StartingOverlay: View {
    let info: PlayInfo
    let subtitles: String?
    let cancel: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.6)
                .ignoresSafeArea()
            VStack(spacing: 14) {
                PosterArt(url: info.title.poster, title: info.title.title, maxPixels: 300)
                    .frame(width: 92)
                    .shadow(color: .black.opacity(0.5), radius: 16, y: 8)
                ProgressView()
                    .tint(Theme.bulb)
                    .padding(.top, 4)
                Text(L.starting)
                    .font(.headline)
                    .foregroundStyle(Theme.screen)
                VStack(spacing: 2) {
                    Text(info.title.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.screen)
                    if info.isEpisode {
                        Text(info.subtitleLine)
                            .font(.caption)
                            .foregroundStyle(Theme.usher)
                    }
                }
                .multilineTextAlignment(.center)
                .lineLimit(2)
                if let subtitles {
                    Text(L.lookingForSubtitles(SubtitleLanguages.displayName(for: subtitles)))
                        .font(.caption)
                        .foregroundStyle(Theme.usher)
                }
                Button(L.cancel, action: cancel)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.bulb)
                    .padding(.top, 4)
                    .accessibilityIdentifier("starting-cancel")
            }
            .padding(24)
            .frame(maxWidth: 300)
            .background(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(Theme.velvet)
                    .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Theme.seam))
            )
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("starting")
        }
    }
}

/// What plays, over the tab bar, when the full-screen player isn't up (a play from the car, the
/// player closed while the car plays): poster, title, play/pause, stop. A tap opens the player.
struct MiniPlayerBar: View {
    @EnvironmentObject private var playback: PlaybackCenter

    var body: some View {
        if let info = playback.info, playback.showsMiniPlayer {
            HStack(spacing: 12) {
                Group {
                    if let artwork = playback.artwork {
                        Image(uiImage: artwork)
                            .resizable()
                            .scaledToFill()
                    } else {
                        Theme.curtain
                    }
                }
                .frame(width: 36, height: 54)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(info.title.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.screen)
                        .lineLimit(1)
                    Text(info.subtitleLine)
                        .font(.caption)
                        .foregroundStyle(Theme.usher)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Button {
                    playback.togglePlayPause()
                } label: {
                    Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title3)
                        .foregroundStyle(Theme.screen)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(playback.isPlaying ? L.pause : L.resume)
                Button {
                    playback.stop()
                } label: {
                    Image(systemName: "xmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.usher)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(L.stop)
            }
            .padding(.leading, 10)
            .padding(.trailing, 4)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Theme.velvet)
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.seam))
                    .shadow(color: .black.opacity(0.45), radius: 18, y: 6)
            )
            .contentShape(Rectangle())
            .onTapGesture { _ = playback.showPlayer() }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("\(L.nowPlaying): \(info.title.title)")
            .accessibilityAction(named: Text(L.openPlayer)) { _ = playback.showPlayer() }
            .accessibilityIdentifier("mini-player")
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

extension View {
    /// Room for the mini player at the bottom of a tab, over its content.
    func miniPlayerInset() -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            MiniPlayerBar()
        }
    }
}
