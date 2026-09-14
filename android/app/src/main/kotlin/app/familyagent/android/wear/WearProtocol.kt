package app.familyagent.android.wear

import kotlinx.serialization.Serializable

/**
 * The phone<->watch wire contract, over the Wearable Data Layer
 * (MessageClient for one-shot asks, DataClient for the phone's synced
 * "here's the current state" pushes, ChannelClient for the one payload too
 * big for a plain message — a voice clip). Kept in sync by hand with
 * `wear/src/.../wear/WearProtocol.kt` on the watch side, same convention as
 * every other cross-target duplication in this app (see CLAUDE.md).
 *
 * Everything here is deliberately small and JSON, not a new native
 * serialization scheme — `kotlinx.serialization` is already a dependency on
 * both sides.
 */
object WearPaths {
    /** DataItem, phone -> watch: [WearSessionsPayload]. */
    const val SESSIONS = "/wear/sessions"
    /** DataItem, phone -> watch: [WearCurrentSessionPayload]. */
    const val CURRENT_SESSION = "/wear/current_session"
    /** Message, watch -> phone: UTF-8 session id. Phone starts syncing that
     *  session's messages as [CURRENT_SESSION]. */
    const val OPEN_SESSION = "/wear/open_session"
    /** Message, watch -> phone: empty payload. Phone forgets the "current"
     *  session id, so the next [SEND_MESSAGE] starts a fresh one. */
    const val NEW_SESSION = "/wear/new_session"
    /** Message, watch -> phone: [WearSendMessage] JSON. */
    const val SEND_MESSAGE = "/wear/send_message"
    /** Channel, watch -> phone: raw 16kHz mono WAV bytes, same format the
     *  phone's own mic composer already records and uploads. */
    const val SEND_VOICE = "/wear/send_voice"
}

@Serializable
data class WearChatSession(
    val id: String,
    val title: String,
    val updatedAt: String,
    val lastMessage: String? = null,
)

@Serializable
data class WearSessionsPayload(val sessions: List<WearChatSession>)

@Serializable
data class WearChatMessage(
    val id: String,
    val role: String,
    val body: String,
    val createdAt: String,
)

@Serializable
data class WearCurrentSessionPayload(
    val sessionId: String?,
    val messages: List<WearChatMessage>,
    /** True from the moment the watch's send lands on the phone until the
     *  reply (or an error placeholder) comes back — drives a spinner instead
     *  of the watch guessing from message-list changes alone. */
    val sending: Boolean = false,
    /** Set instead of a real reply when the phone couldn't reach agent-core
     *  at all (no session, network error) — shown as a plain line in the
     *  transcript rather than silently doing nothing. */
    val error: String? = null,
)

@Serializable
data class WearSendMessage(val text: String)
