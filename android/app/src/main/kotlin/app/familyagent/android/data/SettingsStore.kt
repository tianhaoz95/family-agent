package app.familyagent.android.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "family_agent_settings")
private val SERVER_URL_KEY = stringPreferencesKey("server_url")
private val AUTH_TOKEN_KEY = stringPreferencesKey("auth_token")
private val USER_NAME_KEY = stringPreferencesKey("user_display_name")
private val SERVER_NAME_KEY = stringPreferencesKey("server_name")

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
