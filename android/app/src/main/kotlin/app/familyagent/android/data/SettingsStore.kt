package app.familyagent.android.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "family_agent_settings")
private val SERVER_URL_KEY = stringPreferencesKey("server_url")

// No default that guesses a LAN IP — the user has to point this at their own
// desktop, which also doubles as a plain-language reminder of the trust
// boundary (this app only ever talks to a server you told it about).
const val DEFAULT_SERVER_URL = "http://192.168.1.2:4173"

class SettingsStore(private val context: Context) {
    val serverUrl = context.dataStore.data.map { it[SERVER_URL_KEY] ?: DEFAULT_SERVER_URL }

    suspend fun setServerUrl(url: String) {
        context.dataStore.edit { it[SERVER_URL_KEY] = url }
    }
}
