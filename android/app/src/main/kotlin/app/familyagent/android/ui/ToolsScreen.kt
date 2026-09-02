package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.Tool

@Composable
fun ToolsScreen(
    tools: List<Tool>,
    status: String?,
    toolsBaseUrl: String?,
    onBuild: (String) -> Unit,
    onDelete: (String) -> Unit,
    onOpen: (String) -> Unit,
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
                        Icons.Outlined.Build,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(tools, key = { it.id }) { tool ->
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
                                    Icons.Outlined.Delete,
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
                        when (tool.status) {
                            "building" -> Row(verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.width(8.dp))
                                Text("Building…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            "failed" -> Text(
                                tool.error?.let { "Failed: $it" } ?: "Build failed.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.error,
                            )
                            else -> Button(
                                onClick = {
                                    val path = tool.path ?: return@Button
                                    onOpen((toolsBaseUrl ?: return@Button).trimEnd('/') + path)
                                },
                                enabled = toolsBaseUrl != null && tool.path != null,
                                shape = RoundedCornerShape(12.dp),
                                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                            ) {
                                Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.size(16.dp))
                                Spacer(Modifier.width(6.dp))
                                Text("Open")
                            }
                        }
                    }
                }
            }
        }
    }
}
