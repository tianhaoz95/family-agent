package app.familyagent.android.ui

import androidx.compose.foundation.background
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.Tool
import app.familyagent.android.data.ToolOperation
import app.familyagent.android.data.ToolRevision
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
    onLoadOperations: suspend (id: String) -> List<ToolOperation> = { emptyList() },
    onLoadRevisions: suspend (id: String) -> List<ToolRevision> = { emptyList() },
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
                    ToolCard(tool, toolsBaseUrl, onOpen, onDelete, onIterate, onRevert, onInspectData, onLoadOperations, onLoadRevisions)
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
    onLoadOperations: suspend (id: String) -> List<ToolOperation>,
    onLoadRevisions: suspend (id: String) -> List<ToolRevision>,
) {
    // Which of "Fix it" / "Improve" is expanded into its inline instruction
    // field, if either — collapsed by default, one at a time (there's only
    // ever one visible per card anyway, but this also resets across recomposition).
    var improving by remember(tool.id) { mutableStateOf(false) }
    val revising = tool.revisionState == "revising"

    // The release-notes timeline — collapsed by default, fetched lazily the
    // first time it's opened (mirrors desktop's toggleToolHistory).
    var historyOpen by remember(tool.id) { mutableStateOf(false) }
    var historyLoading by remember(tool.id) { mutableStateOf(false) }
    var revisions by remember(tool.id) { mutableStateOf<List<ToolRevision>>(emptyList()) }
    LaunchedEffect(tool.id, historyOpen) {
        if (historyOpen && revisions.isEmpty()) {
            historyLoading = true
            revisions = runCatching { onLoadRevisions(tool.id) }.getOrDefault(emptyList())
            historyLoading = false
        }
    }

    // What the chat assistant can actually do with this tool — fetched once
    // per ready tool (its operations don't change without an improve, which
    // already re-keys this via tool.revisionCount below).
    var operationPhrases by remember(tool.id) { mutableStateOf<List<String>>(emptyList()) }
    LaunchedEffect(tool.id, tool.status, tool.revisionCount) {
        operationPhrases = if (tool.status == "ready") {
            runCatching { onLoadOperations(tool.id) }.getOrDefault(emptyList())
                .map { humanizeOperation(it) }
                .filter { it.isNotBlank() }
        } else {
            emptyList()
        }
    }

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
                    OutlinedButton(
                        onClick = { historyOpen = !historyOpen },
                        shape = RoundedCornerShape(12.dp),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        Text(if (historyOpen) "Hide history" else "History")
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
                // What the assistant can do with this tool without opening
                // it — the same operations the chat agent's call_family_tool
                // sees, in plain language instead of a snake_case name.
                if (operationPhrases.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "IN CHAT YOU CAN",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = AppAccents.textSecondary,
                    )
                    Spacer(Modifier.height(2.dp))
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        operationPhrases.forEach { phrase ->
                            Text(
                                "• $phrase",
                                style = MaterialTheme.typography.bodySmall,
                                color = AppAccents.textSecondary,
                            )
                        }
                    }
                }
                // "What was asked for, on the way there" — the release-notes
                // timeline, not just the "improved N times" counter above.
                if (historyOpen) {
                    Spacer(Modifier.height(10.dp))
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    Spacer(Modifier.height(10.dp))
                    when {
                        historyLoading -> Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(8.dp))
                            Text("Loading…", style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
                        }
                        revisions.isEmpty() -> Text(
                            "No history yet.",
                            style = MaterialTheme.typography.bodySmall,
                            color = AppAccents.textSecondary,
                        )
                        else -> ToolHistoryTimeline(revisions)
                    }
                }
            }
        }
    }
}

/** One dot-and-line entry per build/improve/revert attempt, newest first —
 *  mirrors desktop's .tool-history-* timeline exactly (see style.css). */
@Composable
private fun ToolHistoryTimeline(revisions: List<ToolRevision>) {
    Column {
        revisions.forEachIndexed { index, r ->
            Row {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(20.dp)) {
                    Box(
                        modifier = Modifier
                            .padding(top = 4.dp)
                            .size(8.dp)
                            .background(
                                if (r.ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                                shape = androidx.compose.foundation.shape.CircleShape,
                            ),
                    )
                    if (index < revisions.lastIndex) {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .width(1.dp)
                                .background(MaterialTheme.colorScheme.outlineVariant),
                        )
                    }
                }
                Spacer(Modifier.width(8.dp))
                Column(modifier = Modifier.padding(bottom = 14.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            toolRevisionLabel(r),
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = if (r.ok) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error,
                        )
                        Text(
                            relativeTime(r.createdAt),
                            style = MaterialTheme.typography.labelSmall,
                            color = AppAccents.textSecondary,
                        )
                    }
                    if (r.instruction != null) {
                        Text(
                            "“${r.instruction}”",
                            style = MaterialTheme.typography.bodySmall.copy(fontStyle = androidx.compose.ui.text.font.FontStyle.Italic),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (r.message != null) {
                        Text(
                            r.message,
                            style = MaterialTheme.typography.bodySmall,
                            color = AppAccents.textSecondary,
                        )
                    }
                }
            }
        }
    }
}

/** "Just now" / "Yesterday" / "Wednesday" / "Sep 5" — mirrors desktop's
 *  relativeTime() in format.ts. */
private fun relativeTime(iso: String): String = runCatching {
    val instant = java.time.Instant.parse(iso)
    val zdt = instant.atZone(java.time.ZoneId.systemDefault())
    val now = java.time.ZonedDateTime.now()
    val secs = java.time.Duration.between(instant, java.time.Instant.now()).seconds
    val today = now.toLocalDate()
    val days = java.time.temporal.ChronoUnit.DAYS.between(zdt.toLocalDate(), today)
    when {
        secs < 45 -> "just now"
        secs < 90 -> "a minute ago"
        secs < 3600 -> "${secs / 60} min ago"
        days == 0L -> zdt.format(java.time.format.DateTimeFormatter.ofPattern("h:mm a"))
        days == 1L -> "Yesterday"
        days < 7 -> zdt.format(java.time.format.DateTimeFormatter.ofPattern("EEEE"))
        else -> zdt.format(java.time.format.DateTimeFormatter.ofPattern("MMM d"))
    }
}.getOrDefault("")

private fun toolRevisionLabel(r: ToolRevision): String = when (r.kind) {
    "build" -> if (r.ok) "Created" else "Build failed"
    "revert" -> "Reverted"
    else -> if (r.ok) "Improved" else "Improve failed"
}

// Turn a tool operation into a plain imperative phrase a family member can
// read, e.g. { name: "add_loan", description: "Record that someone borrowed
// an item" } → "record that someone borrowed an item". No snake_case, no
// jargon. Mirrors desktop's own humanizeOperation/OP_VERBS in main.ts.
private val OP_VERBS = Regex(
    "^(record|log|list|show|display|add|create|save|store|mark|remove|delete|update|edit|change|rename|find|" +
        "look up|search|get|see|view|browse|track|check|set|clear|count|split|calculate|total|note|pick|choose|send)\\b",
    RegexOption.IGNORE_CASE,
)

private fun humanizeOperation(o: ToolOperation): String {
    val d = o.description.trim().removeSuffix(".")
    if (d.isNotEmpty() && OP_VERBS.containsMatchIn(d)) return d.replaceFirstChar { it.lowercaseChar() }
    if (d.isNotEmpty()) return "see ${d.replaceFirstChar { it.lowercaseChar() }}"
    val name = o.name.replace("_", " ").trim()
    if (name.isEmpty()) return ""
    return if (o.access == "read") "see $name" else name
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
