import SwiftUI

/// Design tokens — the iOS mirror of `android/.../ui/theme/Theme.kt` (the Kotlin
/// `Pal` / `AppAccents` / `AppShapes` / `AppTypography`) and the repo-root
/// `DESIGN.md` "Notion — warm paper notebook" system. **Light only** — nothing
/// here branches on `colorScheme`.
enum Theme {
    // MARK: Canvas / surfaces
    static let canvas       = Color(hex: 0xF6F5F4)   // paper warmth — the app background
    static let surface      = Color.white            // card surface
    static let surfaceSunk  = Color(hex: 0xF1EFEE)   // chips / typing bubble / sunk fields
    static let surfaceHigh  = Color(hex: 0xEFEDEB)

    // MARK: Accent — the one chromatic commitment
    static let accent       = Color(hex: 0x0075DE)
    static let accentPress  = Color(hex: 0x005BA8)
    static let accentSoft   = Color(hex: 0xE6F3FE)   // ghost buttons, active nav, hovers
    static let accentInk    = Color(hex: 0x00457F)

    // MARK: Text (alpha hierarchy on black, + warm-cast body)
    static let text         = Color.black
    static let textStrong   = Color.black.opacity(0.95)
    static let textMuted    = Color.black.opacity(0.60)
    static let textFaint    = Color.black.opacity(0.40)
    static let textBody     = Color(hex: 0x615D59)

    // MARK: Border
    static let border       = Color.black.opacity(0.08)
    static let borderStrong = Color.black.opacity(0.16)

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
    static let bloomSky   = Color(hex: 0x60A8EC).opacity(0.40)
    static let bloomPeach = Color(hex: 0xFFB25A).opacity(0.32)
    static let bloomLilac = Color(hex: 0x8C7CE6).opacity(0.30)
    static let bloomMint  = Color(hex: 0x4A9678).opacity(0.22)

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
    func appHeadline() -> some View { self.font(.inter(26, .semibold)).tracking(-0.5) }
    func appTitle() -> some View { self.font(.inter(20, .semibold)).tracking(-0.3) }
    func appTitleSmall() -> some View { self.font(.inter(14, .semibold)) }
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
