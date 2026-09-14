package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Storage
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.Tool
import app.familyagent.android.ui.theme.AppAccents

@Composable
fun ToolsScreen(
    tools: List<Tool>,
    status: String?,
    toolsBaseUrl: String?,
    onBuild: (String) -> Unit,
    onDelete: (String) -> Unit,
    onOpen: (String) -> Unit,
    onIterate: (id: String, instruction: String) -> Unit = { _, _ -> },
    onRevert: (id: String) -> Unit = {},
    onInspectData: (id: String) -> Unit = {},
) {
    var prompt by remember { mutableStateOf("") }

    ScreenScaffold(
        title = "Tools",
        subtitle = "Ask the agent to build a small web tool to help finish a task — generated and run locally.",
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("e.g. split our vacation budget 4 ways") },
                singleLine = true,
                shape = MaterialTheme.shapes.medium,
            )
            Button(
                onClick = {
                    if (prompt.isNotBlank()) {
                        onBuild(prompt)
                        prompt = ""
                    }
                },
                shape = MaterialTheme.shapes.medium,
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
            ) { Text("Build") }
        }
        status?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Spacer(Modifier.height(16.dp))

        if (tools.isEmpty()) {
            EmptyState(
                text = "No tools yet. Describe one above, or ask in Chat (\"build me a…\").",
                icon = {
                    Icon(
                        Icons.Rounded.Build,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(tools, key = { it.id }) { tool ->
                    ToolCard(tool, toolsBaseUrl, onOpen, onDelete, onIterate, onRevert, onInspectData)
                }
            }
        }
    }
}

@Composable
private fun ToolCard(
    tool: Tool,
    toolsBaseUrl: String?,
    onOpen: (String) -> Unit,
    onDelete: (String) -> Unit,
    onIterate: (id: String, instruction: String) -> Unit,
    onRevert: (id: String) -> Unit,
    onInspectData: (id: String) -> Unit,
) {
    // Which of "Fix it" / "Improve" is expanded into its inline instruction
    // field, if either — collapsed by default, one at a time (there's only
    // ever one visible per card anyway, but this also resets across recomposition).
    var improving by remember(tool.id) { mutableStateOf(false) }
    val revising = tool.revisionState == "revising"

    AppCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                tool.name,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (tool.kind == "server") {
                Chip("shared")
                Spacer(Modifier.width(4.dp))
            }
            IconButton(onClick = { onDelete(tool.id) }, modifier = Modifier.size(32.dp)) {
                Icon(
                    Icons.Rounded.Delete,
                    contentDescription = "Delete ${tool.name}",
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(
            tool.description,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(10.dp))
        when {
            tool.status == "building" -> Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(
                    if (tool.revisionCount > 0) "Rebuilding…" else "Building…",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            tool.status == "failed" -> {
                Text(
                    "This didn't come together. Try describing it again, or tweak the wording below.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.height(8.dp))
                // A failed tool can still be salvaged with an instruction.
                if (improving) {
                    ImproveField(label = "What should be different? e.g. \"the total is wrong\"") { instruction ->
                        onIterate(tool.id, instruction)
                        improving = false
                    }
                } else {
                    OutlinedButton(onClick = { improving = true }, shape = MaterialTheme.shapes.medium) { Text("Fix it") }
                }
            }
            else -> {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = {
                            val path = tool.path ?: return@Button
                            onOpen((toolsBaseUrl ?: return@Button).trimEnd('/') + path)
                        },
                        enabled = toolsBaseUrl != null && tool.path != null,
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Rounded.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Open")
                    }
                    OutlinedButton(
                        onClick = { onInspectData(tool.id) },
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        Icon(Icons.Rounded.Storage, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(if (tool.kind == "server") "Inspect data" else "View saved data")
                    }
                }
                Spacer(Modifier.height(8.dp))
                if (revising) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("Improving…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                } else if (improving) {
                    ImproveField(label = "What should change? e.g. \"add a due date to each loan\"") { instruction ->
                        onIterate(tool.id, instruction)
                        improving = false
                    }
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { improving = true }, shape = MaterialTheme.shapes.medium) { Text("Improve") }
                        if (tool.canRevert) {
                            OutlinedButton(onClick = { onRevert(tool.id) }, shape = MaterialTheme.shapes.medium) { Text("Undo last change") }
                        }
                    }
                }
                // A failed improve: the tool still works, but say the change didn't land.
                if (tool.revisionState != null && !revising) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Last change didn't work: ${tool.revisionState}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                } else if (tool.revisionCount > 0 && !revising) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Improved ${tool.revisionCount} time${if (tool.revisionCount == 1) "" else "s"}",
                        style = MaterialTheme.typography.labelSmall,
                        color = AppAccents.textSecondary,
                    )
                }
            }
        }
    }
}

/** "Improve" / "Fix it": an inline text field + Send, same shape desktop's
 *  own instruction box has. */
@Composable
private fun ImproveField(label: String, onSubmit: (String) -> Unit) {
    var instruction by remember { mutableStateOf("") }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = instruction,
            onValueChange = { instruction = it },
            modifier = Modifier.weight(1f),
            placeholder = { Text(label) },
            singleLine = true,
            shape = MaterialTheme.shapes.medium,
        )
        Button(
            onClick = {
                val t = instruction.trim()
                if (t.length >= 3) onSubmit(t)
            },
            enabled = instruction.trim().length >= 3,
            shape = MaterialTheme.shapes.medium,
        ) { Text("Send") }
    }
}
