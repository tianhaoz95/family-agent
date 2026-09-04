package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.ChatSession
import app.familyagent.android.ui.theme.AppAccents

/**
 * Past assistant chat sessions — private to this account. Reached from a
 * "History" button on the Chat tab (see ChatScreen); opening a row loads that
 * session's messages back into the same Chat screen (see AppViewModel.openChatSession).
 */
@Composable
fun ChatSessionsScreen(
    sessions: List<ChatSession>,
    onRefresh: () -> Unit,
    onOpen: (String) -> Unit,
    onDelete: (String) -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }

    ScreenScaffold(
        title = "Chat history",
        subtitle = "Past conversations with the assistant — pick one to pick up where it left off.",
    ) {
        if (sessions.isEmpty()) {
            EmptyState(
                text = "No conversations yet.",
                modifier = Modifier.weight(1f),
                icon = {
                    Icon(
                        Icons.AutoMirrored.Rounded.Chat,
                        contentDescription = null,
                        modifier = Modifier.size(32.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(sessions, key = { it.id }) { session ->
                    ChatSessionRow(session, onClick = { onOpen(session.id) }, onDelete = { onDelete(session.id) })
                }
            }
        }
    }
}

@Composable
private fun ChatSessionRow(session: ChatSession, onClick: () -> Unit, onDelete: () -> Unit) {
    var confirmDelete by remember { mutableStateOf(false) }

    AppCard(onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    session.title,
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    session.lastMessage ?: "No messages yet",
                    style = MaterialTheme.typography.bodyMedium,
                    color = AppAccents.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = { confirmDelete = true }) {
                Icon(Icons.Rounded.DeleteOutline, contentDescription = "Delete this conversation")
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete this conversation?") },
            text = { Text("This can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    onDelete()
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text("Cancel") }
            },
        )
    }
}
