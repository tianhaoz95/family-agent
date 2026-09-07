package app.familyagent.android.ui

import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import app.familyagent.android.ui.theme.AppAccents
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * The animated gradient canvas — the Android counterpart of the desktop's
 * `body::before` / `body::after` bloom layers (see docs/DECISIONS.md). Four soft
 * radial colour blooms drawn from the accent cast drift slowly over the warm
 * paper base; the app content sits on top, with glass chrome and floating cards
 * so the wash shows through around them. Frozen when the OS animation scale is 0
 * (the platform "remove animations" setting).
 */
@Composable
fun AtmosphereBackground(
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    val context = LocalContext.current
    val reduceMotion = remember {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)
    }

    val phase: Float = if (reduceMotion) {
        0f
    } else {
        val transition = rememberInfiniteTransition(label = "atmosphere")
        val p by transition.animateFloat(
            initialValue = 0f,
            targetValue = (2.0 * PI).toFloat(),
            animationSpec = infiniteRepeatable(tween(34_000, easing = LinearEasing)),
            label = "phase",
        )
        p
    }

    val base = Color(0xFFF6F5F4)
    val sky = AppAccents.bloomSky
    val peach = AppAccents.bloomPeach
    val lilac = AppAccents.bloomLilac
    val mint = AppAccents.bloomMint

    Box(
        modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(base)
                val w = size.width
                val h = size.height
                val d = size.minDimension

                fun bloom(cx: Float, cy: Float, radius: Float, color: Color) {
                    drawRect(
                        brush = Brush.radialGradient(
                            colors = listOf(color, Color.Transparent),
                            center = Offset(cx, cy),
                            radius = radius,
                        ),
                    )
                }

                bloom(w * (0.12f + 0.06f * sin(phase)), h * (0.05f + 0.05f * cos(phase * 0.8f)), d * 1.15f, sky)
                bloom(w * (0.92f - 0.05f * cos(phase)), h * (0.16f + 0.06f * sin(phase * 1.1f)), d * 1.28f, peach)
                bloom(w * (0.78f + 0.05f * sin(phase * 0.7f)), h * (0.95f - 0.05f * cos(phase)), d * 1.34f, lilac)
                bloom(w * (0.05f - 0.04f * cos(phase * 0.9f)), h * (0.86f + 0.05f * sin(phase)), d * 1.1f, mint)
            },
        content = content,
    )
}
