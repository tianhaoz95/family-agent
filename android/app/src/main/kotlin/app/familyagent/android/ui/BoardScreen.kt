package app.familyagent.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.StickyNote

private val NOTE_COLORS = listOf(
    "butter" to Color(0xFFFDF1C4),
    "mint" to Color(0xFFD8EDE0),
    "sky" to Color(0xFFDBE8F6),
    "blush" to Color(0xFFF6DFE4),
    "lilac" to Color(0xFFE6E0F2),
)

private fun noteColor(name: String): Color = NOTE_COLORS.firstOrNull { it.first == name }?.second ?: NOTE_COLORS[0].second

@Composable
fun BoardScreen(
    notes: List<StickyNote>,
    scope: String,
    onScope: (String) -> Unit,
    onAdd: (String, String) -> Unit,
    onEdit: (String, String?, String?) -> Unit,
    onDelete: (String) -> Unit,
    onRefresh: () -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }
    var draft by remember { mutableStateOf("") }
    var draftColor by remember { mutableStateOf(NOTE_COLORS[0].first) }
    var editing by remember { mutableStateOf<StickyNote?>(null) }

    ScreenScaffold(
        title = "Board",
        subtitle = "Sticky notes for the whole family, or just for you.",
    ) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf("shared" to "Shared", "private" to "Mine").forEachIndexed { i, (key, label) ->
                SegmentedButton(
                    selected = scope == key,
                    onClick = { onScope(key) },
                    shape = SegmentedButtonDefaults.itemShape(i, 2),
                ) { Text(label) }
            }
        }

        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            label = { Text("Write a note…") },
            modifier = Modifier.fillMaxWidth(),
            minLines = 2,
        )
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            NOTE_COLORS.forEach { (name, color) ->
                Box(
                    Modifier
                        .padding(end = 8.dp)
                        .size(24.dp)
                        .clip(CircleShape)
                        .background(color)
                        .then(
                            if (name == draftColor) Modifier.padding(2.dp) else Modifier,
                        )
                        .clickable { draftColor = name },
                )
            }
            Spacer(Modifier.weight(1f))
            Button(
                onClick = {
                    if (draft.isNotBlank()) {
                        onAdd(draft.trim(), draftColor)
                        draft = ""
                    }
                },
                enabled = draft.isNotBlank(),
            ) { Text("Add") }
        }

        Spacer(Modifier.height(16.dp))
        if (notes.isEmpty()) {
            EmptyState(text = "No notes on this board yet.", modifier = Modifier.weight(1f))
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(150.dp),
                modifier = Modifier.weight(1f).fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(notes, key = { it.id }) { note ->
                    NoteCard(note, onClick = { editing = note }, onDelete = { onDelete(note.id) })
                }
            }
        }
    }

    editing?.let { note ->
        EditNoteDialog(
            note = note,
            onDismiss = { editing = null },
            onSave = { text, color ->
                onEdit(note.id, text.takeIf { it != note.text }, color.takeIf { it != note.color })
                editing = null
            },
        )
    }
}

@Composable
private fun NoteCard(note: StickyNote, onClick: () -> Unit, onDelete: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(14.dp))
            .background(noteColor(note.color))
            .clickable(onClick = onClick)
            .padding(12.dp)
            .heightIn(min = 110.dp)
            .fillMaxWidth(),
    ) {
        Text(
            note.text,
            style = MaterialTheme.typography.bodyMedium,
            color = Color(0xFF0F172A),
            modifier = Modifier.padding(end = 20.dp),
        )
        Icon(
            Icons.Rounded.Close,
            contentDescription = "Delete note",
            modifier = Modifier
                .align(Alignment.TopEnd)
                .size(18.dp)
                .clip(CircleShape)
                .clickable(onClick = onDelete),
            tint = Color(0x660F172A),
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
        title = { Text("Edit note") },
        text = {
            Column {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
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
                                .clickable { color = name }
                                .then(if (name == color) Modifier.padding(2.dp) else Modifier),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (name == color) Text("✓", fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = { onSave(text.trim(), color) }, enabled = text.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
