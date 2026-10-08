// Settings: how films play (landscape, which stream Play picks, subtitles and their language),
// CarPlay (connected or not, and what the car can do), the library (clear), and About: the app's and
// the engine's versions, "Copy diagnostics" (the recent events, to send along when a film won't
// play) and the events themselves.

import SwiftUI
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var app: AppModel
    @EnvironmentObject private var library: LibraryStore
    @AppStorage(Preferences.Key.landscapeLock) private var landscapeLock = Preferences.Default.landscapeLock
    @AppStorage(Preferences.Key.quality) private var quality = Preferences.Default.quality
    @AppStorage(Preferences.Key.subtitlesOn) private var subtitlesOn = Preferences.Default.subtitlesOn
    @AppStorage(Preferences.Key.subtitleLanguage) private var subtitleLanguage = Preferences.Default.subtitleLanguage
    @State private var copied = false
    @State private var confirmClear = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle(isOn: $landscapeLock) {
                        Label(L.landscapeLock, systemImage: "rotate.right")
                    }
                    .accessibilityIdentifier("landscape-lock")
                } header: {
                    Text(L.playback)
                } footer: {
                    Text(L.landscapeLockFooter)
                }
                .listRowBackground(Theme.velvet)

                Section {
                    Picker(selection: $quality) {
                        ForEach(PlayQuality.allCases) { option in
                            Text(option.label).tag(option.rawValue)
                        }
                    } label: {
                        Label(L.quality, systemImage: "4k.tv")
                    }
                } footer: {
                    Text(L.qualityFooter)
                }
                .listRowBackground(Theme.velvet)

                Section {
                    Toggle(isOn: $subtitlesOn) {
                        Label(L.subtitles, systemImage: "captions.bubble")
                    }
                    .accessibilityIdentifier("subtitles-setting")
                    Picker(selection: $subtitleLanguage) {
                        ForEach(SubtitleLanguages.all, id: \.name) { language in
                            Text(SubtitleLanguages.displayName(for: language.name)).tag(language.name)
                        }
                    } label: {
                        Label(L.subtitleLanguage, systemImage: "globe")
                    }
                    .pickerStyle(.navigationLink)
                    .disabled(!subtitlesOn)
                } footer: {
                    Text(L.subtitlesFooter)
                }
                .listRowBackground(Theme.velvet)

                Section {
                    HStack {
                        Label(L.carPlay, systemImage: "car.fill")
                        Spacer()
                        Text(app.carPlayConnected ? L.carConnected : L.carNotConnected)
                            .foregroundStyle(app.carPlayConnected ? Theme.ok : Theme.usher)
                    }
                    .accessibilityElement(children: .combine)
                } footer: {
                    Text(L.carPlayFooter)
                }
                .listRowBackground(Theme.velvet)

                Section {
                    Button(L.clearSearches) {
                        library.clearSearches()
                    }
                    .disabled(library.recentSearches.isEmpty)
                    Button(L.clearHistory, role: .destructive) {
                        confirmClear = true
                    }
                    .disabled(library.history.isEmpty)
                } header: {
                    Text(L.library)
                }
                .listRowBackground(Theme.velvet)

                Section {
                    HStack {
                        Text(L.app)
                        Spacer()
                        Text(Diagnostics.appVersion)
                            .foregroundStyle(Theme.usher)
                    }
                    HStack(alignment: .firstTextBaseline) {
                        Text(L.engine)
                        Spacer(minLength: 16)
                        Text(app.engineLine ?? (app.coreFailure == nil ? L.engineStarting : L.engineFailed))
                            .foregroundStyle(app.coreFailure == nil ? Theme.usher : Theme.err)
                            .multilineTextAlignment(.trailing)
                            .accessibilityIdentifier("core-version")
                    }
                    Button {
                        copy()
                    } label: {
                        Label(copied ? L.copied : L.copyDiagnostics, systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .accessibilityIdentifier("copy-diagnostics")
                    NavigationLink {
                        DiagnosticsView()
                    } label: {
                        Label(L.recentEvents, systemImage: "list.bullet.rectangle")
                    }
                } header: {
                    Text(L.about)
                } footer: {
                    Text(L.diagnosticsFooter(Diagnostics.capacity))
                }
                .listRowBackground(Theme.velvet)
            }
            .scrollContentBackground(.hidden)
            .houseBackground()
            .navigationTitle(L.settings)
            .confirmationDialog(L.clearHistory, isPresented: $confirmClear, titleVisibility: .visible) {
                Button(L.clearHistory, role: .destructive) {
                    library.clearHistory()
                }
            } message: {
                Text(L.clearHistoryConfirm)
            }
        }
        .miniPlayerInset()
    }

    private func copy() {
        UIPasteboard.general.string = Diagnostics.shared.text
        Diagnostics.shared.log("diagnostics copied (Settings)")
        copied = true
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            copied = false
        }
    }
}

/// The recent events (the diagnostics log), newest last; selectable.
struct DiagnosticsView: View {
    @State private var lines: [String] = []

    var body: some View {
        ScrollView {
            Text(lines.joined(separator: "\n"))
                .font(.caption2.monospaced())
                .foregroundStyle(Theme.usher)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.gutter)
        }
        .houseBackground()
        .navigationTitle(L.recentEvents)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    UIPasteboard.general.string = Diagnostics.shared.text
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .accessibilityLabel(L.copyDiagnostics)
            }
        }
        .onAppear { lines = Diagnostics.shared.lines }
    }
}
