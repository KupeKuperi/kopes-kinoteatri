// The building blocks of the screens: poster cards (grids and rows), the Continue watching card,
// section headers, empty and error states.

import SwiftUI

/// A title in a grid or a row: the poster (rating on it), the name, the year and kind.
struct PosterCard: View {
    let title: Title
    /// A progress bar along the poster's foot (0…1), for something part watched.
    var progress: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PosterArt(url: title.poster, title: title.title)
                .overlay(alignment: .topLeading) {
                    if let rating = title.rating, !rating.isEmpty {
                        RatingBadge(rating: rating)
                            .padding(6)
                    }
                }
                .overlay(alignment: .bottom) {
                    if let progress {
                        ProgressBar(value: progress)
                            .padding(.horizontal, 8)
                            .padding(.bottom, 8)
                    }
                }
                .shadow(color: .black.opacity(0.45), radius: 10, y: 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(title.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.screen)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(kindLine(year: title.year, kind: title.kind))
                    .font(.caption)
                    .foregroundStyle(Theme.usher)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.spoken(title))
    }

    /// "Inception, 2010, Movie, rated 8.8"
    static func spoken(_ title: Title) -> String {
        var parts = [title.title, kindLine(year: title.year, kind: title.kind)]
        if let rating = title.rating, !rating.isEmpty {
            parts.append("★ \(rating)")
        }
        return parts.joined(separator: ", ")
    }
}

struct RatingBadge: View {
    let rating: String

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "star.fill")
                .font(.system(size: 9, weight: .bold))
            Text(rating)
                .font(.caption2.weight(.bold))
                .monospacedDigit()
        }
        .foregroundStyle(Theme.bulb)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(.black.opacity(0.62), in: Capsule())
    }
}

struct ProgressBar: View {
    /// 0…1
    let value: Double
    var height: CGFloat = 4

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.22))
                Capsule().fill(Theme.bulb)
                    .frame(width: max(height, geo.size.width * min(1, max(0, value))))
            }
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityLabel(Text("\(Int((value * 100).rounded())) %"))
    }
}

/// Continue watching: the poster, the title, where it stands, a bar, and a play glyph. A tap plays
/// on from where it stopped.
struct ContinueCard: View {
    let entry: WatchEntry

    var body: some View {
        HStack(spacing: 12) {
            PosterArt(url: entry.title.poster, title: entry.title.title, cornerRadius: 10, maxPixels: 240)
                .frame(width: 66)
            VStack(alignment: .leading, spacing: 5) {
                Text(entry.title.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.screen)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(line)
                    .font(.caption)
                    .foregroundStyle(Theme.usher)
                    .lineLimit(1)
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    if let progress = entry.isFinished ? nil : entry.progress {
                        ProgressBar(value: progress, height: 3)
                    } else {
                        Spacer(minLength: 0)
                    }
                    Image(systemName: "play.fill")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(Theme.house)
                        .frame(width: 26, height: 26)
                        .background(Theme.bulb, in: Circle())
                }
            }
            .padding(.vertical, 4)
        }
        .padding(10)
        .frame(width: 280, height: 120)
        .background(
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .fill(Theme.velvet)
                .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).strokeBorder(Theme.seam))
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(entry.title.title), \(line)")
        .accessibilityHint(L.resume)
    }

    /// "S1 · E3 · 42 min left", "Up next: S1 E4", "1 h 5 min left".
    private var line: String {
        if entry.isFinished, let next = entry.next {
            return L.upNext(next.season, next.episode)
        }
        return [entry.episodeTag, Format.standing(entry)].compactMap { $0 }.joined(separator: " · ")
    }
}

/// "CONTINUE WATCHING ……… See all"
struct SectionHeader: View {
    let title: String
    var action: (label: String, run: () -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.title3.weight(.bold))
                .foregroundStyle(Theme.screen)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if let action {
                Button(action.label, action: action.run)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.bulb)
            }
        }
        .padding(.horizontal, Theme.gutter)
    }
}

/// Nothing here yet, said in words: a glyph, a heading, a line, maybe a button.
struct EmptyState: View {
    let systemImage: String
    let title: String
    let message: String
    var action: (label: String, run: () -> Void)?

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: systemImage)
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Theme.bulb)
                .padding(.bottom, 4)
                .accessibilityHidden(true)
            Text(title)
                .displayFont(.title2)
                .foregroundStyle(Theme.screen)
                .multilineTextAlignment(.center)
            Text(message)
                .font(.callout)
                .foregroundStyle(Theme.usher)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action.label, action: action.run)
                    .buttonStyle(PrimaryButtonStyle())
                    .frame(maxWidth: 260)
                    .padding(.top, 6)
            }
        }
        .padding(.horizontal, 36)
        .padding(.vertical, 28)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }
}

/// Something didn't load: what happened and Try again.
struct ErrorCard: View {
    let title: String
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(Theme.screen)
                .symbolRenderingMode(.multicolor)
            Text(message)
                .font(.callout)
                .foregroundStyle(Theme.usher)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: retry) {
                Label(L.tryAgain, systemImage: "arrow.clockwise")
                    .font(.subheadline.weight(.semibold))
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.bulb)
            .foregroundStyle(Theme.house)
            .accessibilityIdentifier("retry")
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .fill(Theme.velvet)
                .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).strokeBorder(Theme.err.opacity(0.35)))
        )
    }
}

/// A row of posters that scrolls sideways (Home's Favorites, Recently viewed).
struct PosterRow: View {
    let titles: [Title]
    /// Accessibility identifiers: "<prefix>-0", "<prefix>-1", …
    let idPrefix: String
    let open: (Title) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 14) {
                ForEach(Array(titles.enumerated()), id: \.element.id) { index, title in
                    Button {
                        open(title)
                    } label: {
                        PosterCard(title: title)
                            .frame(width: 124)
                    }
                    .buttonStyle(PressableStyle())
                    .accessibilityIdentifier("\(idPrefix)-\(index)")
                }
            }
            .padding(.horizontal, Theme.gutter)
        }
    }
}
