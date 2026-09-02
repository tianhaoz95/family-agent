package app.familyagent.android.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import app.familyagent.android.ChatMessage
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private const val MAX_IMAGES = 4

@Composable
fun ChatScreen(
    messages: List<ChatMessage>,
    sending: Boolean,
    voiceEnabled: Boolean,
    transcribing: Boolean,
    onSend: (String, List<String>) -> Unit,
    onTranscribe: (ByteArray, (String) -> Unit) -> Unit,
) {
    val context = LocalContext.current
    var input by remember { mutableStateOf("") }
    var attached by remember { mutableStateOf<List<String>>(emptyList()) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }
    var attachMenuOpen by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    // ---- voice input ----
    val recorder = remember { VoiceRecorder() }
    var isRecording by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { onDispose { recorder.cancel() } }

    fun beginRecording() {
        runCatching { recorder.start() }.onSuccess { isRecording = true }
    }
    fun finishRecording() {
        if (!isRecording) return
        isRecording = false
        scope.launch {
            val wav = recorder.stop()
            if (wav.isNotEmpty()) {
                onTranscribe(wav) { text ->
                    input = if (input.isBlank()) text else "${input.trimEnd()} $text"
                }
            }
        }
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) beginRecording()
    }
    fun onMicClick() {
        if (isRecording) {
            finishRecording()
            return
        }
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) beginRecording() else micPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

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
                items(messages) { msg -> ChatBubble(msg) }
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

        Spacer(Modifier.height(10.dp))
        val submit = {
            if ((input.isNotBlank() || attached.isNotEmpty()) && !sending) {
                onSend(input.trim(), attached)
                input = ""
                attached = emptyList()
            }
        }
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(22.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant)
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
                when {
                    transcribing -> Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    }
                    else -> IconButton(onClick = { onMicClick() }, enabled = !sending) {
                        Icon(
                            if (isRecording) Icons.Rounded.Stop else Icons.Rounded.Mic,
                            contentDescription = if (isRecording) "Stop recording" else "Voice input",
                            modifier = Modifier.size(22.dp),
                            tint = if (isRecording) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
            TextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text(if (isRecording) "Listening…" else "Message, or attach a photo…") },
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
                enabled = !sending && (input.isNotBlank() || attached.isNotEmpty()),
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

@Composable
private fun ChatBubble(msg: ChatMessage) {
    val isUser = msg.role == "user"
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
                    Text(msg.text, color = textColor, style = MaterialTheme.typography.bodyLarge)
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
}
