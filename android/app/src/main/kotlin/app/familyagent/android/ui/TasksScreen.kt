package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Tasks", style = MaterialTheme.typography.titleLarge)
        Text(
            "Everything the family agent is tracking for you.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("New task title") },
                singleLine = true,
            )
            OutlinedTextField(
                value = due,
                onValueChange = { due = it },
                modifier = Modifier.width(120.dp),
                placeholder = { Text("YYYY-MM-DD") },
                singleLine = true,
            )
            Button(onClick = {
                if (title.isNotBlank()) {
                    onAdd(title, due.ifBlank { null })
                    title = ""
                    due = ""
                }
            }) { Text("Add") }
        }

        Spacer(Modifier.height(12.dp))

        if (tasks.isEmpty()) {
            EmptyState("No tasks yet.")
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(tasks, key = { it.id }) { task ->
                    ElevatedCard {
                        Row(
                            Modifier.fillMaxWidth().padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(
                                checked = task.status == "done",
                                onCheckedChange = { if (task.status != "done") onComplete(task.id) },
                                enabled = task.status != "done",
                            )
                            Text(
                                task.title,
                                modifier = Modifier.weight(1f),
                                textDecoration = if (task.status == "done") TextDecoration.LineThrough else null,
                                color = if (task.status == "done") MaterialTheme.colorScheme.onSurfaceVariant
                                else MaterialTheme.colorScheme.onSurface,
                            )
                            task.dueDate?.let {
                                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun EmptyState(text: String) {
    Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
}
