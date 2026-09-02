package app.familyagent.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
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

// "Playful Color Mobile Design System" (see android/DESIGN.md). Vibrant,
// friendly, rounded — colour is the primary communication tool. Light is the
// primary mode; a full dark mode ships alongside it.

// ---- Palette (DESIGN.md §2) ------------------------------------------------
private object Pal {
    // Light
    val indigo = Color(0xFF6366F1)
    val indigoInk = Color(0xFF3730A3)
    val indigoTint = Color(0xFFE0E7FF)
    val pink = Color(0xFFF472B6)
    val pinkInk = Color(0xFF9D174D)
    val pinkTint = Color(0xFFFCE7F3)
    val cyan = Color(0xFF22D3EE)
    val cyanInk = Color(0xFF155E75)
    val cyanTint = Color(0xFFCFFAFE)
    val bg = Color(0xFFFFFFFF)
    val surface = Color(0xFFF8FAFC)
    val surfaceAlt = Color(0xFFEEF2FF)
    val textPrimary = Color(0xFF0F172A)
    val textSecondary = Color(0xFF64748B)
    val border = Color(0xFFE2E8F0)
    val borderStrong = Color(0xFFCBD5E1)
    val success = Color(0xFF22C55E)
    val successTint = Color(0xFFDCFCE7)
    val warning = Color(0xFFF59E0B)
    val error = Color(0xFFEF4444)
    val errorTint = Color(0xFFFEE2E2)
    val errorInk = Color(0xFF991B1B)

    // Dark
    val dIndigo = Color(0xFF818CF8)
    val dIndigoTint = Color(0xFF312E81)
    val dPink = Color(0xFFF9A8D4)
    val dPinkTint = Color(0xFF831843)
    val dCyan = Color(0xFF67E8F9)
    val dCyanTint = Color(0xFF164E63)
    val dBg = Color(0xFF0B0F14)
    val dSurface = Color(0xFF111827)
    val dSurfaceAlt = Color(0xFF1F2937)
    val dSurfaceHigh = Color(0xFF273244)
    val dTextPrimary = Color(0xFFF8FAFC)
    val dTextSecondary = Color(0xFF94A3B8)
    val dBorder = Color(0xFF1F2937)
    val dBorderStrong = Color(0xFF334155)
    val dSuccess = Color(0xFF4ADE80)
    val dWarning = Color(0xFFFBBF24)
    val dError = Color(0xFFF87171)
    val dErrorTint = Color(0xFF7F1D1D)
}

private val LightColors = lightColorScheme(
    primary = Pal.indigo,
    onPrimary = Color.White,
    primaryContainer = Pal.indigoTint,
    onPrimaryContainer = Pal.indigoInk,
    secondary = Pal.pink,
    onSecondary = Color.White,
    secondaryContainer = Pal.pinkTint,
    onSecondaryContainer = Pal.pinkInk,
    tertiary = Pal.cyan,
    onTertiary = Color(0xFF05323B),
    tertiaryContainer = Pal.cyanTint,
    onTertiaryContainer = Pal.cyanInk,
    background = Pal.bg,
    onBackground = Pal.textPrimary,
    surface = Pal.bg,
    onSurface = Pal.textPrimary,
    surfaceVariant = Pal.surfaceAlt,
    onSurfaceVariant = Pal.textSecondary,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Pal.surface,
    surfaceContainer = Pal.surface,
    surfaceContainerHigh = Pal.surfaceAlt,
    surfaceContainerHighest = Pal.border,
    outline = Pal.borderStrong,
    outlineVariant = Pal.border,
    error = Pal.error,
    onError = Color.White,
    errorContainer = Pal.errorTint,
    onErrorContainer = Pal.errorInk,
    scrim = Color(0x660F172A),
)

