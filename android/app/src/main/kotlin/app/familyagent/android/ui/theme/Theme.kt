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
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.familyagent.android.R

// The "Notion — warm paper notebook" system (see ../../../../../../DESIGN.md at
// the repo root). Light only — dark mode is deliberately not implemented.
// The desktop app (desktop/src/style.css) uses the identical token values.

// ---- Colours (DESIGN.md > Tokens — Colors) ----
private val PaperWarmth = Color(0xFFF6F5F4) // page canvas — the signature
private val PureWhite = Color(0xFFFFFFFF) // card surface
private val InkBlack = Color(0xFF000000)
private val Ink95 = Color(0xF2000000) // 95% — strong text
private val Ink60 = Color(0x99000000) // 60% — muted / secondary
private val Ink40 = Color(0x66000000) // 40% — faint
private val Graphite = Color(0xFF615D59) // warm-cast body copy
private val Border = Color(0x14000000) // rgba(0,0,0,0.08) — the one border
private val BorderStrong = Color(0x29000000) // rgba(0,0,0,0.16)
private val Surface2 = Color(0x0A000000) // rgba(0,0,0,0.04) — tinted wash

private val NotionBlue = Color(0xFF0075DE) // the single chromatic commitment
private val NotionBluePressed = Color(0xFF005BA8)
private val SkyTint = Color(0xFFE6F3FE) // ghost buttons, active nav, hovers
private val Marigold = Color(0xFFFFB110)
private val MarigoldTint = Color(0xFFFFEFD0)
private val Vermillion = Color(0xFFE32D14)
private val VermillionTint = Color(0xFFFDECEA)
private val Green = Color(0xFF448361) // "connected" — the doc has no green
private val GreenTint = Color(0xFFEDF3EF)

private val LightColors = lightColorScheme(
    primary = NotionBlue,
    onPrimary = PureWhite,
    primaryContainer = SkyTint,
    onPrimaryContainer = NotionBlue,
    secondary = NotionBlue,
    onSecondary = PureWhite,
    secondaryContainer = SkyTint,
    onSecondaryContainer = NotionBlue,
    tertiary = Green,
    onTertiary = PureWhite,
    tertiaryContainer = GreenTint,
    onTertiaryContainer = Green,
    background = PaperWarmth,
    onBackground = InkBlack,
    surface = PureWhite,
    onSurface = InkBlack,
    surfaceVariant = Surface2,
    onSurfaceVariant = Ink60,
    surfaceContainerLowest = PureWhite,
    surfaceContainerLow = PaperWarmth,
    surfaceContainer = PaperWarmth,
    surfaceContainerHigh = Surface2,
    surfaceContainerHighest = Surface2,
    outline = BorderStrong,
    outlineVariant = Border,
    error = Vermillion,
    onError = PureWhite,
    errorContainer = VermillionTint,
    onErrorContainer = Vermillion,
    scrim = Color(0x33000000),
)

// Extra accent tokens the Material scheme has no slot for — read directly.
object NotionAccents {
    val marigold = Marigold
    val marigoldTint = MarigoldTint
    val skyTint = SkyTint
    val graphite = Graphite
    val ink95 = Ink95
    val greenTint = GreenTint
    val greenText = Color(0xFF1C5C3F)
}

// DESIGN.md > Border Radius: cards 12, buttons 8, small 4, pills full.
private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(12.dp),
    extraLarge = RoundedCornerShape(12.dp),
)

// Inter — bundled locally (res/font/inter_variable.ttf). The DESIGN.md
// substitute for NotionInter: 400 body, 500 nav/UI, 600–700 headings.
@OptIn(ExperimentalTextApi::class)
private fun inter(weight: Int) =
    Font(R.font.inter_variable, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

private val Inter = FontFamily(inter(400), inter(500), inter(600), inter(700))

// Source Serif 4 — the DESIGN.md "Lyon Text" substitute, used sparingly for
// section subheads to give an editorial, paper-notebook voice.
@OptIn(ExperimentalTextApi::class)
val NotionSerif = FontFamily(
    Font(R.font.source_serif, FontWeight.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(400)))
)

// Negative tracking on the large sizes; body stays at normal tracking.
private val AppTypography = Typography(
    headlineLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 30.sp, lineHeight = 34.sp, letterSpacing = (-0.7).sp),
    headlineSmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 25.sp, lineHeight = 28.sp, letterSpacing = (-0.6).sp),
    titleLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 21.sp, lineHeight = 26.sp, letterSpacing = (-0.35).sp),
    titleMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp, letterSpacing = (-0.15).sp),
    bodyLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Normal, fontSize = 13.5.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 14.sp),
    labelMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 12.sp),
    labelSmall = TextStyle(fontFamily = Inter, fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.3.sp),
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
