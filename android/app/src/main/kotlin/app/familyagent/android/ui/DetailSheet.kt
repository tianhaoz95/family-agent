package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.familyagent.android.DetailContent
import app.familyagent.android.data.ToolStep
import app.familyagent.android.ui.theme.AppAccents
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/** One bottom-sheet used for both "assistant referenced this" and "preview this document". */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailSheet(content: DetailContent, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp)
                .heightIn(max = 560.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            when (content) {
                is DetailContent.Loading -> Row(
                    Modifier.fillMaxWidth().padding(24.dp),
                    horizontalArrangement = Arrangement.Center,
                ) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }

                is DetailContent.Failed -> Text(
                    content.message,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.error,
                )

                is DetailContent.TaskDetail -> {
                    val t = content.task
                    Text(t.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    Chip(if (t.status == "done") "done" else "open")
                    if (t.dueDate != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Due ${t.dueDate}" + (t.dueTime?.let { " at $it" } ?: ""),
                            style = MaterialTheme.typography.bodyMedium,
                            color = AppAccents.textSecondary,
                        )
                    }
                    if (!t.notes.isNullOrBlank()) {
                        Spacer(Modifier.height(10.dp))
                        Text(t.notes, style = MaterialTheme.typography.bodyLarge)
                    }
                    Spacer(Modifier.height(12.dp))
                    Text(
                        "Open the Events tab to reschedule or complete it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = AppAccents.textSecondary,
                    )
                }

                is DetailContent.CardSource -> {
                    Text("Card source", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(4.dp))
                    Text(content.title, style = MaterialTheme.typography.bodyMedium, color = AppAccents.textSecondary)
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "The HTML the assistant wrote. It runs sandboxed — no network, no access to the app.",
                        style = MaterialTheme.typography.bodySmall,
                        color = AppAccents.textSecondary,
                    )
                    Spacer(Modifier.height(10.dp))
                    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
                        Text(
                            content.fragment,
                            modifier = Modifier.fillMaxWidth().padding(12.dp),
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }

                is DetailContent.Steps -> {
                    Text("Under the hood", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "Every tool the assistant called for this reply, in order — the exact arguments it passed and what came back.",
                        style = MaterialTheme.typography.bodySmall,
                        color = AppAccents.textSecondary,
                    )
                    Spacer(Modifier.height(14.dp))
                    if (content.steps.isEmpty()) {
                        Text(
                            "No tools were called — the assistant answered directly.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = AppAccents.textSecondary,
                        )
                    }
                    content.steps.forEachIndexed { i, s ->
                        StepDetailCard(i + 1, s)
                        Spacer(Modifier.height(12.dp))
                    }
                }

                is DetailContent.DocumentDetail -> {
                    val d = content.doc
                    Text(d.filename, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    d.extracted?.category?.let {
                        Spacer(Modifier.height(6.dp))
                        Chip(it)
                    }
                    d.extracted?.summary?.let {
                        Spacer(Modifier.height(10.dp))
                        Text(it, style = MaterialTheme.typography.bodyLarge)
                    }
                    d.extracted?.importantDates?.takeIf { it.isNotEmpty() }?.let {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            "Important dates: ${it.joinToString(", ")}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = AppAccents.textSecondary,
                        )
                    }
                    Spacer(Modifier.height(14.dp))

                    val isPdf = d.originalMime == "application/pdf" ||
                        d.filename.endsWith(".pdf", ignoreCase = true)
                    if (isPdf && content.pdfBytes != null) {
                        PdfPreview(content.pdfBytes)
                        Spacer(Modifier.height(12.dp))
                        Text(
                            "Extracted text",
                            style = MaterialTheme.typography.labelMedium,
                            color = AppAccents.textSecondary,
                        )
                        Spacer(Modifier.height(6.dp))
                    } else if (isPdf) {
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 16.dp),
                            horizontalArrangement = Arrangement.Center,
                        ) { CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) }
                    }

                    Surface(
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        shape = MaterialTheme.shapes.medium,
                    ) {
                        Text(
                            d.rawText,
                            modifier = Modifier.padding(12.dp),
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        }
    }
}

private val stepJson = Json { prettyPrint = true }

/** Friendly verb for a tool name — mirrors STEP_VERBS in desktop main.ts. */
fun stepVerb(s: ToolStep): String {
    if (s.tool == "task" && !s.subagent.isNullOrBlank()) return "Delegated to ${s.subagent}"
    return when (s.tool) {
        "search_documents" -> "Searched documents"
        "list_documents" -> "Listed documents"
        "read_document" -> "Read a document"
        "search_tasks" -> "Searched tasks"
        "list_tasks" -> "Listed tasks"
        "create_task" -> "Created a task"
        "complete_task" -> "Completed a task"
        "list_sticky_notes" -> "Read the notes board"
        "add_sticky_note" -> "Pinned a note"
        "run_code" -> "Ran a calculation"
        "web_search" -> "Searched the web"
        "open_page" -> "Opened a web page"
        "call_family_tool" -> "Used a family tool"
        "call_mcp_tool" -> "Called a connected service"
        "use_skill" -> "Loaded a skill"
        "current_datetime" -> "Checked the date"
        else -> s.tool.replace('_', ' ')
    }
}

private fun prettyInput(el: JsonElement?): String {
    if (el == null) return "(no arguments)"
    return runCatching { stepJson.encodeToString(JsonElement.serializer(), el) }.getOrElse { el.toString() }
}

@Composable
private fun StepDetailCard(n: Int, s: ToolStep) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shape = MaterialTheme.shapes.medium,
    ) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text("$n", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.width(8.dp))
                Text(stepVerb(s), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                s.durationMs?.let {
                    Text(
                        if (it < 1000) "${it}ms" else "%.1fs".format(it / 1000.0),
                        style = MaterialTheme.typography.labelSmall,
                        color = AppAccents.textSecondary,
                    )
                }
            }
            Spacer(Modifier.height(2.dp))
            Text(s.tool, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = AppAccents.textSecondary)
            Spacer(Modifier.height(8.dp))
            Text("CALLED WITH", style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
            MonoBlock(prettyInput(s.input))
            if (s.error != null) {
                Spacer(Modifier.height(8.dp))
                Text("ERROR", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                MonoBlock(s.error)
            } else if (s.output != null) {
                Spacer(Modifier.height(8.dp))
                Text("RETURNED", style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
                MonoBlock(s.output.ifBlank { "(empty)" })
            }
        }
    }
}

@Composable
private fun MonoBlock(text: String) {
    Spacer(Modifier.height(4.dp))
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.small) {
        Text(
            text,
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
        )
    }
}
