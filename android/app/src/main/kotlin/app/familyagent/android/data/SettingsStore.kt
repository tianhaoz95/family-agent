package app.familyagent.android.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "family_agent_settings")
private val SERVER_URL_KEY = stringPreferencesKey("server_url")
private val AUTH_TOKEN_KEY = stringPreferencesKey("auth_token")
private val USER_NAME_KEY = stringPreferencesKey("user_display_name")
private val SERVER_NAME_KEY = stringPreferencesKey("server_name")
private val TASK_VIEW_KEY = stringPreferencesKey("task_view")
private val AUTO_READ_KEY = booleanPreferencesKey("auto_read_replies")
private val TASK_VIEWS = listOf("list", "day", "3day", "week", "month")

// Prefill for the manual-address field only. The normal path is LAN discovery
// (ServerDiscovery) — this app talks only to a server the user picked or typed.
const val DEFAULT_SERVER_URL = "http://192.168.1.2:4173"

/** What we remember about the signed-in session between launches. */
data class Session(
    val serverUrl: String,
    val token: String,
    val displayName: String,
    val serverName: String,
)

class SettingsStore(private val context: Context) {
    val serverUrl = context.dataStore.data.map { it[SERVER_URL_KEY] ?: DEFAULT_SERVER_URL }

    val session = context.dataStore.data.map { prefs ->
        val url = prefs[SERVER_URL_KEY]
        val token = prefs[AUTH_TOKEN_KEY]
        if (url != null && token != null) {
            Session(url, token, prefs[USER_NAME_KEY].orEmpty(), prefs[SERVER_NAME_KEY].orEmpty())
        } else null
    }

    suspend fun setServerUrl(url: String) {
        context.dataStore.edit { it[SERVER_URL_KEY] = url.trimEnd('/') }
    }

    /** Which Tasks view to show: list | day | 3day | week | month. Survives sign-out. */
    val taskView = context.dataStore.data.map {
        when (val v = it[TASK_VIEW_KEY]) {
            null -> "week"          // new default
            "calendar" -> "month"  // legacy value from the first version
            in TASK_VIEWS -> v!!
            else -> "week"
        }
    }

    suspend fun setTaskView(view: String) {
        context.dataStore.edit { it[TASK_VIEW_KEY] = view }
    }

    /** Read new assistant replies aloud automatically. Survives sign-out. */
    val autoRead = context.dataStore.data.map { it[AUTO_READ_KEY] ?: false }

    suspend fun setAutoRead(on: Boolean) {
        context.dataStore.edit { it[AUTO_READ_KEY] = on }
    }

    suspend fun saveSession(serverUrl: String, token: String, displayName: String, serverName: String) {
        context.dataStore.edit {
            it[SERVER_URL_KEY] = serverUrl.trimEnd('/')
            it[AUTH_TOKEN_KEY] = token
            it[USER_NAME_KEY] = displayName
            it[SERVER_NAME_KEY] = serverName
        }
    }

    suspend fun clearSession() {
        context.dataStore.edit {
            it.remove(AUTH_TOKEN_KEY)
            it.remove(USER_NAME_KEY)
        }
    }
}
