package app.familyagent.android.wear

import android.content.Context
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * The watch side of the phone<->watch relay (see WearProtocol.kt). Owns
 * nothing but the Data Layer clients: reads whatever the phone last synced
 * (live, via [DataClient.OnDataChangedListener], plus a catch-up read on
 * start in case something synced before this listener was attached) and
 * turns the watch's own taps into one-shot messages/channel writes to the
 * phone. No HTTP, no auth, no knowledge that agent-core exists at all — that
 * asymmetry (dumb watch, phone does the real work) is the whole point of
 * "relay through the paired phone" over a standalone watch client.
 */
class WearBridge(context: Context) {
    private val appContext = context.applicationContext
    private val dataClient = Wearable.getDataClient(appContext)
    private val messageClient = Wearable.getMessageClient(appContext)
    private val nodeClient = Wearable.getNodeClient(appContext)
    private val channelClient = Wearable.getChannelClient(appContext)
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _sessions = MutableStateFlow<List<WearChatSession>>(emptyList())
    val sessions: StateFlow<List<WearChatSession>> = _sessions

    private val _current = MutableStateFlow(WearCurrentSessionPayload(sessionId = null, messages = emptyList()))
    val current: StateFlow<WearCurrentSessionPayload> = _current

    /** True once at least one phone node is reachable — the empty-state
     *  screen reads this to tell "no phone paired/nearby" apart from "phone
     *  is there but has no chat history yet". */
    private val _phoneReachable = MutableStateFlow(false)
    val phoneReachable: StateFlow<Boolean> = _phoneReachable

    private fun applyItem(uriPath: String?, dataItem: com.google.android.gms.wearable.DataItem) {
        val map = DataMapItem.fromDataItem(dataItem).dataMap
        val payload = map.getString("json") ?: return
        when (uriPath) {
            WearPaths.SESSIONS -> runCatching { json.decodeFromString<WearSessionsPayload>(payload) }
                .onSuccess { _sessions.value = it.sessions }
            WearPaths.CURRENT_SESSION -> runCatching { json.decodeFromString<WearCurrentSessionPayload>(payload) }
                .onSuccess { _current.value = it }
        }
    }

    private val listener = DataClient.OnDataChangedListener { events ->
        for (event in events) {
            if (event.type == DataEvent.TYPE_CHANGED) applyItem(event.dataItem.uri.path, event.dataItem)
        }
    }

    fun start() {
        dataClient.addListener(listener)
        scope.launch {
            runCatching {
                val nodes = nodeClient.connectedNodes.await()
                _phoneReachable.value = nodes.isNotEmpty()
            }
            // Catch-up: pick up whatever the phone already synced before this
            // listener existed (the common case — the watch app usually opens
            // after the phone has been chatting for a while already).
            runCatching {
                val buffer = dataClient.dataItems.await()
                try {
                    for (i in 0 until buffer.count) {
                        val item = buffer[i]
                        applyItem(item.uri.path, item)
                    }
                } finally {
                    buffer.release()
                }
            }
        }
    }

    fun stop() {
        dataClient.removeListener(listener)
    }

    private suspend fun sendToPhone(path: String, data: ByteArray) {
        val nodes = nodeClient.connectedNodes.await()
        _phoneReachable.value = nodes.isNotEmpty()
        for (node in nodes) {
            runCatching { messageClient.sendMessage(node.id, path, data).await() }
        }
    }

    suspend fun openSession(id: String) = sendToPhone(WearPaths.OPEN_SESSION, id.toByteArray(Charsets.UTF_8))

    suspend fun newSession() = sendToPhone(WearPaths.NEW_SESSION, ByteArray(0))

    suspend fun sendText(text: String) =
        sendToPhone(WearPaths.SEND_MESSAGE, json.encodeToString(WearSendMessage(text)).toByteArray(Charsets.UTF_8))

    /** [wav] is a full 16kHz mono WAV file's bytes — small enough (a few
     *  seconds of dictation) that a Channel, not chunking through
     *  MessageClient's much smaller size ceiling, is the right transport. */
    suspend fun sendVoice(wav: ByteArray) {
        val nodes = nodeClient.connectedNodes.await()
        _phoneReachable.value = nodes.isNotEmpty()
        for (node in nodes) {
            runCatching {
                val channel = channelClient.openChannel(node.id, WearPaths.SEND_VOICE).await()
                channelClient.getOutputStream(channel).await().use { it.write(wav) }
                channelClient.close(channel).await()
            }
        }
    }
}
