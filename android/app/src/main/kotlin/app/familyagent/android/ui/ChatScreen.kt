package app.familyagent.android.ui

import android.content.Context
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.automirrored.rounded.HelpOutline
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.familyagent.android.ChatMessage
import app.familyagent.android.data.ChatReference
import app.familyagent.android.data.Tool
import app.familyagent.android.ui.theme.AppAccents
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private const val MAX_IMAGES = 4

/** A TextFieldValue with the cursor placed at the end — plain-string
 *  assignment to a TextField's value resets the cursor to the start on
 *  recomposition, which is wrong for programmatic inserts (voice transcript,
 *  the "/" tool picker). */
private fun endOf(text: String) = TextFieldValue(text, TextRange(text.length))

/** "/" autocomplete: a fixed set of forced-agent commands (see
 *  parseForcedAgentCommand, agent-core/src/agents/index.ts — keep these in
 *  sync with FORCED_AGENT_KEYWORDS there) plus the family's own tool names.
 *  "search" (→ find) and "remind" (→ schedule) are hand-typeable aliases, not
 *  listed separately, to keep this short. */
private val SLASH_COMMANDS = listOf(
    "build" to "Build a new tool, or improve an existing one",
    "task" to "Add, list, or complete a to-do",
    "find" to "Search the family's documents (alias: /search)",
    "note" to "Read or add a sticky note",
    "schedule" to "Create or manage a scheduled routine (alias: /remind)",
    "web" to "Search the web and read a page (alias: /lookup)",
    "run" to "Process a file with command-line tools (alias: /shell)",
    "calc" to "Compute an exact answer — maths, dates, totals (alias: /compute)",
    "skill" to "Use one of the family's taught skills",
    "connect" to "Use a connected external service (alias: /mcp)",
)

