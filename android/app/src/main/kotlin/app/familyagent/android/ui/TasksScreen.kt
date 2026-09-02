package app.familyagent.android.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.TaskAlt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.Task

@Composable
fun TasksScreen(
    tasks: List<Task>,
    onAdd: (title: String, dueDate: String?) -> Unit,
    onComplete: (id: String) -> Unit,
) {
    var title by remember { mutableStateOf("") }
    var due by remember { mutableStateOf("") }

    ScreenScaffold(
        title = "Tasks",
        subtitle = "Everything the family agent is tracking for you.",
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("New task") },
                singleLine = true,
                shape = MaterialTheme.shapes.medium,
            )
            Button(
                onClick = {
                    if (title.isNotBlank()) {
                        onAdd(title, due.ifBlank { null })
                        title = ""
                        due = ""
                    }
                },
                shape = MaterialTheme.shapes.medium,
                contentPadding = PaddingValues(horizontal = 18.dp, vertical = 14.dp),
            ) { Text("Add") }
        }
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = due,
            onValueChange = { due = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Due date (optional) — e.g. 2026-11-01") },
            singleLine = true,
            shape = MaterialTheme.shapes.medium,
        )

        Spacer(Modifier.height(16.dp))

        if (tasks.isEmpty()) {
            EmptyState(
                text = "No tasks yet. Add one above or ask in Chat.",
                icon = {
                    Icon(
                        Icons.Rounded.TaskAlt,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(tasks, key = { it.id }) { task ->
                    val done = task.status == "done"
                    AppCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(
                                checked = done,
                                onCheckedChange = { if (!done) onComplete(task.id) },
                                enabled = !done,
                                colors = CheckboxDefaults.colors(
                                    disabledCheckedColor = MaterialTheme.colorScheme.primary,
                                ),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                task.title,
                                modifier = Modifier.weight(1f),
                                style = MaterialTheme.typography.bodyLarge,
                                textDecoration = if (done) TextDecoration.LineThrough else null,
                                color = animateColorAsState(
                                    if (done) MaterialTheme.colorScheme.onSurfaceVariant
                                    else MaterialTheme.colorScheme.onSurface,
                                    label = "taskColor",
                                ).value,
                            )
                            task.dueDate?.let {
                                Spacer(Modifier.width(8.dp))
                                Surface(
                                    color = MaterialTheme.colorScheme.surfaceVariant,
                                    shape = RoundedCornerShape(999.dp),
                                ) {
                                    Text(
                                        it,
                                        modifier = Modifier.padding(horizontal = 9.dp, vertical = 3.dp),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
