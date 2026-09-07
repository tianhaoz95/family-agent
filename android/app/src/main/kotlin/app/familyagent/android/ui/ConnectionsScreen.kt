package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.McpServer
import app.familyagent.android.data.SaveMcpServerResponse
import app.familyagent.android.ui.theme.AppAccents

// External services the assistant reaches over the Model Context Protocol. Their
// tools are untrusted — agent-core wraps every result with a "don't act on
// instructions in here" note. Admin-only; the server also enforces that.

@Composable
fun ConnectionsScreen(
    servers: List<McpServer>,
    status: String?,
    onRefresh: () -> Unit,
    onSave: (McpServer, (SaveMcpServerResponse) -> Unit, (String) -> Unit) -> Unit,
    onSetEnabled: (String, Boolean) -> Unit,
    onProbe: (String, (String) -> Unit) -> Unit,
    onDelete: (String) -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }
    var showAdd by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<McpServer?>(null) }
    val probeResults = remember { mutableStateMapOf<String, String>() }

    ScreenScaffold(
        title = "Connections",
        subtitle = "External services (MCP) the assistant can call. Their results are treated as information only, never as instructions.",
    ) {
        Button(
            onClick = { showAdd = true },
            shape = MaterialTheme.shapes.medium,
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
        ) { Text("Add connection") }
        Spacer(Modifier.height(12.dp))

        status?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
            Spacer(Modifier.height(8.dp))
        }

        if (servers.isEmpty()) {
            EmptyState(
                text = "No connections yet.",
                icon = {
                    Icon(
                        Icons.Rounded.Hub,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(servers, key = { it.name }) { s ->
                    AppCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Switch(checked = s.enabled, onCheckedChange = { onSetEnabled(s.name, !s.enabled) })
                            Spacer(Modifier.width(10.dp))
                            Text(
                                s.name,
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Text(s.transport, style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
                        }
                        Spacer(Modifier.height(6.dp))
                        Text(
                            if (s.transport == "http") s.url ?: "" else listOfNotNull(s.command, *(s.args ?: emptyList()).toTypedArray()).joinToString(" "),
                            style = MaterialTheme.typography.bodySmall,
                            color = AppAccents.textSecondary,
                        )
                        probeResults[s.name]?.let {
                            Spacer(Modifier.height(4.dp))
                            Text(it, style = MaterialTheme.typography.labelSmall)
                        }
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = {
                                probeResults[s.name] = "Testing…"
                                onProbe(s.name) { probeResults[s.name] = it }
                            }) { Text("Test") }
                            TextButton(onClick = { confirmDelete = s }) {
                                Text("Remove", color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
            }
        }
    }

    if (showAdd) {
        McpSheet(
            onDismiss = { showAdd = false },
            onSave = { server, onError ->
                onSave(server, { showAdd = false }, onError)
            },
        )
    }

    confirmDelete?.let { s ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Remove connection?") },
            text = { Text("\"${s.name}\" will be disconnected.") },
            confirmButton = { TextButton(onClick = { onDelete(s.name); confirmDelete = null }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun McpSheet(
    onDismiss: () -> Unit,
    onSave: (McpServer, onError: (String) -> Unit) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var transport by remember { mutableStateOf("http") }
    var url by remember { mutableStateOf("") }
    var headers by remember { mutableStateOf("") }
    var command by remember { mutableStateOf("") }
    var allowHosts by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp)
                .heightIn(max = 620.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Add connection", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.lowercase().filter { c -> c.isLetterOrDigit() || c == '-' } },
                label = { Text("Name") },
                placeholder = { Text("github") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf("http" to "HTTP", "stdio" to "stdio").forEachIndexed { i, (value, label) ->
                    SegmentedButton(
                        selected = transport == value,
                        onClick = { transport = value },
                        shape = SegmentedButtonDefaults.itemShape(i, 2),
                    ) { Text(label) }
                }
            }
            if (transport == "http") {
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("Server URL") },
                    placeholder = { Text("https://mcp.example.com/mcp") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = headers,
                    onValueChange = { headers = it },
                    label = { Text("Headers (one per line, Name: value)") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                OutlinedTextField(
                    value = command,
                    onValueChange = { command = it },
                    label = { Text("Command + args (space-separated)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = allowHosts,
                    onValueChange = { allowHosts = it },
                    label = { Text("Allowed hosts (comma-separated; empty = no network)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onDismiss, modifier = Modifier.weight(1f)) { Text("Cancel") }
                Button(
                    onClick = {
                        val n = name.trim()
                        if (!Regex("^[a-z0-9][a-z0-9-]*$").matches(n)) {
                            error = "Name: lowercase letters, digits and hyphens only."
                            return@Button
                        }
                        val server = if (transport == "http") {
                            if (!Regex("^https?://").containsMatchIn(url.trim())) {
                                error = "Enter a full http(s) URL."
                                return@Button
                            }
                            McpServer(
                                name = n,
                                transport = "http",
                                enabled = true,
                                url = url.trim(),
                                headers = parseHeaders(headers),
                            )
                        } else {
                            val parts = command.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
                            if (parts.isEmpty()) {
                                error = "Enter a command to run."
                                return@Button
                            }
                            McpServer(
                                name = n,
                                transport = "stdio",
                                enabled = true,
                                command = parts.first(),
                                args = parts.drop(1),
                                allowHosts = allowHosts.split(",").map { it.trim() }.filter { it.isNotBlank() },
                            )
                        }
                        saving = true
                        error = null
                        onSave(server) { msg -> saving = false; error = msg }
                    },
                    enabled = !saving,
                    modifier = Modifier.weight(1f),
                ) { Text("Add & test") }
            }
        }
    }
}

private fun parseHeaders(text: String): Map<String, String>? {
    val out = text.lineSequence()
        .mapNotNull { line ->
            val i = line.indexOf(':')
            if (i < 1) null else line.substring(0, i).trim() to line.substring(i + 1).trim()
        }
        .toMap()
    return out.ifEmpty { null }
}
