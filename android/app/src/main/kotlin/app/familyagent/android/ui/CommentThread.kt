package app.familyagent.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.CommentReply
import app.familyagent.android.ui.theme.AppAccents
import kotlinx.coroutines.launch

/** A comment card: the anchored quote, the root message, every reply in the
 *  thread so far, and a reply composer — typing "@agent" in it brings the
 *  assistant into the discussion (repeatably; every reply, including a
 *  prior @agent one, is context for the next). Shared between the
 *  Artifacts and Wiki comment sheets — see docs/DECISIONS.md ->
 *  "Threaded comments". */
@Composable
fun CommentThreadCard(
    quote: String?,
    commentBody: String,
    authorLabel: String,
    replies: List<CommentReply>,
    status: String,
    onReply: suspend (String) -> Unit,
    onResolve: () -> Unit,
    onReopen: () -> Unit,
    onDelete: () -> Unit,
) {
    var draft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Surface(
        tonalElevation = if (status == "resolved") 0.dp else 1.dp,
        shape = MaterialTheme.shapes.medium,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (!quote.isNullOrEmpty()) {
                Text("“${quote.take(140)}”", style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
            }
            Row {
                Text("$authorLabel: ", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(commentBody, style = MaterialTheme.typography.bodyMedium)
            }

            if (replies.isNotEmpty()) {
                Column(
                    Modifier.padding(start = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    for (r in replies) {
                        Row {
                            Text(
                                "${r.authorName}: ",
                                style = MaterialTheme.typography.bodySmall,
                                fontWeight = FontWeight.SemiBold,
                                color = if (r.author == "agent") MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                            )
                            Text(r.body, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                if (status == "resolved") {
                    TextButton(onClick = onReopen, contentPadding = PaddingValues(0.dp)) { Text("Reopen") }
                } else {
                    TextButton(onClick = onResolve, contentPadding = PaddingValues(0.dp)) { Text("Resolve") }
                }
                TextButton(onClick = onDelete, contentPadding = PaddingValues(0.dp)) {
                    Text("Delete", color = MaterialTheme.colorScheme.error)
                }
            }

            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.weight(1f),
                    placeholder = { Text("Reply, or type @agent…") },
                    singleLine = true,
                    enabled = !sending,
                )
                TextButton(
                    enabled = !sending && draft.isNotBlank(),
                    onClick = {
                        val body = draft
                        sending = true
                        scope.launch {
                            onReply(body)
                            draft = ""
                            sending = false
                        }
                    },
                ) { Text("Send") }
            }
        }
    }
}
