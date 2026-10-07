// About: the app's and the engine's versions, and "Copy diagnostics" (the recent events, to send
// along when a film won't play). Opened from the search screen's toolbar.

import SwiftUI
import UIKit

struct AboutView: View {
    let version: CoreVersion?

    @Environment(\.dismiss) private var dismiss
    @State private var copied = false
    @State private var recent: [String] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("App", value: Diagnostics.appVersion)
                    LabeledContent("Engine", value: engineLine)
                }
                Section {
                    Button {
                        copy()
                    } label: {
                        Label(copied ? "Copied" : "Copy diagnostics", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .accessibilityIdentifier("copy-diagnostics")
                } footer: {
                    Text("The last \(Diagnostics.capacity) events: requests to the engine, play sessions and the player's status. Never cookies, headers or stream addresses.")
                }
                if !recent.isEmpty {
                    Section("Recent events") {
                        Text(recent.suffix(40).joined(separator: "\n"))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("About")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("about-done")
                }
            }
            .onAppear { recent = Diagnostics.shared.lines }
        }
    }

    private var engineLine: String {
        guard let version else { return "…" }
        return "core \(version.core) · engine \(version.engine) · \(version.mode)"
    }

    private func copy() {
        UIPasteboard.general.string = Diagnostics.shared.text
        Diagnostics.shared.log("diagnostics copied (About)")
        copied = true
        recent = Diagnostics.shared.lines
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            copied = false
        }
    }
}
