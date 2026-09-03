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
import app.familyagent.android.ui.theme.AppAccents

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
