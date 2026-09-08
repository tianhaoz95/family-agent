import SwiftUI

/// Design tokens — the iOS mirror of `android/.../ui/theme/Theme.kt` (the Kotlin
/// `Pal` / `AppAccents` / `AppShapes` / `AppTypography`) and the repo-root
/// `DESIGN.md` "Notion — warm paper notebook" system. **Light only** — nothing
/// here branches on `colorScheme`.
enum Theme {
    // MARK: Canvas / surfaces
    static let canvas       = Color(hex: 0xF6F5F4)   // paper warmth — the app background
    /// Card surface. Paper-white, not pure white: a card and the canvas should read
    /// as the same material, one lifted off the other.
    static let surface      = Color(hex: 0xFCFBFA)
    static let surfaceSunk  = Color(hex: 0xF1EFEE)   // chips / typing bubble / sunk fields
    static let surfaceHigh  = Color(hex: 0xEFEDEB)

    // MARK: Accent — the one chromatic commitment
    /// The filled accent. Rationed: at most ONE filled `.primary` pill per screen
    /// (DESIGN.md). Secondary actions use `accentInk` on `accentSoft`, or plain ink.
    static let accent       = Color(hex: 0x0075DE)
    static let accentPress  = Color(hex: 0x005BA8)
    static let accentSoft   = Color(hex: 0xE6F3FE)   // ghost buttons, active nav, hovers
    /// The quiet accent — deep enough to sit beside warm ink without shouting.
    /// Used for every accent-coloured *glyph* and secondary label.
    static let accentInk    = Color(hex: 0x00457F)

    // MARK: Text — warm ink, not pure black.
    // The canvas, cards and shadows are all warm; a cool `Color.black` fought them
    // and made type read as pixels-on-glass rather than ink-on-paper.
    static let ink          = Color(hex: 0x1E1B18)
    static let text         = ink
    static let textStrong   = ink.opacity(0.95)
    static let textMuted    = ink.opacity(0.58)
    static let textFaint    = ink.opacity(0.38)
    static let textBody     = Color(hex: 0x615D59)

    // MARK: Border — warm hairline, same reason as the ink above.
    // Carries more of the card's definition now that the ground is pale paper
    // rather than a dark wash (a shadow alone barely registers against it).
    static let border       = Color(hex: 0x2A2420).opacity(0.13)
    static let borderStrong = Color(hex: 0x2A2420).opacity(0.20)

    // MARK: Decorative accent cast (coloured fills / pills only, never buttons)
    static let coral    = Color(hex: 0xF64932)
    static let marigold = Color(hex: 0xFFB110)
    static let skyWash  = Color(hex: 0x62AEF0)
    static let midnight = Color(hex: 0x02093A)
    static let peach    = Color(hex: 0xF6D5B8)

    // MARK: Signals
    static let ok         = Color(hex: 0x448361)
    static let okSoft     = Color(hex: 0xEDF3EF)
    static let warn       = Color(hex: 0xCB912F)
    static let warnSoft   = Color(hex: 0xFAF3E8)
    static let danger     = Color(hex: 0xE32D14)
    static let dangerSoft = Color(hex: 0xFDECEA)
    static let dangerInk  = Color(hex: 0x8A1C0C)

    // MARK: Atmosphere blooms (mirror AppAccents.bloom* — ARGB alpha baked in)
    // Deliberately faint. These pool colour in the *corners*; the middle of the
    // screen stays `canvas`. At the old alphas (.40/.32/.30/.22) four screen-wide
    // blooms stacked into an opaque cool wash that buried the warm paper entirely
    // and left the saturated accent with nothing neutral to read against.
    static let bloomSky   = Color(hex: 0x60A8EC).opacity(0.18)
    static let bloomPeach = Color(hex: 0xFFB25A).opacity(0.15)
    static let bloomLilac = Color(hex: 0x8C7CE6).opacity(0.13)
    static let bloomMint  = Color(hex: 0x4A9678).opacity(0.10)

    // MARK: Radii (AppShapes: 8 / 12 / 16 / 20 / 26)
    enum R {
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 20
        static let xl: CGFloat = 26
    }

    // MARK: Spacing (DESIGN.md 4px base)
    enum S {
        static let x4: CGFloat = 4
        static let x8: CGFloat = 8
        static let x12: CGFloat = 12
        static let x16: CGFloat = 16
        static let x20: CGFloat = 20
        static let x24: CGFloat = 24
        static let x32: CGFloat = 32
    }

    // MARK: Elevation — soft, warm-tinted shadows (the atmosphere-layer float)
    struct Shadow {
        let color: Color
        let radius: CGFloat
        let y: CGFloat
    }
    enum E {
        /// Resting card lift. Short and warm — a sheet of paper sitting on paper,
        /// not a pane of glass floating over a gradient.
        static let card = Shadow(color: Color(hex: 0x2A2420).opacity(0.08), radius: 12, y: 5)
        /// Pressed / smaller elements.
        static let sm = Shadow(color: Color(hex: 0x2A2420).opacity(0.06), radius: 7, y: 3)
        /// Menus, sheets, the composer, floating buttons.
        static let pop = Shadow(color: Color(hex: 0x2A2420).opacity(0.13), radius: 20, y: 9)
    }

    // Sticky-note swatches (BoardScreen NOTE_COLORS).
    static func noteColor(_ name: String) -> Color {
        switch name {
        case "mint":  return Color(hex: 0xD8EDE0)
        case "sky":   return Color(hex: 0xDBE8F6)
        case "blush": return Color(hex: 0xF6DFE4)
        case "lilac": return Color(hex: 0xE6E0F2)
        default:      return Color(hex: 0xFDF1C4)   // butter
        }
    }
    static let noteNames = ["butter", "mint", "sky", "blush", "lilac"]
}

// MARK: - Fonts

extension Font {
    /// Inter — the DESIGN.md primary sans (bundled `Inter-Variable.ttf`).
    static func inter(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("Inter", size: size).weight(weight)
    }
    /// Source Serif 4 — used only for `ScreenScaffold` subtitles (the editorial voice).
    static func serif(_ size: CGFloat) -> Font {
        .custom("Source Serif 4", size: size)
    }
}

// MARK: - Text style helpers (mirror AppTypography)

extension View {
    /// Apply one of the `Theme.E` elevation tokens.
    func elevation(_ s: Theme.Shadow) -> some View {
        self.shadow(color: s.color, radius: s.radius, x: 0, y: s.y)
    }
    func appHeadline() -> some View { self.font(.inter(30, .bold)).tracking(-0.9) }
    func appTitle() -> some View { self.font(.inter(19, .semibold)).tracking(-0.35) }
    func appTitleSmall() -> some View { self.font(.inter(14.5, .semibold)).tracking(-0.1) }
    func appBody() -> some View { self.font(.inter(15)) }
    func appBodySmall() -> some View { self.font(.inter(13)) }
    func appLabel() -> some View { self.font(.inter(12.5, .medium)) }
    func appLabelSmall() -> some View { self.font(.inter(11.5, .semibold)).tracking(0.3) }
}

// MARK: - Color(hex:)

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue:  Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
