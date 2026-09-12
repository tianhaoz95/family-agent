package app.familyagent.android.ui

import android.graphics.Bitmap
import android.graphics.Canvas as AndroidCanvas
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

// A small freehand-drawing modal for the Board's "Draw" note modality — a
// plain Compose Canvas + drag gesture, mirroring desktop's hand-rolled
// <canvas> tool and iOS's SwiftUI-Canvas sheet 1:1 (same colour swatches +
// three sizes + undo/clear).
private val DRAW_COLORS = listOf(
    Color(0xFF2B2B2B), Color(0xFFC0392B), Color(0xFF0075DE),
    Color(0xFF1F8A4C), Color(0xFFE6A817), Color(0xFFFFFFFF),
)
private val DRAW_SIZES = listOf(3f, 7f, 14f)
private const val DRAW_CANVAS_DP = 320

private data class DrawStroke(val points: List<Offset>, val color: Color, val width: Float)

private fun strokePath(s: DrawStroke): Path {
    val path = Path()
    if (s.points.isEmpty()) return path
    path.moveTo(s.points[0].x, s.points[0].y)
    for (p in s.points.drop(1)) path.lineTo(p.x, p.y)
    return path
}

@Composable
private fun noRippleClickable(onClick: () -> Unit): Modifier =
    Modifier.clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onClick)

@Composable
fun DrawNoteSheet(onSave: (Bitmap) -> Unit, onCancel: () -> Unit) {
    var strokes by remember { mutableStateOf(listOf<DrawStroke>()) }
    var current by remember { mutableStateOf<DrawStroke?>(null) }
    var color by remember { mutableStateOf(DRAW_COLORS[0]) }
    var lineWidth by remember { mutableFloatStateOf(DRAW_SIZES[1]) }
    val density = LocalDensity.current
    val canvasPx = with(density) { DRAW_CANVAS_DP.dp.toPx() }

    Dialog(onDismissRequest = onCancel, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(shape = RoundedCornerShape(24.dp), tonalElevation = 4.dp) {
            Column(
                Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text("Draw a note", style = MaterialTheme.typography.titleMedium)

                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DRAW_COLORS.forEach { c ->
                        Box(
                            Modifier
                                .size(24.dp)
                                .clip(CircleShape)
                                .background(c)
                                .border(
                                    if (color == c) 2.5.dp else 1.dp,
                                    if (color == c) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                                    CircleShape,
                                )
                                .then(noRippleClickable { color = c }),
                        )
                    }
                    VerticalDivider(Modifier.height(20.dp))
                    DRAW_SIZES.forEach { w ->
                        Box(
                            Modifier
                                .size(26.dp)
                                .clip(CircleShape)
                                .background(if (lineWidth == w) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                                .then(noRippleClickable { lineWidth = w }),
                            contentAlignment = Alignment.Center,
                        ) {
                            Box(
                                Modifier
                                    .size(w.dp)
                                    .clip(CircleShape)
                                    .background(MaterialTheme.colorScheme.onSurface),
                            )
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = { if (strokes.isNotEmpty()) strokes = strokes.dropLast(1) }, enabled = strokes.isNotEmpty()) {
                        Text("Undo")
                    }
                    TextButton(onClick = { strokes = emptyList() }, enabled = strokes.isNotEmpty()) { Text("Clear") }
                }

                Canvas(
                    Modifier
                        .size(DRAW_CANVAS_DP.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(Color.White)
                        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
                        .pointerInput(color, lineWidth) {
                            detectDragGestures(
                                onDragStart = { offset -> current = DrawStroke(listOf(offset), color, lineWidth) },
                                onDragEnd = {
                                    current?.let { strokes = strokes + it }
                                    current = null
                                },
                                onDragCancel = { current = null },
                            ) { change, _ ->
                                current = current?.copy(points = current!!.points + change.position)
                            }
                        },
                ) {
                    for (s in strokes) {
                        drawPath(
                            strokePath(s),
                            color = s.color,
                            style = Stroke(width = s.width, cap = StrokeCap.Round, join = StrokeJoin.Round),
                        )
                    }
                    current?.let { s ->
                        if (s.points.size == 1) {
                            drawCircle(s.color, radius = s.width / 2, center = s.points[0])
                        } else {
                            drawPath(
                                strokePath(s),
                                color = s.color,
                                style = Stroke(width = s.width, cap = StrokeCap.Round, join = StrokeJoin.Round),
                            )
                        }
                    }
                }

                Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                    TextButton(onClick = onCancel) { Text("Cancel") }
                    Spacer(Modifier.width(8.dp))
                    Button(onClick = {
                        val size = canvasPx.toInt().coerceAtLeast(1)
                        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                        val androidCanvas = AndroidCanvas(bitmap)
                        androidCanvas.drawColor(android.graphics.Color.WHITE)
                        val composeCanvas = androidx.compose.ui.graphics.Canvas(androidCanvas)
                        CanvasDrawScope().draw(
                            density, LayoutDirection.Ltr, composeCanvas, Size(size.toFloat(), size.toFloat()),
                        ) {
                            for (s in strokes) {
                                drawPath(
                                    strokePath(s),
                                    color = s.color,
                                    style = Stroke(width = s.width, cap = StrokeCap.Round, join = StrokeJoin.Round),
                                )
                            }
                        }
                        onSave(bitmap)
                    }) { Text("Pin to board") }
                }
            }
        }
    }
}
