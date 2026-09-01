package app.familyagent.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Same ledger palette as desktop/src/style.css and docs/architecture-notes —
// one visual identity across every surface of the app.
private val Paper = Color(0xFFEEECE5)
private val PaperRaised = Color(0xFFF8F6F1)
private val Ink = Color(0xFF23221D)
private val InkSoft = Color(0xFF5B584C)
private val Rule = Color(0xFFD9D5C8)
private val Accent = Color(0xFF1F5C52)
private val Brass = Color(0xFFA6742A)
private val LocalGreen = Color(0xFF3F7A4D)
private val WarnOrange = Color(0xFFB4622A)

private val PaperDark = Color(0xFF1B1A17)
private val PaperRaisedDark = Color(0xFF242320)
private val InkDark = Color(0xFFECE8DD)
private val InkSoftDark = Color(0xFFA9A495)
private val RuleDark = Color(0xFF38362F)
private val AccentDark = Color(0xFF56C2AD)
private val BrassDark = Color(0xFFD3A54C)
private val LocalGreenDark = Color(0xFF7FCB8A)
private val WarnOrangeDark = Color(0xFFE0904A)

private val LightColors = lightColorScheme(
    primary = Accent,
    onPrimary = PaperRaised,
    secondary = Brass,
    background = Paper,
    onBackground = Ink,
    surface = PaperRaised,
    onSurface = Ink,
    surfaceVariant = Rule,
    onSurfaceVariant = InkSoft,
    error = WarnOrange,
    tertiary = LocalGreen,
)

private val DarkColors = darkColorScheme(
    primary = AccentDark,
    onPrimary = PaperDark,
    secondary = BrassDark,
    background = PaperDark,
    onBackground = InkDark,
    surface = PaperRaisedDark,
    onSurface = InkDark,
    surfaceVariant = RuleDark,
    onSurfaceVariant = InkSoftDark,
    error = WarnOrangeDark,
    tertiary = LocalGreenDark,
)

private val AppTypography = Typography(
    titleLarge = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 22.sp),
    titleMedium = TextStyle(fontWeight = FontWeight.SemiBold, fontSize = 17.sp),
    bodyLarge = TextStyle(fontSize = 15.sp),
    bodyMedium = TextStyle(fontSize = 13.sp),
    labelSmall = TextStyle(fontWeight = FontWeight.Medium, fontSize = 11.sp),
)

@Composable
fun FamilyAgentTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(colorScheme = colors, typography = AppTypography, content = content)
}