private val DarkColors = darkColorScheme(
    primary = Pal.dIndigo,
    onPrimary = Color(0xFF1E1B4B),
    primaryContainer = Pal.dIndigoTint,
    onPrimaryContainer = Color(0xFFE0E7FF),
    secondary = Pal.dPink,
    onSecondary = Color(0xFF500724),
    secondaryContainer = Pal.dPinkTint,
    onSecondaryContainer = Color(0xFFFCE7F3),
    tertiary = Pal.dCyan,
    onTertiary = Color(0xFF06323B),
    tertiaryContainer = Pal.dCyanTint,
    onTertiaryContainer = Color(0xFFCFFAFE),
    background = Pal.dBg,
    onBackground = Pal.dTextPrimary,
    surface = Pal.dSurface,
    onSurface = Pal.dTextPrimary,
    surfaceVariant = Pal.dSurfaceAlt,
    onSurfaceVariant = Pal.dTextSecondary,
    surfaceContainerLowest = Pal.dBg,
    surfaceContainerLow = Pal.dSurface,
    surfaceContainer = Pal.dSurfaceAlt,
    surfaceContainerHigh = Pal.dSurfaceHigh,
    surfaceContainerHighest = Pal.dBorderStrong,
    outline = Pal.dBorderStrong,
    outlineVariant = Pal.dBorder,
    error = Pal.dError,
    onError = Color(0xFF450A0A),
    errorContainer = Pal.dErrorTint,
    onErrorContainer = Color(0xFFFEE2E2),
    scrim = Color(0x99000000),
)

/**
 * Accent tokens the Material scheme has no dedicated slot for. Each resolves
 * per theme so callers don't branch on dark mode themselves.
 */
object AppAccents {
    val pink: Color @Composable get() = if (isSystemInDarkTheme()) Pal.dPink else Pal.pink
    val pinkTint: Color @Composable get() = if (isSystemInDarkTheme()) Pal.dPinkTint else Pal.pinkTint
    val cyan: Color @Composable get() = if (isSystemInDarkTheme()) Pal.dCyan else Pal.cyan
    val cyanTint: Color @Composable get() = if (isSystemInDarkTheme()) Pal.dCyanTint else Pal.cyanTint
    val success: Color @Composable get() = if (isSystemInDarkTheme()) Pal.dSuccess else Pal.success
    val successTint: Color @Composable get() = if (isSystemInDarkTheme()) Pal.dCyanTint else Pal.successTint
    val warning: Color @Composable get() = if (isSystemInDarkTheme()) Pal.dWarning else Pal.warning
    val textSecondary: Color @Composable get() = if (isSystemInDarkTheme()) Pal.dTextSecondary else Pal.textSecondary
}

// DESIGN.md §8: buttons/cards 16–20, inputs 14–18 — generously rounded.
private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(10.dp),
    small = RoundedCornerShape(14.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

// Nunito — the DESIGN.md "rounded font" option (§3). Bundled locally
// (res/font/nunito_variable.ttf), no CDN. 400 body, 600 UI, 700–800 display.
@OptIn(ExperimentalTextApi::class)
private fun nunito(weight: Int) =
    Font(R.font.nunito_variable, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

private val Nunito = FontFamily(nunito(400), nunito(500), nunito(600), nunito(700), nunito(800))

// DESIGN.md §3: friendly, slightly larger, line-height 1.5–1.6, bold for
// emphasis. Large Title 30/Bold · Title 22/SemiBold · Body 16 · Caption 13 ·
// Small 11/Medium.
private val AppTypography = Typography(
    headlineLarge = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.ExtraBold, fontSize = 34.sp, lineHeight = 40.sp, letterSpacing = (-0.5).sp),
    headlineMedium = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.ExtraBold, fontSize = 30.sp, lineHeight = 37.sp, letterSpacing = (-0.4).sp),
    headlineSmall = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.Bold, fontSize = 25.sp, lineHeight = 32.sp, letterSpacing = (-0.3).sp),
    titleLarge = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 29.sp, letterSpacing = (-0.2).sp),
    titleMedium = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.SemiBold, fontSize = 17.sp, lineHeight = 24.sp),
    titleSmall = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.SemiBold, fontSize = 15.sp, lineHeight = 21.sp),
    bodyLarge = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.Normal, fontSize = 16.sp, lineHeight = 25.sp),
    bodyMedium = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.Normal, fontSize = 14.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.Bold, fontSize = 15.sp, letterSpacing = 0.1.sp),
    labelMedium = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.SemiBold, fontSize = 13.sp),
    labelSmall = TextStyle(fontFamily = Nunito, fontWeight = FontWeight.SemiBold, fontSize = 11.sp, letterSpacing = 0.4.sp),
)

@Composable
fun FamilyAgentTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}
