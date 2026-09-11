package app.familyagent.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

private const val CHANNEL_ID = "reply_ready"
private const val EXTRA_NAV_KIND = "app.familyagent.android.NAV_KIND"
private const val EXTRA_NAV_ID = "app.familyagent.android.NAV_ID"
private const val NAV_KIND_CHAT = "chat"
private const val NAV_KIND_CHANNEL = "channel"

/** Where a tapped "reply is ready" notification wants the app to go. */
sealed interface PendingNotificationNav {
    data class Chat(val sessionId: String) : PendingNotificationNav
    data class Channel(val channelId: String) : PendingNotificationNav
}

/**
 * Where the user currently is, read (not observed as a StateFlow) by the
 * view model at the moment it decides whether a "reply is ready"
 * notification would just be telling you something you're already looking
 * at. [isForeground] is set from MainActivity's onResume/onPause;
 * [isChatScreenActive] / [activeConversationChannelId] from a LaunchedEffect
 * on the NavHost's current destination in MainActivity.kt.
 *
 * [pendingNav] is Compose state (not plain fields) — MainActivity sets it
 * from a tapped notification's intent extras, and a LaunchedEffect inside
 * FamilyAgentApp (which has the NavController this needs) reactively picks
 * it up and navigates, from wherever in the object tree it happens to be
 * read.
 */
object AppForegroundTracker {
    @Volatile var isForeground: Boolean = false
    @Volatile var isChatScreenActive: Boolean = false
    @Volatile var activeConversationChannelId: String? = null
    var pendingNav: PendingNotificationNav? by mutableStateOf<PendingNotificationNav?>(null)
}

/** Posts (and helps navigate from) the "assistant reply is ready" system
 *  notification — Chat, or a family channel's @agent reply. */
object ReplyNotifications {
    private var nextId = 20_000

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        mgr.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Reply ready", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "The assistant finished replying to something."
            }
        )
    }

    /** Covers both "never granted the runtime permission" (API 33+) and "the
     *  user turned notifications off for this app in system settings" (every
     *  version) in one check. */
    fun hasPermission(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

    private fun navIntent(context: Context, kind: String, id: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_NAV_KIND, kind)
            putExtra(EXTRA_NAV_ID, id)
        }
        return PendingIntent.getActivity(
            context,
            "$kind:$id".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun post(context: Context, title: String, body: String, pending: PendingIntent) {
        if (!hasPermission(context)) return
        ensureChannel(context)
        val text = body.trim().ifBlank { "New reply ready." }.take(200)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(nextId++, notification) }
    }

    fun postChatReply(context: Context, sessionId: String, body: String) {
        post(context, "Family Agent", body, navIntent(context, NAV_KIND_CHAT, sessionId))
    }

    fun postChannelReply(context: Context, channelId: String, channelTitle: String, body: String) {
        post(context, channelTitle.ifBlank { "Family chat" }, body, navIntent(context, NAV_KIND_CHANNEL, channelId))
    }

    /** Parses a launch/new intent as a tapped notification, if that's what it was. */
    fun pendingNavFrom(intent: Intent?): PendingNotificationNav? {
        val id = intent?.getStringExtra(EXTRA_NAV_ID) ?: return null
        return when (intent.getStringExtra(EXTRA_NAV_KIND)) {
            NAV_KIND_CHAT -> PendingNotificationNav.Chat(id)
            NAV_KIND_CHANNEL -> PendingNotificationNav.Channel(id)
            else -> null
        }
    }
}
