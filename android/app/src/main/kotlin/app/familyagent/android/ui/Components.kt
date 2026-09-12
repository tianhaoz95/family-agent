package app.familyagent.android.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.automirrored.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.familyagent.android.ui.theme.AppAccents
import app.familyagent.android.ui.theme.SourceSerif
import kotlinx.coroutines.delay

/**
 * Height reserved for [ScreenScaffold]'s floating title bar, so scrolling
 * content below it can start right at its bottom edge at rest. Mirrors the
 * iOS counterpart's `headerHeight` (`ios/.../Components.swift`) exactly —
 * same title style and paddings on both platforms.
 */
val SCREEN_SCAFFOLD_HEADER_HEIGHT = 58.dp
private val SCREEN_SCAFFOLD_HEADER_HEIGHT_NO_MENU = 104.dp

/**
 * Standard screen frame: safe-area padding, a title and an editorial serif
 * subtitle, then section content with generous spacing. Transparent — the
 * animated gradient canvas (AtmosphereBackground) shows through.
 *
 * The title bar **floats in front of** the content (a `Box` overlay, not a
 * row above it in a `Column`) with a background, so content dissolves
 * *behind* it as it scrolls up underneath — the same idea as a real nav bar
 * (and the iOS counterpart's `.ultraThinMaterial` bar). Content gets top
 * padding equal to the bar's height so it starts right below it at rest. An
 * earlier version instead drew a separate translucent fade strip
 * (`TopScrollFade`) pinned to the top of the whole screen, floating apart
 * from the actual title row rather than merged into it — this replaces
 * that. No true blur-through here (Compose has no cheap backdrop blur
 * across this app's minSdk 26, same constraint that shaped the old
 * gradient-only `TopScrollFade`); the bar's background is opaque enough
 * that content is occluded, not blurred, behind it.
 *
 * The title sits on the **same row** as MainActivity's floating menu button
 * (a 66dp leading inset — 20dp base + 46dp clearance — instead of a full
 * 58dp-tall gap below it) to save vertical space on every screen that uses
 * this. Numbers mirror the iOS counterpart (`ios/.../Components.swift`),
 * tuned to the button's actual geometry (42dp square, 12dp start + 6dp top
 * inset from MainActivity) so the title visually centers against it.
 *
 * Set `hasMenuButton = false` for a screen shown before the drawer/button
 * ever appear (DiscoveryScreen, LoginScreen — pre-auth) so the title goes
 * back to a plain, unindented row clearing just the status bar: reserving
 * leading space for a button that isn't there left the title visibly offset
 * from everything below it.
 */
@Composable
fun ScreenScaffold(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    hasMenuButton: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val headerHeight = if (hasMenuButton) SCREEN_SCAFFOLD_HEADER_HEIGHT else SCREEN_SCAFFOLD_HEADER_HEIGHT_NO_MENU
    Box(Modifier.fillMaxSize()) {
        Column(
            modifier
                .fillMaxSize()
                .padding(horizontal = 20.dp)
                .padding(top = headerHeight, bottom = 8.dp),
        ) {
            Text(
                subtitle,
                style = MaterialTheme.typography.bodyLarge.copy(fontFamily = SourceSerif),
                color = AppAccents.textBody,
            )
            Spacer(Modifier.height(22.dp))
            content()
        }
        Text(
            title,
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground,
            // Opaque surface (the same white every card/list-row in this app
            // already uses), not a translucent wash of the canvas color — a
            // thin bar inset in a padded column has no strong texture behind
            // it to blend with, so translucency just read as a flat, oddly
            // pale rectangle. A soft shadow (no border — this app's own
            // white nav drawer/menu button use the same look) gives it
            // enough separation from scrolled content instead.
            modifier = Modifier
                .fillMaxWidth()
                .shadow(2.dp)
                .background(MaterialTheme.colorScheme.surface)
                .padding(start = if (hasMenuButton) 66.dp else 20.dp, end = 20.dp)
                .padding(top = if (hasMenuButton) 12.dp else 58.dp, bottom = 6.dp),
        )
    }
}

/**
 * Lifted card — soft shadow, big radius, roomy padding (DESIGN.md §8.2, §10).
 * Pass [accent] for a colored top bar; pass [onClick] to make it a bouncy
 * pressable.
 */
@Composable
fun AppCard(
    modifier: Modifier = Modifier,
    accent: Color? = null,
    onClick: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (onClick != null && pressed) 0.97f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label = "cardScale",
    )
    val clickModifier = if (onClick != null) {
        Modifier.clickable(interactionSource = interaction, indication = null, onClick = onClick)
    } else {
        Modifier
    }
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .scale(scale)
            .then(clickModifier),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shadowElevation = 4.dp,
    ) {
        Column {
            if (accent != null) {
                Box(Modifier.fillMaxWidth().height(4.dp).background(accent))
            }
            Column(Modifier.padding(18.dp), content = content)
        }
    }
}

