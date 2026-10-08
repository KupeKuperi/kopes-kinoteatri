// Loading placeholders in the shape of what's coming (a poster grid, a row, lines of text), with a
// slow light sweeping across them, like the desktop's shimmer. Still with Reduce Motion.

import SwiftUI

struct Shimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        content
            .overlay {
                if !reduceMotion {
                    GeometryReader { geo in
                        let width = max(geo.size.width, 1)
                        LinearGradient(
                            colors: [.clear, Color.white.opacity(0.07), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: width * 0.7)
                        .offset(x: phase * width * 1.35)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                }
            }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 1.5).repeatForever(autoreverses: false)) {
                    phase = 1
                }
            }
    }
}

extension View {
    func shimmer() -> some View {
        modifier(Shimmer())
    }
}

/// A block of the placeholder color, shimmering.
struct SkeletonBlock: View {
    var cornerRadius: CGFloat = 8

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Theme.curtain)
            .shimmer()
            .accessibilityHidden(true)
    }
}

/// A poster card on its way: the poster, a title line, a shorter facts line.
struct SkeletonPosterCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SkeletonBlock(cornerRadius: Theme.posterRadius)
                .aspectRatio(Theme.posterAspect, contentMode: .fit)
            SkeletonBlock(cornerRadius: 4)
                .frame(height: 12)
            SkeletonBlock(cornerRadius: 4)
                .frame(width: 56, height: 10)
        }
    }
}

/// A list row on its way (a stream, an episode).
struct SkeletonRow: View {
    var body: some View {
        HStack(spacing: 14) {
            SkeletonBlock(cornerRadius: 8)
                .frame(width: 56, height: 32)
            VStack(alignment: .leading, spacing: 8) {
                SkeletonBlock(cornerRadius: 4)
                    .frame(height: 12)
                SkeletonBlock(cornerRadius: 4)
                    .frame(width: 140, height: 10)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.velvet))
        .accessibilityHidden(true)
    }
}
