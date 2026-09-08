package app.familyagent.android.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.familyagent.android.R

// The Android app now follows the repo-root `DESIGN.md` ("Notion — warm paper
// notebook") plus the desktop's Gemini-inspired atmosphere layer — same warm
// #f6f5f4 canvas, single #0075de blue accent, Inter, floating cards, an animated
// gradient canvas (see ui/Atmosphere.kt), glass chrome. This retired the earlier
// "Playful Color" system. **Light only** — no dark mode, matching desktop.
// See android/DESIGN.md and docs/DECISIONS.md → "Converging Android onto the
// desktop style".

// ---- Palette — mirrors desktop/src/style.css :root ------------------------
private object Pal {
    val bg = Color(0xFFF6F5F4)          // paper warmth — the canvas
    val surface = Color(0xFFFFFFFF)     // card surface
    val surfaceSunk = Color(0xFFF1EFEE) // chips / typing bubble / sunk fields
    val surfaceHigh = Color(0xFFEFEDEB)

    val accent = Color(0xFF0075DE)      // notion blue — the one chromatic commit
    val accentPress = Color(0xFF005BA8)
    val accentSoft = Color(0xFFE6F3FE)  // sky tint — ghost buttons, active nav, hovers
    val accentInk = Color(0xFF00457F)

    val text = Color(0xFF000000)
    val textStrong = Color(0xF2000000)  // 95%
    val textMuted = Color(0x99000000)   // 60%
    val textFaint = Color(0x66000000)   // 40%
    val textBody = Color(0xFF615D59)    // graphite — warm-cast body copy

    val border = Color(0x14000000)      // 8% black — the one border weight
    val borderStrong = Color(0x29000000) // 16%

    // Accent cast — decorative card / pill fills only, never buttons.
    val coral = Color(0xFFF64932)
    val marigold = Color(0xFFFFB110)
    val skyWash = Color(0xFF62AEF0)
    val midnight = Color(0xFF02093A)
    val peach = Color(0xFFF6D5B8)

    // Signals.
    val local = Color(0xFF448361)
    val localSoft = Color(0xFFEDF3EF)
    val warn = Color(0xFFCB912F)
    val warnSoft = Color(0xFFFAF3E8)
    val danger = Color(0xFFE32D14)      // vermillion
    val dangerSoft = Color(0xFFFDECEA)
    val dangerInk = Color(0xFF8A1C0C)
}

private val LightColors = lightColorScheme(
    primary = Pal.accent,
    onPrimary = Color.White,
    primaryContainer = Pal.accentSoft,
    onPrimaryContainer = Pal.accentInk,
    // Secondary defers to the same blue — the system is near-monochrome.
    secondary = Pal.accent,
    onSecondary = Color.White,
    secondaryContainer = Pal.accentSoft,
    onSecondaryContainer = Pal.accentInk,
    // Tertiary carries the "connected / ok" green.
    tertiary = Pal.local,
    onTertiary = Color.White,
    tertiaryContainer = Pal.localSoft,
    onTertiaryContainer = Color(0xFF1F5137),
    background = Pal.bg,
    onBackground = Pal.text,
    surface = Pal.surface,
    onSurface = Pal.text,
    surfaceVariant = Pal.surfaceSunk,
    onSurfaceVariant = Pal.textMuted,
    surfaceContainerLowest = Pal.surface,
    surfaceContainerLow = Pal.surface,
    surfaceContainer = Pal.surface,
    surfaceContainerHigh = Pal.bg,
    surfaceContainerHighest = Pal.surfaceHigh,
    outline = Pal.borderStrong,
    outlineVariant = Pal.border,
    error = Pal.danger,
    onError = Color.White,
    errorContainer = Pal.dangerSoft,
    onErrorContainer = Pal.dangerInk,
    scrim = Color(0x66000000),
)

/**
 * Accent tokens the Material scheme has no dedicated slot for. Plain vals —
 * the system is light-only, so nothing branches on theme.
 */
object AppAccents {
    val textSecondary: Color = Pal.textMuted
    val textBody: Color = Pal.textBody
    val border: Color = Pal.border
    // Decorative accent cast (used for the odd coloured fill, not buttons).
    val coral: Color = Pal.coral
    val marigold: Color = Pal.marigold
    val skyWash: Color = Pal.skyWash
    val peach: Color = Pal.peach
    // Back-compat aliases for call sites written against the old palette.
    val pink: Color = Pal.coral
    val cyan: Color = Pal.skyWash
    val cyanTint: Color = Pal.accentSoft
    val success: Color = Pal.local
    val successTint: Color = Pal.localSoft
    val warning: Color = Pal.warn

    // Animated-canvas blooms — mirror desktop --bloom-* (see Atmosphere.kt).
    // ARGB ints: ~0.18 sky, ~0.15 peach, ~0.13 lilac, ~0.10 mint.
    // Deliberately faint. These pool colour in the *corners*; the middle of the
    // screen stays `Pal.canvas`. At the old alphas (0.40/0.32/0.30/0.22) four
    // screen-wide blooms stacked into an opaque cool wash that buried the warm
    // paper entirely and left the accent nothing neutral to read against.
    val bloomSky: Color = Color(0x2E60A8EC)
    val bloomPeach: Color = Color(0x26FFB25A)
    val bloomLilac: Color = Color(0x218C7CE6)
    val bloomMint: Color = Color(0x1A4A9678)
}

// Shape — cards/sheets generously rounded, mirrors desktop --r-* (bumped for
// the atmosphere layer: buttons ~11, cards ~16, big panels ~22).
private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(26.dp),
)

// Inter — the DESIGN.md primary sans, bundled locally (res/font/inter_variable.ttf),
// no CDN. 400 body, 500 UI, 600–700 display. Source Serif for editorial subheads.
@OptIn(ExperimentalTextApi::class)
private fun inter(weight: Int) =
    Font(R.font.inter_variable, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

private val Inter = FontFamily(inter(400), inter(500), inter(600), inter(700))

/** Source Serif 4 — used sparingly, only for screen subtitles (the desktop
 *  `.view-sub` editorial voice). */
val SourceSerif = FontFamily(Font(R.font.source_serif, FontWeight.Normal))

// Mirrors the desktop type feel: Inter throughout, tight tracking on display
// sizes, body at 14–15 with 1.5 line-height.
private val AppTypography = Typography(
    headlineLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Bold, fontSize = 30.sp, lineHeight = 36.sp, letterSpacing = (-0.6).sp),
    headlineMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 26.sp, lineHeight = 31.sp, letterSpacing = (-0.5).sp),
    headlineSmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp, letterSpacing = (-0.4).sp),
    titleLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 20.sp, lineHeight = 26.sp, letterSpacing = (-0.3).sp),
    titleMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
    titleSmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
    bodyLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 19.sp),
    labelLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    labelMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 12.5.sp),
    labelSmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 11.5.sp, letterSpacing = 0.3.sp),
)

@Composable
fun FamilyAgentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightColors,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}