@Composable
fun ChatScreen(
    messages: List<ChatMessage>,
    sending: Boolean,
    voiceEnabled: Boolean,
    transcribing: Boolean,
    ttsEnabled: Boolean = false,
    speakingText: String? = null,
    speakLoadingText: String? = null,
    onSpeak: (String) -> Unit = {},
    onSend: (String, List<String>) -> Unit,
    onTranscribe: (ByteArray, (String) -> Unit) -> Unit,
    onVoiceSend: (ByteArray) -> Unit = {},
    onReferenceClick: (ChatReference) -> Unit = {},
    onNewChat: () -> Unit = {},
    onOpenHistory: () -> Unit = {},
    tools: List<Tool> = emptyList(),
    onRefreshTools: () -> Unit = {},
) {
    // Chat is the app's start destination, so it never goes through
    // MainActivity's navigateTo — fetch the tool list ourselves (same
    // self-refresh pattern MessagesScreen/ChatSessionsScreen use) so the "/"
    // autocomplete works without a prior visit to the Tools tab.
    LaunchedEffect(Unit) { onRefreshTools() }
    var showSlashHelp by remember { mutableStateOf(false) }
    val context = LocalContext.current
    var input by remember { mutableStateOf(TextFieldValue("")) }
    var attached by remember { mutableStateOf<List<String>>(emptyList()) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }
    var attachMenuOpen by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    // ---- voice input ---- (HoldToTalkMic owns the recorder + gestures)
    val recorder = remember { VoiceRecorder() }

    fun addUris(uris: List<Uri>) {
        scope.launch {
            val room = MAX_IMAGES - attached.size
            val added = uris.take(room).mapNotNull { uriToScaledJpegDataUri(context, it) }
            if (added.isNotEmpty()) attached = attached + added
        }
    }

    val pickImages = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(MAX_IMAGES),
    ) { uris -> if (uris.isNotEmpty()) addUris(uris) }

    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = pendingCameraUri
        if (ok && uri != null) addUris(listOf(uri))
        pendingCameraUri = null
    }

    LaunchedEffect(messages.size, sending) {
        val count = messages.size + if (sending) 1 else 0
        if (count > 0) listState.animateScrollToItem(count - 1)
    }

    ScreenScaffold(
        title = "Chat",
        subtitle = "Ask about tasks, documents, or anything else — routed locally.",
    ) {
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
        ) {
            TextButton(onClick = onNewChat) {
                Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("New")
            }
            TextButton(onClick = onOpenHistory) {
                Icon(Icons.Rounded.History, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text("History")
            }
            IconButton(onClick = { showSlashHelp = true }) {
                Icon(Icons.AutoMirrored.Rounded.HelpOutline, contentDescription = "Slash commands", modifier = Modifier.size(18.dp))
            }
        }
        Spacer(Modifier.height(4.dp))

        if (showSlashHelp) {
            SlashHelpSheet(tools = tools, onDismiss = { showSlashHelp = false })
        }

        if (messages.isEmpty() && !sending) {
            EmptyState(
                text = "Start a conversation. Try “Remind me to renew the car registration by Nov 1”, or attach a photo.",
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
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(vertical = 4.dp),
            ) {
                items(messages) { msg ->
                    ChatBubble(msg, onReferenceClick, ttsEnabled, speakingText, speakLoadingText, onSpeak)
                }
                if (sending) {
                    item {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
                            TypingDots()
                        }
                    }
                }
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

        // "/" autocomplete — only while the "/" and a partial command/tool
        // name are still being typed (no space yet); once there's a space,
        // the text after it is the request itself, not still picking one.
        // Only ready, server-kind tools are offered — a static (display-only)
        // tool has no operations to call via the tools API at all.
        val slashQuery = input.text.takeIf { it.startsWith("/") && !it.drop(1).contains(" ") }?.drop(1)
        if (slashQuery != null) {
            val toolEntries = tools
                .filter { it.kind == "server" && it.status == "ready" }
                .map { it.name to it.description }
            val matches = (SLASH_COMMANDS + toolEntries).filter { (name, _) ->
                name.contains(slashQuery, ignoreCase = true)
            }
            Spacer(Modifier.height(8.dp))
            AppCard {
                if (matches.isEmpty()) {
                    Text(
                        "No matching commands or tools.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = AppAccents.textSecondary,
                    )
                } else {
                    Column {
                        matches.forEachIndexed { i, (name, description) ->
                            if (i > 0) Spacer(Modifier.height(8.dp))
                            Column(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable { input = endOf("/$name ") },
                            ) {
                                Text(name, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    description,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = AppAccents.textSecondary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(10.dp))
        val submit = {
            if ((input.text.isNotBlank() || attached.isNotEmpty()) && !sending) {
                onSend(input.text.trim(), attached)
                input = TextFieldValue("")
                attached = emptyList()
            }
        }
        Row(
            Modifier
                .fillMaxWidth()
                .shadow(5.dp, RoundedCornerShape(20.dp), clip = false)
                .clip(RoundedCornerShape(20.dp))
                .background(MaterialTheme.colorScheme.surface)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(20.dp))
                .padding(start = 6.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box {
                IconButton(onClick = { attachMenuOpen = true }, enabled = !sending && attached.size < MAX_IMAGES) {
                    Icon(
                        Icons.Rounded.PhotoLibrary,
                        contentDescription = "Attach image",
                        modifier = Modifier.size(22.dp),
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
                DropdownMenu(expanded = attachMenuOpen, onDismissRequest = { attachMenuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("Photo library") },
                        leadingIcon = { Icon(Icons.Rounded.PhotoLibrary, contentDescription = null) },
                        onClick = {
                            attachMenuOpen = false
                            pickImages.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Take photo") },
                        leadingIcon = { Icon(Icons.Rounded.PhotoCamera, contentDescription = null) },
                        onClick = {
                            attachMenuOpen = false
                            val uri = createChatPhotoUri(context)
                            pendingCameraUri = uri
                            takePhoto.launch(uri)
                        },
                    )
                }
            }
            if (voiceEnabled) {
                HoldToTalkMic(
                    enabled = !sending,
                    transcribing = transcribing,
                    recorder = recorder,
                    onDictate = { wav ->
                        onTranscribe(wav) { text ->
                            input = endOf(if (input.text.isBlank()) text else "${input.text.trimEnd()} $text")
                        }
                    },
                    onVoiceSend = onVoiceSend,
                )
            }
            TextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = {
                    Text(
                        "Ask anything, or type /",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                maxLines = 4,
                textStyle = MaterialTheme.typography.bodyLarge,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Transparent,
                    unfocusedContainerColor = Color.Transparent,
                    disabledContainerColor = Color.Transparent,
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    disabledIndicatorColor = Color.Transparent,
                ),
            )
            FilledIconButton(
                onClick = submit,
                enabled = !sending && (input.text.isNotBlank() || attached.isNotEmpty()),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.size(46.dp),
            ) {
                Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = "Send", modifier = Modifier.size(20.dp))
            }
        }
    }
}

private fun createChatPhotoUri(context: Context): Uri {
    val dir = File(context.cacheDir, "chat").apply { mkdirs() }
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
    val file = File(dir, "photo-$stamp.jpg")
    return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
}

/** Explains the "/" forced-agent commands — the same bottom-sheet pattern
 *  DetailSheet.kt uses for reference/document previews, but self-contained
 *  here since the content is static plus the tools ChatScreen already has. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SlashHelpSheet(tools: List<Tool>, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp)
                .heightIn(max = 560.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text("Slash commands", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            Text(
                "Start a message with \"/\" to skip the assistant's own routing and send that turn straight to " +
                    "one specialist — useful when it doesn't otherwise pick the right one.",
                style = MaterialTheme.typography.bodyMedium,
                color = AppAccents.textSecondary,
            )
            Spacer(Modifier.height(16.dp))
            Text("Commands", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            SLASH_COMMANDS.forEach { (name, description) -> SlashHelpRow("/$name", description) }
            Spacer(Modifier.height(16.dp))
            Text("Or one of the family's tools, by name", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            val readyTools = tools.filter { it.kind == "server" && it.status == "ready" }
            if (readyTools.isEmpty()) {
                Text(
                    "The family hasn't built any tools yet — see the Tools tab.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = AppAccents.textSecondary,
                )
            } else {
                readyTools.forEach { SlashHelpRow("/${it.name}", it.description) }
            }
        }
    }
}

@Composable
private fun SlashHelpRow(command: String, description: String) {
    Column(Modifier.padding(vertical = 4.dp)) {
        Text(command, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.bodyMedium)
        Text(description, style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun ChatBubble(
    msg: ChatMessage,
    onReferenceClick: (ChatReference) -> Unit = {},
    ttsEnabled: Boolean = false,
    speakingText: String? = null,
    speakLoadingText: String? = null,
    onSpeak: (String) -> Unit = {},
) {
    val isUser = msg.role == "user"
    Column(horizontalAlignment = if (isUser) Alignment.End else Alignment.Start) {
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        val shape = if (isUser) {
            RoundedCornerShape(22.dp, 22.dp, 6.dp, 22.dp)
        } else {
            RoundedCornerShape(22.dp, 22.dp, 22.dp, 6.dp)
        }
        val bubbleColor = if (isUser) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        }
        Column(
            modifier = Modifier
                .background(bubbleColor, shape)
                .widthIn(max = 300.dp)
                .padding(horizontal = 14.dp, vertical = 11.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (msg.images.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    msg.images.take(MAX_IMAGES).forEach { dataUri ->
                        val bmp = remember(dataUri) { dataUriToImageBitmap(dataUri) }
                        if (bmp != null) {
                            Image(
                                bitmap = bmp,
                                contentDescription = "attached image",
                                modifier = Modifier.size(120.dp).clip(RoundedCornerShape(10.dp)),
                                contentScale = ContentScale.Crop,
                            )
                        }
                    }
                }
            }
            if (msg.text.isNotBlank()) {
                val textColor =
                    if (isUser) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface
                if (isUser) {
                    // The user types plain text — no need to parse it as Markdown.
                    // A "/" turn forced a specific specialist agent instead of
                    // the planner — flag it so it's obvious at a glance which
                    // turns did (see parseForcedAgentCommand, agent-core).
                    if (msg.text.trimStart().startsWith("/")) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                Icons.Rounded.Build,
                                contentDescription = "Sent straight to a specialist agent — skipped the planner",
                                modifier = Modifier.size(14.dp),
                                tint = textColor.copy(alpha = 0.75f),
                            )
                            Spacer(Modifier.width(5.dp))
                            Text(msg.text, color = textColor, style = MaterialTheme.typography.bodyLarge)
                        }
                    } else {
                        Text(msg.text, color = textColor, style = MaterialTheme.typography.bodyLarge)
                    }
                } else {
                    // The planner model replies in Markdown; render it.
                    Markdown(
                        content = msg.text,
                        colors = markdownColor(text = textColor),
                        typography = markdownTypography(),
                    )
                }
            }
        }
    }
    if (!isUser && msg.text.isNotBlank()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CopyButton(msg.text, Modifier.offset(x = (-4).dp))
            if (ttsEnabled) {
                SpeakButton(msg.text, speakingText, speakLoadingText, onSpeak, Modifier.offset(x = (-8).dp))
            }
        }
    }
    if (!isUser && msg.references.isNotEmpty()) {
        Spacer(Modifier.height(6.dp))
        androidx.compose.foundation.layout.FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            val ctx = androidx.compose.ui.platform.LocalContext.current
            msg.references.forEach { ref ->
                AssistChip(
                    onClick = {
                        if (ref.type == "link") {
                            runCatching {
                                ctx.startActivity(
                                    android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(ref.id))
                                )
                            }
                        } else {
                            onReferenceClick(ref)
                        }
                    },
                    label = {
                        Text(
                            if (ref.type == "link") ref.label.removePrefix("https://").removePrefix("http://").removePrefix("www.").take(40) else ref.label,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.labelMedium,
                        )
                    },
                )
            }
        }
    }
    }
}
