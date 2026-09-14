package app.familyagent.android.wear

import android.util.Log
import app.familyagent.android.data.ChatSessionMessage
import app.familyagent.android.data.FamilyAgentApi
import app.familyagent.android.data.SettingsStore
import com.google.android.gms.wearable.ChannelClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * The phone side of the phone<->watch relay (see WearProtocol.kt). A plain
 * `WearableListenerService` — not wired through `AppViewModel` at all — so a
 * message from the watch is handled even if the phone app was never opened
 * this boot: the system wakes this service on demand, it reads the signed-in
 * session straight out of [SettingsStore] and makes its own short-lived
 * [FamilyAgentApi] call, the same way the app's own UI would, just without an
 * Activity or ViewModel anywhere in the path.
 *
 * State that has to survive between separate dispatches of this
 * service (Android doesn't promise this instance stays alive between
 * calls) lives in [SettingsStore], not a field — see `wearSessionId`.
 */
class PhoneWearListenerService : WearableListenerService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }

    override fun onMessageReceived(event: MessageEvent) {
        scope.launch {
            if (!settings().watchRelayEnabled.first()) {
                // LIST_SESSIONS has no error field to carry this in (see
                // WearSessionsPayload) — leaving the sessions list alone is
                // fine there. Every other path pushes the disabled state
                // into CURRENT_SESSION so the watch's composer explains why
                // nothing is happening, instead of spinning forever.
                if (event.path != WearPaths.LIST_SESSIONS) pushWatchRelayDisabled()
                return@launch
            }
            when (event.path) {
                WearPaths.OPEN_SESSION -> {
                    val sessionId = String(event.data, Charsets.UTF_8)
                    settings().setWearSessionId(sessionId)
                    syncCurrentSession(sessionId)
                }
                WearPaths.NEW_SESSION -> {
                    settings().setWearSessionId(null)
                    pushCurrentSession(WearCurrentSessionPayload(sessionId = null, messages = emptyList()))
                }
                WearPaths.SEND_MESSAGE -> {
                    val text = runCatching { json.decodeFromString<WearSendMessage>(String(event.data, Charsets.UTF_8)).text }
                        .getOrNull() ?: return@launch
                    sendAndSync(text)
                }
                WearPaths.LIST_SESSIONS -> pushSessions()
            }
        }
    }

    override fun onChannelOpened(channel: ChannelClient.Channel) {
        if (channel.path != WearPaths.SEND_VOICE) return
        scope.launch {
            val client = Wearable.getChannelClient(this@PhoneWearListenerService)
            val wav = runCatching {
                client.getInputStream(channel).await().use { it.readBytes() }
            }.getOrNull()
            runCatching { client.close(channel).await() }
            if (wav == null || wav.isEmpty()) return@launch
            if (!settings().watchRelayEnabled.first()) {
                pushWatchRelayDisabled()
                return@launch
            }
            val api = apiOrNull() ?: return@launch
            val transcript = runCatching { api.transcribe(wav).text }.getOrNull()
            if (!transcript.isNullOrBlank()) sendAndSync(transcript)
        }
    }

    private suspend fun pushWatchRelayDisabled() {
        val sessionId = settings().wearSessionId.first()
        pushCurrentSession(
            WearCurrentSessionPayload(sessionId, _lastKnownMessages, error = "Watch access is turned off in phone Settings.")
        )
    }

    private suspend fun settings() = SettingsStore(applicationContext)

    private suspend fun apiOrNull(): FamilyAgentApi? {
        val session = settings().session.first() ?: return null
        return FamilyAgentApi(session.serverUrl, session.token)
    }

    private suspend fun syncCurrentSession(sessionId: String) {
        val api = apiOrNull() ?: run {
            pushCurrentSession(WearCurrentSessionPayload(sessionId, emptyList(), error = "Not signed in on the phone."))
            return
        }
        val messages = runCatching { api.getChatSessionMessages(sessionId) }.getOrNull()
        if (messages == null) {
            pushCurrentSession(WearCurrentSessionPayload(sessionId, emptyList(), error = "Couldn't reach the server."))
        } else {
            pushCurrentSession(WearCurrentSessionPayload(sessionId, messages.map { it.toWear() }))
        }
        pushSessions()
    }

    private suspend fun sendAndSync(text: String) {
        val store = settings()
        val sessionId = store.wearSessionId.first()
        val api = apiOrNull()
        if (api == null) {
            pushCurrentSession(WearCurrentSessionPayload(sessionId, emptyList(), error = "Not signed in on the phone."))
            return
        }
        // Optimistic: show the user's own line immediately, don't wait on
        // the round trip just to echo back what was just typed.
        val before = _lastKnownMessages
        pushCurrentSession(
            WearCurrentSessionPayload(
                sessionId = sessionId,
                messages = before + WearChatMessage(id = "pending", role = "user", body = text, createdAt = ""),
                sending = true,
            )
        )
        val result = runCatching { api.chat(message = text, sessionId = sessionId) }
        result.onSuccess { resp ->
            store.setWearSessionId(resp.sessionId)
            syncCurrentSession(resp.sessionId)
        }.onFailure { err ->
            Log.w("PhoneWearListener", "chat send failed", err)
            pushCurrentSession(
                WearCurrentSessionPayload(sessionId, before, sending = false, error = "Couldn't send — try again.")
            )
        }
    }

    // The optimistic "user just typed this" bubble above needs *something*
    // to append to before the real round trip lands; re-reading the last
    // pushed DataItem back from the Data Layer for this would be more
    // roundabout than just remembering it here for the life of this
    // instance — worst case (a fresh instance with nothing cached) it's an
    // empty list for one optimistic update, corrected a moment later by the
    // real sync anyway.
    private var _lastKnownMessages: List<WearChatMessage> = emptyList()

    private suspend fun pushCurrentSession(payload: WearCurrentSessionPayload) {
        _lastKnownMessages = payload.messages
        putDataItem(WearPaths.CURRENT_SESSION, json.encodeToString(payload))
    }

    private suspend fun pushSessions() {
        val api = apiOrNull() ?: return
        val sessions = runCatching { api.listChatSessions() }.getOrNull() ?: return
        val payload = WearSessionsPayload(
            sessions.map { WearChatSession(it.id, it.title, it.updatedAt, it.lastMessage) }
        )
        putDataItem(WearPaths.SESSIONS, json.encodeToString(payload))
    }

    private suspend fun putDataItem(path: String, jsonPayload: String) {
        val request = PutDataMapRequest.create(path).apply {
            dataMap.putString("json", jsonPayload)
            dataMap.putLong("ts", System.currentTimeMillis())
        }.asPutDataRequest().setUrgent()
        runCatching { Wearable.getDataClient(applicationContext).putDataItem(request).await() }
    }
}

private fun ChatSessionMessage.toWear() = WearChatMessage(id = id, role = role, body = body, createdAt = createdAt)
