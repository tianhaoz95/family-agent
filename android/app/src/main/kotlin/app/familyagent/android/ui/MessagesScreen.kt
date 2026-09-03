package app.familyagent.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.AGENT_SENDER_ID
import app.familyagent.android.data.Channel
import app.familyagent.android.data.FamilyMember
import app.familyagent.android.data.Message
import app.familyagent.android.ui.theme.AppAccents
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography

@Composable
fun MessagesScreen(
    channels: List<Channel>,
    familyMembers: List<FamilyMember>,
    currentUserId: String,
    onOpenChannel: (String) -> Unit,
    onStartConversation: (List<String>, String?) -> Unit,
    onRefresh: () -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }
    var composing by remember { mutableStateOf(false) }

    ScreenScaffold(
        title = "Messages",
        subtitle = "Chat with the family. Type @agent to pull in the assistant.",
    ) {
        Button(
            onClick = { composing = !composing },
            shape = MaterialTheme.shapes.small,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("New conversation")
        }

        if (composing) {
            Spacer(Modifier.height(12.dp))
            NewConversationForm(
                members = familyMembers.filter { it.id != currentUserId },
                onCancel = { composing = false },
                onStart = { ids, name ->
                    composing = false
                    onStartConversation(ids, name)
                },
            )
        }

        Spacer(Modifier.height(16.dp))
        if (channels.isEmpty()) {
            EmptyState(text = "No conversations yet. Start one above.", modifier = Modifier.weight(1f))
        } else {
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(channels, key = { it.id }) { ch -> ChannelRow(ch) { onOpenChannel(ch.id) } }
            }
        }
    }
}

@Composable
private fun ChannelRow(channel: Channel, onClick: () -> Unit) {
    AppCard(onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(
                    channel.title.ifBlank { "Conversation" },
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )
                val preview = channel.lastMessage?.let {
                    if (it.pending) "Assistant is typing…" else it.body
                } ?: "No messages yet"
                Text(
                    preview,
                    style = MaterialTheme.typography.bodyMedium,
                    color = AppAccents.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (channel.unreadCount > 0) {
                Spacer(Modifier.width(8.dp))
                Badge { Text(if (channel.unreadCount > 99) "99+" else channel.unreadCount.toString()) }
            }
        }
    }
}

@Composable
private fun NewConversationForm(
    members: List<FamilyMember>,
    onCancel: () -> Unit,
    onStart: (List<String>, String?) -> Unit,
) {
    val picked = remember { mutableStateListOf<String>() }
    var groupName by remember { mutableStateOf("") }

    AppCard {
        Text("Pick people", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))
        members.forEach { m ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable {
                        if (picked.contains(m.id)) picked.remove(m.id) else picked.add(m.id)
                    }
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = picked.contains(m.id), onCheckedChange = null)
                Spacer(Modifier.width(8.dp))
                Text(m.displayName, style = MaterialTheme.typography.bodyLarge)
            }
        }
        if (picked.size > 1) {
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = groupName,
                onValueChange = { groupName = it },
                label = { Text("Group name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onStart(picked.toList(), groupName.takeIf { it.isNotBlank() }) },
                enabled = picked.isNotEmpty() && (picked.size == 1 || groupName.isNotBlank()),
            ) { Text("Start") }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

@Composable
fun ConversationScreen(
    channel: Channel?,
    messages: List<Message>,
    sending: Boolean,
    currentUserId: String,
    onSend: (String) -> Unit,
    onBack: () -> Unit,
) {
    var input by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 16.dp)
            .padding(top = 8.dp, bottom = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
            }
            Spacer(Modifier.width(4.dp))
            Text(
                channel?.title?.ifBlank { "Conversation" } ?: "Conversation",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
            )
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(vertical = 10.dp),
        ) {
            items(messages, key = { it.id }) { m -> MessageBubble(m, own = m.senderId == currentUserId, channel) }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .clip(MaterialTheme.shapes.large)
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .padding(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message… (@agent for the assistant)") },
                maxLines = 4,
                keyboardOptions = KeyboardOptions.Default,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    disabledIndicatorColor = Color.Transparent,
                ),
            )
            FilledIconButton(
                onClick = {
                    if (input.isNotBlank()) {
                        onSend(input.trim())
                        input = ""
                    }
                },
                enabled = input.isNotBlank() && !sending,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.size(46.dp),
            ) {
                Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = "Send", modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
private fun MessageBubble(msg: Message, own: Boolean, channel: Channel?) {
    val agent = msg.senderId == AGENT_SENDER_ID
    val senderName = when {
        agent -> "Assistant"
        own -> "You"
        else -> channel?.members?.firstOrNull { it.id == msg.senderId }?.displayName ?: "Someone"
    }
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (own) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            Modifier.widthIn(max = 300.dp),
            horizontalAlignment = if (own) Alignment.End else Alignment.Start,
        ) {
            if (!own) {
                Text(
                    senderName,
                    style = MaterialTheme.typography.labelSmall,
                    color = AppAccents.textSecondary,
                    modifier = Modifier.padding(start = 6.dp, bottom = 2.dp),
                )
            }
            val shape = if (own) RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp)
            else RoundedCornerShape(20.dp, 20.dp, 20.dp, 6.dp)
            val bg = when {
                own -> MaterialTheme.colorScheme.primary
                agent -> AppAccents.cyanTint
                else -> MaterialTheme.colorScheme.surfaceVariant
            }
            Box(Modifier.background(bg, shape).padding(horizontal = 14.dp, vertical = 10.dp)) {
                when {
                    msg.pending -> Text(
                        "Assistant is typing…",
                        style = MaterialTheme.typography.bodyMedium,
                        color = AppAccents.textSecondary,
                    )
                    agent -> Markdown(
                        content = msg.body,
                        colors = markdownColor(text = MaterialTheme.colorScheme.onSurface),
                        typography = markdownTypography(),
                    )
                    else -> Text(
                        msg.body,
                        color = if (own) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
        }
    }
}
