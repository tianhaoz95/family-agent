package app.familyagent.android.wear

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.CompactButton
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import kotlinx.coroutines.launch

private const val ROUTE_SESSIONS = "sessions"
private const val ROUTE_CHAT = "chat"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                WearApp()
            }
        }
    }
}

@Composable
fun WearApp() {
    val context = LocalContext.current
    val bridge = remember { WearBridge(context) }
    DisposableEffect(Unit) {
        bridge.start()
        onDispose { bridge.stop() }
    }
    val navController = rememberSwipeDismissableNavController()

    SwipeDismissableNavHost(navController = navController, startDestination = ROUTE_SESSIONS) {
        composable(ROUTE_SESSIONS) {
            SessionsScreen(
                bridge = bridge,
                onOpenSession = { id ->
                    navController.navigate(ROUTE_CHAT)
                },
            )
        }
        composable(ROUTE_CHAT) {
            ChatScreen(bridge = bridge)
        }
    }
}

@Composable
private fun SessionsScreen(bridge: WearBridge, onOpenSession: (String) -> Unit) {
    val sessions by bridge.sessions.collectAsState()
    val phoneReachable by bridge.phoneReachable.collectAsState()
    val scope = rememberCoroutineScope()
    val listState = rememberScalingLazyListState()

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(modifier = Modifier.fillMaxSize(), state = listState) {
            item { ListHeader { Text("Family Agent") } }
            if (!phoneReachable) {
                item {
                    Text(
                        "Phone not reachable. Open the app on your phone and make sure it's paired.",
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 12.dp),
                        style = MaterialTheme.typography.caption2,
                    )
                }
            }
            item {
                Chip(
                    onClick = {
                        scope.launch { bridge.newSession() }
                        onOpenSession("new")
                    },
                    label = { Text("New chat") },
                    icon = { Icon(Icons.Rounded.Add, contentDescription = null) },
                    colors = ChipDefaults.primaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            items(sessions) { session ->
                Chip(
                    onClick = {
                        scope.launch { bridge.openSession(session.id) }
                        onOpenSession(session.id)
                    },
                    label = { Text(session.title.ifBlank { "Untitled chat" }, maxLines = 1) },
                    secondaryLabel = session.lastMessage?.let { { Text(it, maxLines = 1) } },
                    colors = ChipDefaults.secondaryChipColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (sessions.isEmpty() && phoneReachable) {
                item {
                    Text(
                        "No chats yet — start one above.",
                        textAlign = TextAlign.Center,
                        style = MaterialTheme.typography.caption2,
                    )
                }
            }
        }
    }
}

@Composable
private fun ChatScreen(bridge: WearBridge) {
    val current by bridge.current.collectAsState()
    val listState = rememberScalingLazyListState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var draft by remember { mutableStateOf("") }
    val recorder = remember { VoiceRecorder() }
    var recording by remember { mutableStateOf(false) }

    val recordPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            runCatching { recorder.start() }.onSuccess { recording = true }
        }
    }
    fun hasRecordPermission() =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    val openTextInput = rememberTextInputLauncher("Message") { text -> draft = text }

    fun send() {
        val text = draft.trim()
        if (text.isBlank()) return
        draft = ""
        scope.launch { bridge.sendText(text) }
    }
    fun toggleMic() {
        if (recording) {
            recording = false
            scope.launch {
                val wav = recorder.stop()
                if (wav.isNotEmpty()) bridge.sendVoice(wav)
            }
        } else if (hasRecordPermission()) {
            runCatching { recorder.start() }.onSuccess { recording = true }
        } else {
            recordPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    // Always land on the newest message when the transcript changes —
    // matches every other chat surface in this app.
    DisposableEffect(current.messages.size) {
        if (current.messages.isNotEmpty()) {
            scope.launch { listState.scrollToItem(current.messages.size + 1) }
        }
        onDispose {}
    }

    Scaffold(
        timeText = { TimeText() },
        vignette = { Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        // The composer is the list's own last item, not a pinned overlay —
        // ScalingLazyColumn is the whole screen's interaction surface on
        // Wear, and a floating row fights it for drag gestures. Scrolling
        // to reveal "type a message" is the normal Wear chat pattern (the
        // system Messages app works the same way).
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
        ) {
            item { Spacer(Modifier.height(1.dp)) }
            items(current.messages) { msg ->
                MessageBubble(msg)
            }
            current.error?.let { err ->
                item {
                    Text(
                        err,
                        color = MaterialTheme.colors.error,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(8.dp),
                        style = MaterialTheme.typography.caption2,
                    )
                }
            }
            if (current.sending) {
                item { CircularProgressIndicator(modifier = Modifier.padding(8.dp)) }
            }
            item {
                // A tap-target "field" (opens the system input sheet — see
                // WearInput.kt), a dedicated mic button (this watch's own
                // microphone, not the system sheet's voice option), and send.
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Chip(
                        onClick = openTextInput,
                        label = { Text(draft.ifBlank { "Message…" }, maxLines = 1) },
                        colors = ChipDefaults.secondaryChipColors(),
                        modifier = Modifier.weight(1f).height(36.dp),
                    )
                    CompactButton(onClick = { toggleMic() }, modifier = Modifier.size(36.dp)) {
                        Icon(
                            if (recording) Icons.Rounded.Stop else Icons.Rounded.Mic,
                            contentDescription = if (recording) "Stop recording" else "Record voice",
                            tint = if (recording) MaterialTheme.colors.error else MaterialTheme.colors.onSurface,
                        )
                    }
                    CompactButton(onClick = { send() }, modifier = Modifier.size(36.dp)) {
                        Icon(Icons.AutoMirrored.Rounded.Send, contentDescription = "Send")
                    }
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(msg: WearChatMessage) {
    val isUser = msg.role == "user"
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Text(
            msg.body,
            modifier = Modifier
                .clip(RoundedCornerShape(10.dp))
                .background(if (isUser) MaterialTheme.colors.primary else Color.DarkGray)
                .padding(horizontal = 8.dp, vertical = 4.dp),
            style = MaterialTheme.typography.body2,
        )
    }
}
