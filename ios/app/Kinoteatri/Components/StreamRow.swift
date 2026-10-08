// A stream of a film or an episode: its quality as a badge, the release name, the facts (size,
// codec, audio), and a play glyph (or a spinner while it starts). The first is marked Best.

import SwiftUI

struct StreamRow: View {
    let stream: Stream
    var isBest = false
    var isStarting = false

    var body: some View {
        HStack(spacing: 14) {
            QualityBadge(quality: stream.quality, highlighted: isBest)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(stream.label)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.screen)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if isBest {
                        Text(L.best)
                            .font(.caption2.weight(.bold))
                            .textCase(.uppercase)
                            .foregroundStyle(Theme.bulb)
                    }
                }
                if !facts.isEmpty {
                    Text(facts)
                        .font(.caption)
                        .foregroundStyle(Theme.usher)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if isStarting {
                ProgressView()
                    .tint(Theme.bulb)
            } else {
                Image(systemName: "play.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Theme.house, Theme.bulb)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                .fill(Theme.velvet)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
                        .strokeBorder(isBest ? Theme.bulb.opacity(0.45) : Theme.seam)
                )
        )
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([L.play, stream.label, isBest ? L.best : nil, facts].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
    }

    /// "4.2 GB · HEVC · English"
    var facts: String {
        Format.facts(stream)
    }
}

/// "1080p" in a box; the best one lit.
struct QualityBadge: View {
    let quality: String?
    var highlighted = false

    var body: some View {
        Text(short)
            .font(.caption.weight(.heavy))
            .fontWidth(.condensed)
            .monospacedDigit()
            .foregroundStyle(highlighted ? Theme.house : Theme.screen)
            .frame(minWidth: 52, minHeight: 30)
            .padding(.horizontal, 4)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(highlighted ? Theme.bulb : Theme.curtain)
            )
    }

    private var short: String {
        guard let quality, !quality.isEmpty else { return "HD" }
        return quality.uppercased().replacingOccurrences(of: "P", with: "p")
    }
}
