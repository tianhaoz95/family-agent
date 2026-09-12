package app.familyagent.android.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.AGENT_SENDER_ID
import kotlinx.coroutines.launch
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

// "@agent" (aliases "@ai" / "@assistant") pulls the assistant into a family
// conversation — same trigger the server checks (mentionsAgent, agent-core).
// In the composer it rides the same chip affordance a "/" command gets in Chat.
private val MENTION_NAMES = listOf("agent", "ai", "assistant")
private val MENTION_LIFT = Regex("^@([A-Za-z]+)[ \\t]([\\s\\S]*)$")

/** The committed "@agent" pill shown to the left of the composer field. */
@Composable
private fun MentionChip(onRemove: () -> Unit) {
    Row(
        Modifier
            .padding(end = 6.dp)
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.primaryContainer)
            .padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "@agent",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
        )
        Spacer(Modifier.width(2.dp))
        Box(
            Modifier
                .size(18.dp)
                .clip(CircleShape)
                .clickable(onClick = onRemove),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Rounded.Close,
                contentDescription = "Remove @agent",
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.size(13.dp),
            )
        }
    }
}

@Composable
fun ConversationScreen(
    channel: Channel?,
    messages: List<Message>,
    sending: Boolean,
    currentUserId: String,
    onStepsClick: (List<app.familyagent.android.data.ToolStep>) -> Unit = {},
    onViewCardSource: (app.familyagent.android.data.Card) -> Unit = {},
    ttsEnabled: Boolean = false,
    voiceEnabled: Boolean = false,
    micOnLeft: Boolean = false,
    transcribing: Boolean = false,
    speakingText: String? = null,
    speakLoadingText: String? = null,
    onSpeak: (String) -> Unit = {},
    onSend: (String, List<String>) -> Unit,
    onVoiceSend: (ByteArray) -> Unit = {},
    onTranscribe: (ByteArray, (String) -> Unit) -> Unit = { _, _ -> },
    onDelete: () -> Unit,
    onBack: () -> Unit,
) {
    var input by remember { mutableStateOf("") }
    var mentionChip by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var attached by remember { mutableStateOf<List<String>>(emptyList()) }
    val listState = rememberLazyListState()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val recorder = remember { VoiceRecorder() }

    fun addUris(uris: List<Uri>) {
        scope.launch {
            val room = MAX_MESSAGE_IMAGES - attached.size
            val added = uris.take(room).mapNotNull { uriToScaledJpegDataUri(context, it) }
            if (added.isNotEmpty()) attached = attached + added
        }
    }
    val pickImages = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(MAX_MESSAGE_IMAGES),
    ) { uris -> if (uris.isNotEmpty()) addUris(uris) }

    // Type "@agent " (or pick it from the popup) and the mention lifts out of
    // the field into a pill; the field then holds only the message.
    fun onInput(v: String) {
        val m = if (!mentionChip) MENTION_LIFT.find(v) else null
        if (m != null && m.groupValues[1].lowercase() in MENTION_NAMES) {
            mentionChip = true
            input = m.groupValues[2]
        } else {
            input = v
        }
    }
    val submit = {
        if ((input.isNotBlank() || attached.isNotEmpty() || mentionChip) && !sending) {
            val body = if (mentionChip) "@agent ${input.trim()}".trimEnd() else input.trim()
            onSend(body, attached)
            input = ""
            mentionChip = false
            attached = emptyList()
        }
    }
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp)
            .padding(top = 8.dp, bottom = 8.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.background.copy(alpha = 0.94f)),
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
            }
            Spacer(Modifier.width(4.dp))
            Text(
                channel?.title?.ifBlank { "Conversation" } ?: "Conversation",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = { confirmDelete = true }) {
                Icon(Icons.Rounded.DeleteOutline, contentDescription = "Delete conversation")
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        if (confirmDelete) {
            AlertDialog(
                onDismissRequest = { confirmDelete = false },
                title = { Text("Delete conversation?") },
                text = { Text("Its messages are removed for everyone in it. This can't be undone.") },
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

        // The header row above now carries its own background — no separate
        // fade strip needed at the top of the message list itself.
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(vertical = 10.dp),
        ) {
            items(messages, key = { it.id }) { m ->
                MessageBubble(
                    m, own = m.senderId == currentUserId, channel,
                    ttsEnabled, speakingText, speakLoadingText, onSpeak, onStepsClick, onViewCardSource,
                )
            }
        }

        if (attached.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                attached.forEachIndexed { i, dataUri ->
                    Box(Modifier.size(56.dp)) {
                        val bmp = remember(dataUri) { dataUriToImageBitmap(dataUri) }
                        if (bmp != null) {
                            Image(
                                bitmap = bmp,
                                contentDescription = "attachment",
                                modifier = Modifier.matchParentSize().clip(RoundedCornerShape(10.dp)),
                                contentScale = ContentScale.Crop,
                            )
                        }
                        Box(
                            Modifier
                                .align(Alignment.TopEnd)
                                .padding(2.dp)
                                .size(18.dp)
                                .clip(CircleShape)
                                .background(Color(0x99000000))
                                .clickable { attached = attached.filterIndexed { j, _ -> j != i } },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(Icons.Rounded.Close, contentDescription = "Remove", tint = Color.White, modifier = Modifier.size(12.dp))
                        }
                    }
                }
            }
        }

        // "@" autocomplete — only while "@" + a partial word is still being
        // typed (no space yet), and no mention is committed. One row: @agent.
        val atQuery = input.takeIf {
            !mentionChip && it.startsWith("@") && !it.drop(1).contains(" ")
        }?.drop(1)
        if (atQuery != null && "agent".contains(atQuery, ignoreCase = true)) {
            Spacer(Modifier.height(8.dp))
            AppCard {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clickable {
                            mentionChip = true
                            input = ""
                        },
                ) {
                    Text("@agent", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "Bring in the assistant",
                        style = MaterialTheme.typography.bodySmall,
                        color = AppAccents.textSecondary,
                    )
                }
            }
        }

        Spacer(Modifier.height(8.dp))
        val mic: @Composable () -> Unit = {
            HoldToTalkMic(
                enabled = !sending,
                transcribing = transcribing,
                recorder = recorder,
                onDictate = { wav ->
                    onTranscribe(wav) { text ->
                        input = if (input.isBlank()) text else "${input.trimEnd()} $text"
                    }
                },
                onVoiceSend = onVoiceSend,
            )
        }
        // Two rows, Claude-app style: the text field (plus mention chip) on
        // top, attach/mic/send underneath — rather than everything crammed
        // into one row.
        Column(
            Modifier
                .fillMaxWidth()
                .shadow(5.dp, MaterialTheme.shapes.large, clip = false)
                .clip(MaterialTheme.shapes.large)
                .background(MaterialTheme.colorScheme.surface)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.large)
                .padding(horizontal = 8.dp, vertical = 6.dp),
        ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                if (mentionChip) MentionChip(onRemove = { mentionChip = false })
                TextField(
                    value = input,
                    onValueChange = { onInput(it) },
                    modifier = Modifier
                        .weight(1f)
                        .onPreviewKeyEvent { e ->
                            // Backspace on an empty field drops the whole @agent
                            // pill at once — never a partial "@age".
                            if (e.type == KeyEventType.KeyDown &&
                                e.key == Key.Backspace &&
                                mentionChip &&
                                input.isEmpty()
                            ) {
                                mentionChip = false
                                true
                            } else {
                                false
                            }
                        },
                    placeholder = {
                        Text(
                            if (mentionChip) "Message the assistant" else "Message, or @agent",
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    maxLines = 4,
                    // Return sends the message instead of inserting a newline —
                    // the composer only ever grows from wrapping, not manual breaks.
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { submit() }),
                    colors = TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                    ),
                )
            }
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(
                    onClick = {
                        pickImages.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    },
                    enabled = !sending && attached.size < MAX_MESSAGE_IMAGES,
                ) {
                    Icon(
                        Icons.Rounded.PhotoLibrary,
                        contentDescription = "Attach image",
                        modifier = Modifier.size(22.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
                if (voiceEnabled && micOnLeft) mic()
                Spacer(Modifier.weight(1f))
                if (voiceEnabled && !micOnLeft) mic()
                FilledIconButton(
                    onClick = submit,
                    enabled = (input.isNotBlank() || attached.isNotEmpty() || mentionChip) && !sending,
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier.size(46.dp),
                ) {
                    Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = "Send", modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}

private const val MAX_MESSAGE_IMAGES = 4

@Composable
private fun MessageBubble(
    msg: Message,
    own: Boolean,
    channel: Channel?,
    ttsEnabled: Boolean = false,
    speakingText: String? = null,
    speakLoadingText: String? = null,
    onSpeak: (String) -> Unit = {},
    onStepsClick: (List<app.familyagent.android.data.ToolStep>) -> Unit = {},
    onViewCardSource: (app.familyagent.android.data.Card) -> Unit = {},
) {
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
            // The assistant's reply is plain text (below), not a bubble, so
            // it gets more room — a 300dp cap on it would just wrap text
            // that has no visual container to justify staying narrow.
            Modifier.widthIn(max = if (agent) 480.dp else 300.dp),
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
            if (msg.images.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    msg.images.take(MAX_MESSAGE_IMAGES).forEach { dataUri ->
                        val bmp = remember(dataUri) { dataUriToImageBitmap(dataUri) }
                        if (bmp != null) {
                            Image(
                                bitmap = bmp,
                                contentDescription = "attached image",
                                modifier = Modifier
                                    .widthIn(max = 240.dp)
                                    .clip(RoundedCornerShape(14.dp)),
                                contentScale = ContentScale.FillWidth,
                            )
                        }
                    }
                }
                if (msg.body.isNotBlank()) Spacer(Modifier.height(4.dp))
            }
            // Claude-app style: only your own message gets a bubble — a
            // neutral grey, not the accent color. The assistant's reply is
            // just text, no bubble; another member's message keeps a bubble
            // too (still needed to read as "someone else's message", with
            // their name label above).
            val shape = if (own) RoundedCornerShape(20.dp, 20.dp, 6.dp, 20.dp)
            else RoundedCornerShape(20.dp, 20.dp, 20.dp, 6.dp)
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
                own -> Box(
                    Modifier
                        .background(MaterialTheme.colorScheme.surfaceContainerHighest, shape)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    Text(msg.body, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                }
                else -> Box(
                    Modifier
                        .background(MaterialTheme.colorScheme.surfaceVariant, shape)
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    Text(msg.body, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge)
                }
            }
            if (agent && msg.steps.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                StepsStrip(msg.steps, live = false) { onStepsClick(msg.steps) }
            }
            if (agent && msg.cards.isNotEmpty()) {
                msg.cards.take(2).forEach { c ->
                    Spacer(Modifier.height(8.dp))
                    CardView(c) { onViewCardSource(c) }
                }
            }
            if (agent && !msg.pending && msg.body.isNotBlank()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CopyButton(msg.body, Modifier.offset(x = (-4).dp))
                    if (ttsEnabled) {
                        SpeakButton(msg.body, speakingText, speakLoadingText, onSpeak, Modifier.offset(x = (-8).dp))
                    }
                }
            }
        }
    }
}
