// Search: a field, then the results (poster, title, year, kind); a result opens its title.

import SwiftUI

struct SearchView: View {
    @State private var query = ""
    @State private var results: [Title] = []
    @State private var searching = false
    /// The query the results are for (nil before the first search).
    @State private var searched: String?
    @State private var version: CoreVersion?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List(results) { title in
                NavigationLink(value: title) {
                    TitleRow(title: title)
                }
            }
            .listStyle(.plain)
            .overlay { placeholder }
            .navigationTitle("Kinoteatri")
            .navigationDestination(for: Title.self) { TitleView(title: $0) }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Films and series")
            .autocorrectionDisabled()
            .onSubmit(of: .search) { Task { await search() } }
            // Starts the core (Application Support/Kinoteatri) as the app opens.
            .task { version = try? await KinoCore.shared.version() }
            .errorAlert($error)
        }
    }

    @ViewBuilder private var placeholder: some View {
        if searching {
            ProgressView("Searching…")
        } else if results.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: searched == nil ? "film.stack" : "magnifyingglass")
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
                if let searched {
                    Text("Nothing found for “\(searched)”")
                        .foregroundStyle(.secondary)
                } else {
                    Text("Search for a film or a series")
                        .foregroundStyle(.secondary)
                }
                if let version {
                    Text("core \(version.core) · engine \(version.engine) · \(version.mode)")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                        .accessibilityIdentifier("core-version")
                }
            }
            .multilineTextAlignment(.center)
            .padding()
        }
    }

    private func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !searching else { return }
        searching = true
        defer { searching = false }
        do {
            results = try await KinoCore.shared.search(text)
            searched = text
        } catch {
            self.error = describe(error)
        }
    }
}

struct TitleRow: View {
    let title: Title

    var body: some View {
        HStack(spacing: 14) {
            PosterView(url: title.poster, width: 56)
            VStack(alignment: .leading, spacing: 4) {
                Text(title.title)
                    .font(.headline)
                    .lineLimit(2)
                Text(kindLine(year: title.year, kind: title.kind))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let rating = title.rating, !rating.isEmpty {
                    RatingView(rating: rating)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct RatingView: View {
    let rating: String

    var body: some View {
        Label(rating, systemImage: "star.fill")
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.accentColor)
    }
}

/// A poster (2:3) from its URL, or a film icon while there's none.
struct PosterView: View {
    let url: String?
    let width: CGFloat

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: width * 0.08, style: .continuous)
        ZStack {
            shape.fill(Color.white.opacity(0.08))
            if let url, let address = URL(string: url) {
                AsyncImage(url: address) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        filmIcon
                    }
                }
            } else {
                filmIcon
            }
        }
        .frame(width: width, height: width * 1.5)
        .clipShape(shape)
    }

    private var filmIcon: some View {
        Image(systemName: "film")
            .font(.system(size: width * 0.35))
            .foregroundStyle(.secondary)
    }
}
