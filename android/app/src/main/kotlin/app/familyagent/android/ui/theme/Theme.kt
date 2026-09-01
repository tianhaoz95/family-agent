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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// "Clean & calm" design system — shared 1:1 with the desktop app
// (desktop/src/style.css). Near-neutral canvas, hairline borders, a single
// indigo accent used sparingly, generous spacing.

// ---- Light ----
private val Bg = Color(0xFFFBFBFC)
private val Surface = Color(0xFFFFFFFF)
private val Surface2 = Color(0xFFF4F4F6)
private val Surface3 = Color(0xFFEDEDF1)
private val Border = Color(0xFFE7E7EC)
private val BorderStrong = Color(0xFFD8D8DF)
private val Text = Color(0xFF1B1B21)
private val TextMuted = Color(0xFF63636E)
private val Accent = Color(0xFF5A5AD6)
private val AccentContrast = Color(0xFFFFFFFF)
private val AccentContainer = Color(0xFFE9E9FB)
private val Local = Color(0xFF1F9D63)
private val Warn = Color(0xFFC9781F)
private val Danger = Color(0xFFD93B46)

// ---- Dark ----
private val BgD = Color(0xFF0D0D10)
private val SurfaceD = Color(0xFF161619)
private val Surface2D = Color(0xFF1E1E23)
private val Surface3D = Color(0xFF26262C)
private val BorderD = Color(0xFF262630)
private val BorderStrongD = Color(0xFF34343F)
private val TextD = Color(0xFFECECEF)
private val TextMutedD = Color(0xFF9C9CA7)
private val AccentD = Color(0xFF8B8BF0)
private val AccentContrastD = Color(0xFF10101A)
private val AccentContainerD = Color(0xFF2A2A44)
private val LocalD = Color(0xFF45C98A)
private val WarnD = Color(0xFFE0A15F)
private val DangerD = Color(0xFFFF6B73)

private val LightColors = lightColorScheme(
    primary = Accent,
    onPrimary = AccentContrast,
    primaryContainer = AccentContainer,
    onPrimaryContainer = Accent,
    secondary = Accent,
    onSecondary = AccentContrast,
    tertiary = Local,
    onTertiary = AccentContrast,
    background = Bg,
    onBackground = Text,
    surface = Surface,
    onSurface = Text,
    surfaceVariant = Surface2,
    onSurfaceVariant = TextMuted,
    surfaceContainerLowest = Surface,
    surfaceContainerLow = Bg,
    surfaceContainer = Surface2,
    surfaceContainerHigh = Surface3,
    surfaceContainerHighest = Surface3,
    outline = BorderStrong,
    outlineVariant = Border,
    error = Danger,
    onError = AccentContrast,
    scrim = Color(0x66000000),
)

private val DarkColors = darkColorScheme(
    primary = AccentD,
    onPrimary = AccentContrastD,
    primaryContainer = AccentContainerD,
    onPrimaryContainer = AccentD,
    secondary = AccentD,
    onSecondary = AccentContrastD,
    tertiary = LocalD,
    onTertiary = AccentContrastD,
    background = BgD,
    onBackground = TextD,
    surface = SurfaceD,
    onSurface = TextD,
    surfaceVariant = Surface2D,
    onSurfaceVariant = TextMutedD,
    surfaceContainerLowest = BgD,
    surfaceContainerLow = SurfaceD,
    surfaceContainer = Surface2D,
    surfaceContainerHigh = Surface3D,
    surfaceContainerHighest = Surface3D,
    outline = BorderStrongD,
    outlineVariant = BorderD,
    error = DangerD,
    onError = AccentContrastD,
    scrim = Color(0x99000000),
)

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

private val AppTypography = Typography(
    headlineSmall = TextStyle(fontWeight = FontWeight.Bold, fontSize = 25.sp, letterSpacing = (-0.5).sp),
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 21.sp, letterSpacing = (-0.3).sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 16.sp, letterSpacing = (-0.1).sp),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 13.5.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 11.sp, letterSpacing = 0.4.sp),
)

@Composable
fun FamilyAgentTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(
        colorScheme = colors,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}
