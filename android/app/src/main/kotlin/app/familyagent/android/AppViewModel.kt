package app.familyagent.android

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.familyagent.android.data.ActivityEntry
import app.familyagent.android.data.Document
import app.familyagent.android.data.FamilyAgentApi
import app.familyagent.android.data.SettingsStore
import app.familyagent.android.data.Task
import app.familyagent.android.data.Tool
import kotlinx.coroutines.delay
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

data class ChatMessage(val role: String, val text: String, val images: List<String> = emptyList())

@Immutable
data class AppUiState(
    val serverUrl: String = "",
    val connection: ConnectionStatus = ConnectionStatus.Connecting,
    val chatMessages: List<ChatMessage> = emptyList(),
    val chatSending: Boolean = false,
    val tasks: List<Task> = emptyList(),
    val documents: List<Document> = emptyList(),
    val activity: List<ActivityEntry> = emptyList(),
    val documentUploadStatus: String? = null,
    val tools: List<Tool> = emptyList(),
    val toolStatus: String? = null,
    /** Base URL of the tools server, derived from serverUrl + /health's toolsPort. */
    val toolsBaseUrl: String? = null,
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
            runCatching { api.health() }
                .onSuccess { h ->
                    _state.value = _state.value.copy(
                        connection = ConnectionStatus.Connected(h.model),
                        toolsBaseUrl = toolsBaseUrl(_state.value.serverUrl, h.toolsPort),
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        connection = ConnectionStatus.Unreachable(it.message ?: "unreachable"),
                    )
                }
        }
    }

    private fun toolsBaseUrl(serverUrl: String, toolsPort: Int): String? = runCatching {
        val u = java.net.URI(serverUrl.trimEnd('/'))
        "${u.scheme}://${u.host}:$toolsPort"
    }.getOrNull()

    fun refreshTools() {
        viewModelScope.launch {
            runCatching { api.listTools() }.onSuccess { _state.value = _state.value.copy(tools = it) }
        }
    }

    fun buildTool(prompt: String) {
        if (prompt.isBlank()) return
        viewModelScope.launch {
            _state.value = _state.value.copy(toolStatus = "Building — this takes a minute or two.")
            runCatching { api.buildTool(prompt) }
                .onSuccess {
                    refreshActivity()
                    repeat(60) {
                        delay(4000)
                        val tools = runCatching { api.listTools() }.getOrNull() ?: return@repeat
                        _state.value = _state.value.copy(tools = tools)
                        if (tools.none { t -> t.status == "building" }) return@launch
                    }
                }
                .onFailure { _state.value = _state.value.copy(toolStatus = "Error: ${it.message}") }
        }
    }

    fun deleteTool(id: String) {
        viewModelScope.launch {
            runCatching { api.deleteTool(id) }.onSuccess { refreshTools() }
        }
    }

    fun sendChat(message: String, images: List<String> = emptyList()) {
        if (message.isBlank() && images.isEmpty()) return
        // The model needs a prompt; supply a default when it's an image only.
        val prompt = message.ifBlank { "What's in this image?" }
        viewModelScope.launch {
            val withUser = _state.value.chatMessages + ChatMessage("user", message, images)
            _state.value = _state.value.copy(chatMessages = withUser, chatSending = true)
            val reply = runCatching { api.chat(prompt, images) }
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
                refreshActivity()
                pollDocuments()
            }
        }
    }

    fun deleteDocument(id: String) {
        viewModelScope.launch {
            runCatching { api.deleteDocument(id) }
                .onSuccess {
                    refreshDocuments()
                    refreshActivity()
                }
                .onFailure { err ->
                    _state.value = _state.value.copy(documentUploadStatus = "Could not delete: ${err.message}")
                }
        }
    }

    fun retryExtraction(id: String) {
        viewModelScope.launch {
            runCatching { api.retryExtraction(id) }
                .onSuccess { pollDocuments() }
                .onFailure { err ->
                    _state.value = _state.value.copy(documentUploadStatus = "Retry failed: ${err.message}")
                }
        }
    }

    // Extraction lands a few seconds after ingest/retry; poll briefly so the
    // result (or a failure) shows without the user leaving the screen.
    private suspend fun pollDocuments() {
        refreshDocuments()
        repeat(6) {
            kotlinx.coroutines.delay(3000)
            refreshDocuments()
        }
    }

    /** Uploads a picked file or camera scan — the actual "scan a document" path. */
    fun uploadDocument(filename: String, bytes: ByteArray, mimeType: String?) {
        viewModelScope.launch {
            _state.value = _state.value.copy(documentUploadStatus = "Uploading \"$filename\"…")
            runCatching { api.uploadDocument(filename, bytes, mimeType) }
                .onSuccess {
                    _state.value = _state.value.copy(documentUploadStatus = "Uploaded \"${it.filename}\" — extracting…")
                    refreshActivity()
                    pollDocuments()
                    _state.value = _state.value.copy(documentUploadStatus = null)
                }
                .onFailure { err ->
                    _state.value = _state.value.copy(documentUploadStatus = "Error: ${err.message}")
                }
        }
    }

    fun refreshActivity() {
        viewModelScope.launch {
            runCatching { api.listActivity() }.onSuccess { _state.value = _state.value.copy(activity = it) }
        }
    }
}