@Composable
fun Chip(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
) {
    Surface(
        modifier = modifier,
        color = color.copy(alpha = 0.14f),
        shape = CircleShape,
    ) {
        Text(
            text.uppercase(),
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelSmall,
            color = color,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier) {
    Box(modifier.size(9.dp).clip(CircleShape).background(color))
}

/** A small "Copy" button for an assistant / agent reply — copies the raw text
 *  (the Markdown source, not the rendered output) and shows "Copied" briefly. */
@Composable
fun CopyButton(text: String, modifier: Modifier = Modifier) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }
    TextButton(
        onClick = {
            clipboard.setText(AnnotatedString(text))
            copied = true
        },
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
        modifier = modifier.heightIn(min = 30.dp),
    ) {
        Icon(
            if (copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy,
            contentDescription = null,
            modifier = Modifier.size(14.dp),
            tint = if (copied) AppAccents.success else AppAccents.textSecondary,
        )
        Spacer(Modifier.width(5.dp))
        Text(
            if (copied) "Copied" else "Copy",
            style = MaterialTheme.typography.labelMedium,
            color = if (copied) AppAccents.success else AppAccents.textSecondary,
        )
    }
}

/** A "Read aloud" toggle for an assistant / agent reply. Idle → synthesizing →
 *  playing → idle; playback and the synthesized-audio cache live in the
 *  ViewModel, so this only reflects [speakingText] / [speakLoadingText]. */
@Composable
fun SpeakButton(
    text: String,
    speakingText: String?,
    speakLoadingText: String?,
    onToggle: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val body = text.trim()
    val playing = speakingText == body
    val loading = speakLoadingText == body
    val accent = MaterialTheme.colorScheme.primary
    val muted = AppAccents.textSecondary
    TextButton(
        onClick = { onToggle(body) },
        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
        modifier = modifier.heightIn(min = 30.dp),
    ) {
        when {
            loading -> {
                CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 1.6.dp, color = accent)
                Spacer(Modifier.width(6.dp))
                Text("Synthesizing…", style = MaterialTheme.typography.labelMedium, color = muted)
            }
            playing -> {
                Icon(Icons.Rounded.Stop, contentDescription = null, modifier = Modifier.size(15.dp), tint = accent)
                Spacer(Modifier.width(5.dp))
                Text("Stop", style = MaterialTheme.typography.labelMedium, color = accent)
            }
            else -> {
                Icon(Icons.AutoMirrored.Rounded.VolumeUp, contentDescription = null, modifier = Modifier.size(15.dp), tint = muted)
                Spacer(Modifier.width(5.dp))
                Text("Read aloud", style = MaterialTheme.typography.labelMedium, color = muted)
            }
        }
    }
}

/** Centered icon in a colored bubble + a friendly message. */
@Composable
fun EmptyState(
    text: String,
    modifier: Modifier = Modifier,
    icon: @Composable () -> Unit = {},
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 64.dp, start = 24.dp, end = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .size(72.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.primaryContainer),
            contentAlignment = Alignment.Center,
        ) { icon() }
        Spacer(Modifier.height(16.dp))
        Text(
            text,
            style = MaterialTheme.typography.bodyLarge,
            color = AppAccents.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

/** Three bouncing dots — the "assistant is thinking" cue. Muted, like the
 *  desktop typing indicator. */
@Composable
fun TypingDots(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "typing")
    val dot = AppAccents.textSecondary
    val hues = listOf(dot, dot, dot)
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 6.dp),
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shadowElevation = 4.dp,
    ) {
        Row(
            Modifier.padding(horizontal = 18.dp, vertical = 15.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            repeat(3) { i ->
                val bounce by transition.animateFloat(
                    initialValue = 0f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(800, delayMillis = i * 140),
                        repeatMode = RepeatMode.Reverse,
                    ),
                    label = "dot$i",
                )
                Box(
                    Modifier
                        .size(7.dp)
                        .graphicsLayer {
                            translationY = -5.dp.toPx() * bounce
                            alpha = 0.45f + 0.55f * bounce
                        }
                        .clip(CircleShape)
                        .background(hues[i]),
                )
            }
        }
    }
}

/** A compact strip summarising the tool calls behind an assistant reply.
 *  Tap to open the full "Under the hood" detail sheet. Live = still running. */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun StepsStrip(
    steps: List<app.familyagent.android.data.ToolStep>,
    live: Boolean,
    onClick: () -> Unit,
) {
    val running = steps.any { it.phase == "running" } || (live && steps.isEmpty())
    val errored = steps.any { it.phase == "error" }
    Surface(
        onClick = onClick,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(Modifier.padding(horizontal = 11.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                if (running) {
                    CircularProgressIndicator(Modifier.size(11.dp), strokeWidth = 1.6.dp, color = MaterialTheme.colorScheme.primary)
                    Text(
                        if (steps.isEmpty()) "Working…" else "Working — ${steps.size} tool call${if (steps.size == 1) "" else "s"}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else {
                    Text(
                        if (errored) "!" else "✓",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = if (errored) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    )
                    Text(
                        "${steps.size} tool call${if (steps.size == 1) "" else "s"}",
                        style = MaterialTheme.typography.labelSmall,
                        color = AppAccents.textSecondary,
                    )
                }
            }
            if (steps.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    steps.take(8).forEach { s ->
                        val dotColor = when (s.phase) {
                            "running" -> MaterialTheme.colorScheme.primary
                            "error" -> MaterialTheme.colorScheme.error
                            else -> MaterialTheme.colorScheme.primary
                        }
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            shape = RoundedCornerShape(999.dp),
                        ) {
                            Row(
                                Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(5.dp),
                            ) {
                                Box(Modifier.size(5.dp).clip(CircleShape).background(dotColor))
                                Text(
                                    stepVerb(s),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = if (s.phase == "error") MaterialTheme.colorScheme.error else AppAccents.textSecondary,
                                    maxLines = 1,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
