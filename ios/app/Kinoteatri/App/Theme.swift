// The look, as on the desktop app ("house lights down"): the room is deep velvet, text is warm
// silver, and the only light is the marquee bulb (the accent). Type is the system's, so Dynamic
// Type works everywhere; display titles are heavy and condensed like the desktop's marquee font.

import SwiftUI

enum Theme {
    // MARK: Colors (desktop styles.css)

    /// The background.
    static let house = Color(hex: 0x160D12)
    /// Cards and rows.
    static let velvet = Color(hex: 0x20141B)
    /// Raised things on cards: chips, skeletons.
    static let curtain = Color(hex: 0x2C1B25)
    /// Hairlines and borders.
    static let seam = Color(hex: 0x3D2833)
    /// Main text.
    static let screen = Color(hex: 0xF4EADF)
    /// Secondary text (6:1 on house).
    static let usher = Color(hex: 0xA8939C)
    /// Tertiary text, never alone for something that matters.
    static let dim = Color(hex: 0x75636C)
    /// The accent: buttons, ratings, progress.
    static let bulb = Color(hex: 0xFFC65C)
    static let bulbDeep = Color(hex: 0xE0A43A)
    static let ok = Color(hex: 0x7ED6A0)
    static let err = Color(hex: 0xFF7A6B)

    // MARK: Metrics

    /// The side margin of every screen.
    static let gutter: CGFloat = 20
    /// Posters are 2:3.
    static let posterAspect: CGFloat = 2.0 / 3.0
    static let posterRadius: CGFloat = 12
    static let cardRadius: CGFloat = 16
    /// The tallest a primary button gets before Dynamic Type grows it.
    static let buttonHeight: CGFloat = 52
}

extension Color {
    /// 0xRRGGBB, sRGB.
    init(hex: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// MARK: Type

extension View {
    /// The marquee: big, heavy, condensed (screen titles, the title of a film).
    func displayFont(_ style: Font.TextStyle = .largeTitle) -> some View {
        font(.system(style).weight(.heavy)).fontWidth(.condensed)
    }

    /// A small label over a section: "CONTINUE WATCHING".
    func eyebrowFont() -> some View {
        font(.caption.weight(.semibold)).textCase(.uppercase).tracking(1.4).foregroundStyle(Theme.usher)
    }

    /// Facts like "2010 · Movie · 2h 28m".
    func metaFont() -> some View {
        font(.subheadline).foregroundStyle(Theme.usher)
    }

    /// The screen's background, edge to edge.
    func houseBackground() -> some View {
        background(Theme.house.ignoresSafeArea())
    }
}

// MARK: Buttons

/// Things that look tappable shrink a little while pressed (not with Reduce Motion).
struct PressableStyle: ButtonStyle {
    var scale: CGFloat = 0.96

    func makeBody(configuration: Configuration) -> some View {
        PressableBody(configuration: configuration, scale: scale)
    }

    private struct PressableBody: View {
        let configuration: ButtonStyleConfiguration
        let scale: CGFloat
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
                .opacity(configuration.isPressed ? 0.82 : 1)
                .animation(.spring(response: 0.25, dampingFraction: 0.75), value: configuration.isPressed)
        }
    }
}

/// The one big action of a screen (Play): the bulb, dark text.
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PrimaryBody(configuration: configuration)
    }

    private struct PrimaryBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .font(.headline)
                .foregroundStyle(Theme.house)
                .frame(maxWidth: .infinity, minHeight: Theme.buttonHeight)
                .padding(.horizontal, 16)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(isEnabled ? Theme.bulb : Theme.curtain)
                )
                .shadow(color: Theme.bulb.opacity(isEnabled ? 0.28 : 0), radius: 16, y: 6)
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
                .opacity(configuration.isPressed ? 0.88 : 1)
                .animation(.spring(response: 0.25, dampingFraction: 0.75), value: configuration.isPressed)
        }
    }
}

/// A quieter button beside the primary one (Favorite): a velvet tile.
struct TileButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        TileBody(configuration: configuration)
    }

    private struct TileBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            configuration.label
                .font(.headline)
                .foregroundStyle(Theme.screen)
                .frame(minWidth: Theme.buttonHeight, minHeight: Theme.buttonHeight)
                .padding(.horizontal, 4)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Theme.velvet)
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.seam))
                )
                .scaleEffect(configuration.isPressed && !reduceMotion ? 0.94 : 1)
                .animation(.spring(response: 0.25, dampingFraction: 0.75), value: configuration.isPressed)
        }
    }
}

/// A chip (dubs, seasons, filters): filled when selected.
struct Chip: View {
    let text: String
    var selected = false
    var systemImage: String?

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.caption.weight(.bold))
            }
            Text(text)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(selected ? Theme.house : Theme.screen)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(
            Capsule(style: .continuous)
                .fill(selected ? Theme.bulb : Theme.velvet)
                .overlay(Capsule(style: .continuous).strokeBorder(selected ? Color.clear : Theme.seam))
        )
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
