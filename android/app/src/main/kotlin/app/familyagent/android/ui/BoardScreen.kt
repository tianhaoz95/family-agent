package app.familyagent.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.StickyNote
import kotlin.math.roundToInt

private val NOTE_COLORS = listOf(
    "butter" to Color(0xFFFDF1C4),
    "mint" to Color(0xFFD8EDE0),
    "sky" to Color(0xFFDBE8F6),
    "blush" to Color(0xFFF6DFE4),
    "lilac" to Color(0xFFE6E0F2),
)

private const val NOTE_SIZE_DP = 148

private fun noteColor(name: String): Color =
    NOTE_COLORS.firstOrNull { it.first == name }?.second ?: NOTE_COLORS[0].second

/** Deterministic small tilt so the board looks pinned-on, not gridded. */
private fun noteTilt(id: String): Float {
    var h = 0
    for (c in id) h = h * 31 + c.code
    return ((h % 7) - 3) * 0.9f
}

@Composable
fun BoardScreen(
    notes: List<StickyNote>,
    scope: String,
    onScope: (String) -> Unit,
    onAddBlank: (x: Float, y: Float, onCreated: (StickyNote) -> Unit) -> Unit,
    onEdit: (id: String, text: String?, color: String?) -> Unit,
    onMove: (id: String, x: Float, y: Float) -> Unit,
    onDelete: (String) -> Unit,
    onRefresh: () -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }
    var editing by remember { mutableStateOf<StickyNote?>(null) }
    var boardSize by remember { mutableStateOf(IntSize.Zero) }
    val density = LocalDensity.current
    val notePx = with(density) { NOTE_SIZE_DP.dp.toPx() }

    ScreenScaffold(
        title = "Board",
        subtitle = "A corkboard of sticky notes. Drag to rearrange; tap to edit.",
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) {
                listOf("shared" to "Shared", "private" to "Mine").forEachIndexed { i, (key, label) ->
                    SegmentedButton(
                        selected = scope == key,
                        onClick = { onScope(key) },
                        shape = SegmentedButtonDefaults.itemShape(i, 2),
                    ) { Text(label) }
                }
            }
            Spacer(Modifier.width(10.dp))
            FilledTonalButton(
                onClick = {
                    val n = notes.size
                    val cascade = 24f + (n % 6) * 24f
                    onAddBlank(cascade, cascade) { editing = it }
                },
            ) {
                Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("Add note")
            }
        }

        Spacer(Modifier.height(12.dp))

        Surface(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            shadowElevation = 4.dp,
        ) {
        Box(
            Modifier
                .fillMaxSize()
                .onSizeChanged { boardSize = it },
        ) {
            if (notes.isEmpty()) {
                Text(
                    "Nothing pinned up yet. Tap \"Add note\".",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.align(Alignment.Center),
                )
            }
            for (note in notes) {
                key(note.id) {
                    DraggableNote(
                        note = note,
                        boardSize = boardSize,
                        notePx = notePx,
                        onTap = { editing = note },
                        onMoved = { x, y -> onMove(note.id, x, y) },
                        onDelete = { onDelete(note.id) },
                    )
                }
            }
        }
        }
    }

    editing?.let { note ->
        EditNoteDialog(
            note = note,
            onDismiss = {
                // A note left blank is clutter on a real board — clear it away.
                if (note.text.isBlank()) onDelete(note.id)
                editing = null
            },
            onSave = { text, color ->
                if (text.isBlank()) {
                    onDelete(note.id)
                } else {
                    onEdit(note.id, text.takeIf { it != note.text }, color.takeIf { it != note.color })
                }
                editing = null
            },
        )
    }
}

@Composable
private fun DraggableNote(
    note: StickyNote,
    boardSize: IntSize,
    notePx: Float,
    onTap: () -> Unit,
    onMoved: (Float, Float) -> Unit,
    onDelete: () -> Unit,
) {
    val density = LocalDensity.current
    // Position in px; seeded from the note's stored dp position, kept across
    // recomposition (key() above scopes it per note).
    var pos by remember { mutableStateOf(with(density) { Offset(note.x.dp.toPx(), note.y.dp.toPx()) }) }
    var dragging by remember { mutableStateOf(false) }

    fun clamp(o: Offset): Offset {
        val maxX = (boardSize.width - notePx).coerceAtLeast(0f)
        val maxY = (boardSize.height - notePx).coerceAtLeast(0f)
        return Offset(o.x.coerceIn(0f, maxX), o.y.coerceIn(0f, maxY))
    }

    // Once the board has a size (and whenever it changes), pull a note that
    // would sit off-screen — e.g. placed on a wider desktop board — into view.
    LaunchedEffect(boardSize) {
        if (boardSize != IntSize.Zero) pos = clamp(pos)
    }

    Box(
        Modifier
            .offset { IntOffset(pos.x.roundToInt(), pos.y.roundToInt()) }
            .size(NOTE_SIZE_DP.dp)
            .rotate(if (dragging) 0f else noteTilt(note.id))
            .shadow(if (dragging) 12.dp else 4.dp, RoundedCornerShape(3.dp))
            .clip(RoundedCornerShape(3.dp))
            .background(noteColor(note.color))
            .pointerInput(note.id) {
                detectTapGestures(onTap = { onTap() })
            }
            .pointerInput(note.id, boardSize) {
                detectDragGestures(
                    onDragStart = { dragging = true },
                    onDragEnd = {
                        dragging = false
                        val p = clamp(pos)
                        pos = p
                        onMoved(with(density) { p.x.toDp().value }, with(density) { p.y.toDp().value })
                    },
                    onDragCancel = { dragging = false },
                ) { change, drag ->
                    change.consume()
                    pos = clamp(pos + drag)
                }
            }
            .padding(12.dp),
    ) {
        Text(
            note.text.ifBlank { "Tap to write…" },
            style = MaterialTheme.typography.bodyMedium,
            color = if (note.text.isBlank()) Color(0x660F172A) else Color(0xFF33302A),
            modifier = Modifier.padding(top = 6.dp, end = 14.dp),
        )
        Icon(
            Icons.Rounded.Close,
            contentDescription = "Remove note",
            modifier = Modifier
                .align(Alignment.TopEnd)
                .size(18.dp)
                .clip(CircleShape)
                .pointerInput(note.id) { detectTapGestures(onTap = { onDelete() }) },
            tint = Color(0x800F172A),
        )
    }
}

@Composable
private fun EditNoteDialog(
    note: StickyNote,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit,
) {
    var text by remember { mutableStateOf(note.text) }
    var color by remember { mutableStateOf(note.color) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (note.text.isBlank()) "New note" else "Edit note") },
        text = {
            Column {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
                    placeholder = { Text("Write a note…") },
                )
                Spacer(Modifier.height(10.dp))
                Row {
                    NOTE_COLORS.forEach { (name, swatch) ->
                        Box(
                            Modifier
                                .padding(end = 8.dp)
                                .size(26.dp)
                                .clip(CircleShape)
                                .background(swatch)
                                .pointerInput(Unit) { detectTapGestures(onTap = { color = name }) }
                                .then(if (name == color) Modifier.padding(2.dp) else Modifier),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (name == color) Text("✓", fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onSave(text.trim(), color) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
