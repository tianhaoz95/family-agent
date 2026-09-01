package app.familyagent.android

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.familyagent.android.data.ActivityEntry
import app.familyagent.android.data.Document
import app.familyagent.android.data.FamilyAgentApi
import app.familyagent.android.data.SettingsStore
import app.familyagent.android.data.Task
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

sealed interface ConnectionStatus {
    data object Connecting : ConnectionStatus
    data class Connected(val model: String) : ConnectionStatus
    data class Unreachable(val message: String) : ConnectionStatus
}

data class ChatMessage(val role: String, val text: String)

@Immutable
data class AppUiState(
    val serverUrl: String = "",
    val connection: ConnectionStatus = ConnectionStatus.Connecting,
    val chatMessages: List<ChatMessage> = emptyList(),
    val chatSending: Boolean = false,
    val tasks: List<Task> = emptyList(),
    val documents: List<Document> = emptyList(),
    val activity: List<ActivityEntry> = emptyList(),
)

class AppViewModel(
    private val api: FamilyAgentApi,
    private val settings: SettingsStore,
) : ViewModel() {
    private val _state = MutableStateFlow(AppUiState())
    val state: StateFlow<AppUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val url = settings.serverUrl.first()
            api.updateBaseUrl(url)
            _state.value = _state.value.copy(serverUrl = url)
            refreshStatus()
        }
    }

    fun setServerUrl(url: String) {
        viewModelScope.launch {
            settings.setServerUrl(url)
            api.updateBaseUrl(url)
            _state.value = _state.value.copy(serverUrl = url, connection = ConnectionStatus.Connecting)
            refreshStatus()
        }
    }

    fun refreshStatus() {
        viewModelScope.launch {
            _state.value = _state.value.copy(
                connection = runCatching { api.health() }
                    .fold(
                        onSuccess = { ConnectionStatus.Connected(it.model) },
                        onFailure = { ConnectionStatus.Unreachable(it.message ?: "unreachable") },
                    )
            )
        }
    }

    fun sendChat(message: String) {
        if (message.isBlank()) return
        viewModelScope.launch {
            val withUser = _state.value.chatMessages + ChatMessage("user", message)
            _state.value = _state.value.copy(chatMessages = withUser, chatSending = true)
            val reply = runCatching { api.chat(message) }
                .fold(
                    onSuccess = { it.reply },
                    onFailure = { "Error: ${it.message}" },
                )
            _state.value = _state.value.copy(
                chatMessages = withUser + ChatMessage("assistant", reply),
                chatSending = false,
            )
            refreshActivity()
        }
    }

    fun refreshTasks() {
        viewModelScope.launch {
            runCatching { api.listTasks() }.onSuccess { _state.value = _state.value.copy(tasks = it) }
        }
    }

    fun addTask(title: String, dueDate: String?) {
        viewModelScope.launch {
            runCatching { api.createTask(title, dueDate) }.onSuccess {
                refreshTasks()
                refreshActivity()
            }
        }
    }

    fun completeTask(id: String) {
        viewModelScope.launch {
            runCatching { api.completeTask(id) }.onSuccess {
                refreshTasks()
                refreshActivity()
            }
        }
    }

    fun refreshDocuments() {
        viewModelScope.launch {
            runCatching { api.listDocuments() }.onSuccess { _state.value = _state.value.copy(documents = it) }
        }
    }

    fun ingestDocument(filename: String, text: String) {
        viewModelScope.launch {
            runCatching { api.ingestDocument(filename, text) }.onSuccess {
                refreshDocuments()
                refreshActivity()
                // Extraction lands a few seconds after ingest; poll briefly.
                repeat(6) {
                    kotlinx.coroutines.delay(3000)
                    refreshDocuments()
                }
            }
        }
    }

    fun refreshActivity() {
        viewModelScope.launch {
            runCatching { api.listActivity() }.onSuccess { _state.value = _state.value.copy(activity = it) }
        }
    }
}
