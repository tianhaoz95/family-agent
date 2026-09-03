package app.familyagent.android

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.familyagent.android.data.ActivityEntry
import app.familyagent.android.data.Channel
import app.familyagent.android.data.Document
import app.familyagent.android.data.FamilyAgentApi
import app.familyagent.android.data.FamilyMember
import app.familyagent.android.data.Message
import app.familyagent.android.data.SettingsStore
import app.familyagent.android.data.StickyNote
import app.familyagent.android.data.Task
import app.familyagent.android.data.Tool
import app.familyagent.android.data.UnauthorizedException
import app.familyagent.android.data.User
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.time.LocalDate

sealed interface ConnectionStatus {
    data object Connecting : ConnectionStatus
    data class Connected(val model: String) : ConnectionStatus
    data class Unreachable(val message: String) : ConnectionStatus
}

/** Where the app is in the sign-in flow — gates the whole UI. */
sealed interface AuthState {
    /** Deciding: checking a stored session, or nothing stored yet. */
    data object Unknown : AuthState
    /** Pick a home server on the LAN (or enter one by hand). */
    data object PickServer : AuthState
    /** A server is chosen; sign in. */
    data class NeedLogin(val serverUrl: String, val serverName: String, val error: String? = null) : AuthState
    /** Signed in. */
    data class Authenticated(val user: User) : AuthState
}

data class ChatMessage(
    val role: String,
    val text: String,
    val images: List<String> = emptyList(),
    val references: List<app.familyagent.android.data.ChatReference> = emptyList(),
)

/** What the detail bottom-sheet is currently showing (a referenced item or a doc preview). */
sealed interface DetailContent {
    data object Loading : DetailContent
    data class DocumentDetail(val doc: Document, val pdfBytes: ByteArray? = null) : DetailContent
    data class TaskDetail(val task: Task) : DetailContent
    data class Failed(val message: String) : DetailContent
}

@Immutable
data class AppUiState(
    val auth: AuthState = AuthState.Unknown,
    val serverUrl: String = "",
    val connection: ConnectionStatus = ConnectionStatus.Connecting,
    val chatMessages: List<ChatMessage> = emptyList(),
    val chatSending: Boolean = false,
    /** Server offers speech-to-text (from /health) — gates the chat mic button. */
    val voiceEnabled: Boolean = false,
    /** A recorded voice clip is being transcribed right now. */
    val chatTranscribing: Boolean = false,
    val tasks: List<Task> = emptyList(),
    val documents: List<Document> = emptyList(),
    val activity: List<ActivityEntry> = emptyList(),
    val documentUploadStatus: String? = null,
    val tools: List<Tool> = emptyList(),
    val toolStatus: String? = null,
    /** Base URL of the tools server, derived from serverUrl + /health's toolsPort. */
    val toolsBaseUrl: String? = null,
    /** Tasks screen: list | day | 3day | week | month (persisted in DataStore). */
    val taskView: String = "week",
    /** Anchor day for the calendar range (day/3day/week start from it; month uses its month). */
    val calAnchor: LocalDate = LocalDate.now(),
    // ---- family chat + board ----
    val familyMembers: List<FamilyMember> = emptyList(),
    val channels: List<Channel> = emptyList(),
    val activeChannel: Channel? = null,
    val channelMessages: List<Message> = emptyList(),
    val channelSending: Boolean = false,
    val notes: List<StickyNote> = emptyList(),
    val noteScope: String = "shared",
    /** Non-null while the detail bottom-sheet is open. */
    val detail: DetailContent? = null,
) {
    /** Total unread across every conversation — drives the nav badge. */
    val totalUnread: Int get() = channels.sumOf { it.unreadCount }
}

class AppViewModel(
    private val api: FamilyAgentApi,
    private val settings: SettingsStore,
) : ViewModel() {
    private val _state = MutableStateFlow(AppUiState())
    val state: StateFlow<AppUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            settings.taskView.collect { view ->
                _state.value = _state.value.copy(taskView = view)
            }
        }
        viewModelScope.launch {
            val stored = settings.session.first()
            if (stored == null) {
                _state.value = _state.value.copy(auth = AuthState.PickServer)
                return@launch
            }
            api.updateBaseUrl(stored.serverUrl)
            api.authToken = stored.token
            _state.value = _state.value.copy(serverUrl = stored.serverUrl)
            val user = runCatching { api.me() }.getOrNull()
            if (user != null) {
                _state.value = _state.value.copy(auth = AuthState.Authenticated(user))
                refreshStatus()
                refreshChannels()
            } else {
                // token gone stale, or server unreachable — go back to login.
                api.authToken = null
                val name = runCatching { api.authStatus().serverName }.getOrDefault(stored.serverName)
                _state.value = _state.value.copy(auth = AuthState.NeedLogin(stored.serverUrl, name))
            }
        }
    }

    /** Any guarded API call: a 401 kicks the whole app back to the login screen. */
    private suspend fun <T> apiCall(block: suspend () -> T): Result<T> {
        val r = runCatching { block() }
        (r.exceptionOrNull() as? UnauthorizedException)?.let {
            api.authToken = null
            settings.clearSession()
            val auth = _state.value.auth
            val url = _state.value.serverUrl
            _state.value = _state.value.copy(
                auth = AuthState.NeedLogin(url, (auth as? AuthState.NeedLogin)?.serverName ?: "", "Session expired — sign in again."),
            )
        }
        return r
    }

    fun pickServer(url: String) {
        viewModelScope.launch {
            val clean = url.trim().trimEnd('/')
            api.updateBaseUrl(clean)
            _state.value = _state.value.copy(serverUrl = clean, auth = AuthState.NeedLogin(clean, "loading…"))
            val name = runCatching { api.authStatus().serverName }.getOrDefault("Family Agent")
            _state.value = _state.value.copy(auth = AuthState.NeedLogin(clean, name))
        }
    }

    fun backToServerPick() {
        _state.value = _state.value.copy(auth = AuthState.PickServer)
    }

    fun login(username: String, password: String) {
        val current = _state.value.auth as? AuthState.NeedLogin ?: return
        viewModelScope.launch {
            _state.value = _state.value.copy(auth = current.copy(error = null))
            api.updateBaseUrl(current.serverUrl)
            val result = runCatching { api.login(username.trim(), password) }
            result.onSuccess { resp ->
                api.authToken = resp.token
                settings.saveSession(current.serverUrl, resp.token, resp.user.displayName, current.serverName)
                _state.value = _state.value.copy(
                    serverUrl = current.serverUrl,
                    auth = AuthState.Authenticated(resp.user),
                    connection = ConnectionStatus.Connecting,
                    chatMessages = emptyList(),
                    tasks = emptyList(),
                    documents = emptyList(),
                    activity = emptyList(),
                    tools = emptyList(),
                    channels = emptyList(),
                    familyMembers = emptyList(),
                )
                refreshStatus()
                refreshChannels()
            }.onFailure {
                _state.value = _state.value.copy(auth = current.copy(error = it.message ?: "Sign-in failed."))
            }
        }
    }

    fun signOut() {
        channelListJob?.cancel()
        conversationJob?.cancel()
        viewModelScope.launch {
            api.logout()
            api.authToken = null
            settings.clearSession()
            _state.value = AppUiState(auth = AuthState.PickServer)
        }
    }

    fun setServerUrl(url: String) {
        // "Advanced" manual override from Settings while signed in.
        viewModelScope.launch {
            settings.setServerUrl(url)
            api.updateBaseUrl(url)
            _state.value = _state.value.copy(serverUrl = url, connection = ConnectionStatus.Connecting)
            refreshStatus()
        }
    }

    fun refreshStatus() {
        viewModelScope.launch {
            apiCall { api.health() }
                .onSuccess { h ->
                    _state.value = _state.value.copy(
                        connection = ConnectionStatus.Connected(h.model),
                        toolsBaseUrl = toolsBaseUrl(_state.value.serverUrl, h.toolsPort),
                        voiceEnabled = h.asrEnabled,
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
            apiCall { api.listTools() }.onSuccess { _state.value = _state.value.copy(tools = it) }
        }
    }

    fun buildTool(prompt: String) {
        if (prompt.isBlank()) return
        viewModelScope.launch {
            _state.value = _state.value.copy(toolStatus = "Building — this takes a minute or two.")
            apiCall { api.buildTool(prompt) }
                .onSuccess {
                    refreshActivity()
                    repeat(60) {
                        delay(4000)
                        val tools = apiCall { api.listTools() }.getOrNull() ?: return@repeat
                        _state.value = _state.value.copy(tools = tools)
                        if (tools.none { t -> t.status == "building" }) return@launch
                    }
                }
                .onFailure { _state.value = _state.value.copy(toolStatus = "Error: ${it.message}") }
        }
    }

    fun deleteTool(id: String) {
        viewModelScope.launch {
            apiCall { api.deleteTool(id) }.onSuccess { refreshTools() }
        }
    }

    fun sendChat(message: String, images: List<String> = emptyList()) {
        if (message.isBlank() && images.isEmpty()) return
        // The model needs a prompt; supply a default when it's an image only.
        val prompt = message.ifBlank { "What's in this image?" }
        viewModelScope.launch {
            val withUser = _state.value.chatMessages + ChatMessage("user", message, images)
            _state.value = _state.value.copy(chatMessages = withUser, chatSending = true)
            val assistant = apiCall { api.chat(prompt, images) }
                .fold(
                    onSuccess = { ChatMessage("assistant", it.reply, references = it.references) },
                    onFailure = { ChatMessage("assistant", "Error: ${it.message}") },
                )
            _state.value = _state.value.copy(
                chatMessages = withUser + assistant,
                chatSending = false,
            )
            refreshActivity()
        }
    }

    /**
     * Transcribe a recorded voice clip and hand the text back to the composer
     * (via [onText]) for the user to review — never auto-sent. A failed or
     * empty transcription drops an assistant note into the thread.
     */
    fun transcribeVoice(wav: ByteArray, onText: (String) -> Unit) {
        if (wav.isEmpty()) return
        viewModelScope.launch {
            _state.value = _state.value.copy(chatTranscribing = true)
            val result = apiCall { api.transcribe(wav) }
            _state.value = _state.value.copy(chatTranscribing = false)
            result.fold(
                onSuccess = { r ->
                    if (r.text.isBlank()) {
                        _state.value = _state.value.copy(
                            chatMessages = _state.value.chatMessages +
                                ChatMessage("assistant", "Didn't catch any speech — try again, closer to the mic."),
                        )
                    } else {
                        onText(r.text)
                    }
                },
                onFailure = {
                    _state.value = _state.value.copy(
                        chatMessages = _state.value.chatMessages +
                            ChatMessage("assistant", "Voice input failed: ${it.message}"),
                    )
                },
            )
            refreshActivity()
        }
    }

    fun refreshTasks() {
        viewModelScope.launch {
            apiCall { api.listTasks() }.onSuccess { _state.value = _state.value.copy(tasks = it) }
        }
    }

    fun addTask(title: String, dueDate: String?, dueTime: String? = null) {
        viewModelScope.launch {
            apiCall { api.createTask(title, dueDate, dueTime) }.onSuccess {
                refreshTasks()
                refreshActivity()
            }
        }
    }

    fun completeTask(id: String) {
        viewModelScope.launch {
            apiCall { api.completeTask(id) }.onSuccess {
                refreshTasks()
                refreshActivity()
            }
        }
    }

    fun rescheduleTask(id: String, dueDate: String?, dueTime: String?) {
        viewModelScope.launch {
            apiCall { api.rescheduleTask(id, dueDate, dueTime) }.onSuccess {
                refreshTasks()
                refreshActivity()
            }
        }
    }

    fun setTaskView(view: String) {
        viewModelScope.launch { settings.setTaskView(view) }
    }

    /** Step the calendar by one visible range (month for "month", else the day count). */
    fun shiftCalRange(forward: Boolean) {
        val dir = if (forward) 1L else -1L
        val a = _state.value.calAnchor
        val next = when (_state.value.taskView) {
            "month" -> a.plusMonths(dir)
            "day" -> a.plusDays(dir)
            "3day" -> a.plusDays(dir * 3)
            else -> a.plusWeeks(dir)
        }
        _state.value = _state.value.copy(calAnchor = next)
    }

    fun resetCalRange() {
        _state.value = _state.value.copy(calAnchor = LocalDate.now())
    }

    fun refreshDocuments() {
        viewModelScope.launch {
            apiCall { api.listDocuments() }.onSuccess { _state.value = _state.value.copy(documents = it) }
        }
    }

    fun ingestDocument(filename: String, text: String) {
        viewModelScope.launch {
            apiCall { api.ingestDocument(filename, text) }.onSuccess {
                refreshActivity()
                pollDocuments()
            }
        }
    }

    fun deleteDocument(id: String) {
        viewModelScope.launch {
            apiCall { api.deleteDocument(id) }
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
            apiCall { api.retryExtraction(id) }
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
            apiCall { api.uploadDocument(filename, bytes, mimeType) }
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
            apiCall { api.listActivity() }.onSuccess { _state.value = _state.value.copy(activity = it) }
        }
    }

    // ---- family chat ----

    private var channelListJob: Job? = null
    private var conversationJob: Job? = null

    /** Poll the channel list (for previews + the unread badge) while signed in. */
    private fun startChannelListPolling() {
        if (channelListJob?.isActive == true) return
        channelListJob = viewModelScope.launch {
            while (true) {
                apiCall { api.listChannels() }.onSuccess { list ->
                    _state.value = _state.value.copy(channels = list)
                }
                delay(8000)
            }
        }
    }

    fun refreshChannels() {
        viewModelScope.launch {
            apiCall { api.listChannels() }.onSuccess { _state.value = _state.value.copy(channels = it) }
        }
        viewModelScope.launch {
            // Always refetch — the directory grows as the admin adds accounts,
            // and a stale cache would leave the new-conversation picker empty.
            apiCall { api.listFamilyMembers() }.onSuccess {
                _state.value = _state.value.copy(familyMembers = it)
            }
        }
        startChannelListPolling()
    }

    fun openChannel(id: String) {
        conversationJob?.cancel()
        val known = _state.value.channels.firstOrNull { it.id == id }
        _state.value = _state.value.copy(activeChannel = known, channelMessages = emptyList())
        conversationJob = viewModelScope.launch {
            var lastTs: String? = null
            // Initial full load.
            apiCall { api.getChannel(id) }.onSuccess {
                _state.value = _state.value.copy(activeChannel = it)
            }
            while (true) {
                val fresh = apiCall { api.listMessages(id, lastTs) }.getOrNull()
                if (fresh != null && fresh.isNotEmpty()) {
                    val merged = (_state.value.channelMessages + fresh)
                        .associateBy { it.id }.values
                        .sortedBy { it.createdAt }
                    _state.value = _state.value.copy(channelMessages = merged)
                    lastTs = merged.lastOrNull()?.createdAt
                    merged.lastOrNull()?.let { api.markChannelRead(id, it.createdAt) }
                }
                // A pending assistant reply resolves in place — re-pull the tail.
                if (_state.value.channelMessages.any { it.pending }) {
                    apiCall { api.listMessages(id, null) }.getOrNull()?.let { all ->
                        _state.value = _state.value.copy(channelMessages = all)
                        lastTs = all.lastOrNull()?.createdAt
                    }
                }
                delay(2500)
            }
        }
    }

    fun closeChannel() {
        conversationJob?.cancel()
        conversationJob = null
        _state.value = _state.value.copy(activeChannel = null, channelMessages = emptyList())
        refreshChannels()
    }

    fun deleteChannel(id: String, onDeleted: () -> Unit) {
        viewModelScope.launch {
            apiCall { api.deleteChannel(id) }.onSuccess {
                conversationJob?.cancel()
                conversationJob = null
                _state.value = _state.value.copy(
                    activeChannel = null,
                    channelMessages = emptyList(),
                    channels = _state.value.channels.filter { it.id != id },
                )
                onDeleted()
                refreshChannels()
            }
        }
    }

    fun startConversation(memberIds: List<String>, name: String?, onOpened: (String) -> Unit) {
        if (memberIds.isEmpty()) return
        val kind = if (memberIds.size == 1 && name.isNullOrBlank()) "dm" else "group"
        viewModelScope.launch {
            apiCall { api.createChannel(kind, memberIds, name?.takeIf { it.isNotBlank() }) }
                .onSuccess { ch ->
                    _state.value = _state.value.copy(channels = listOf(ch) + _state.value.channels.filter { it.id != ch.id })
                    onOpened(ch.id)
                }
        }
    }

    fun sendChannelMessage(body: String, images: List<String> = emptyList()) {
        val channelId = _state.value.activeChannel?.id ?: return
        if (body.isBlank() && images.isEmpty()) return
        // The server requires a non-empty body; stand in for an image-only message.
        val text = body.trim().ifBlank { if (images.size > 1) "(shared images)" else "(shared an image)" }
        val mention = Regex("(^|[^\\w@])@(agent|ai|assistant)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)
        viewModelScope.launch {
            _state.value = _state.value.copy(channelSending = true)
            apiCall { api.postMessage(channelId, text, mention, images) }
                .onSuccess { msg ->
                    val merged = (_state.value.channelMessages + msg)
                        .associateBy { it.id }.values.sortedBy { it.createdAt }
                    _state.value = _state.value.copy(channelMessages = merged)
                }
            _state.value = _state.value.copy(channelSending = false)
        }
    }

    // ---- sticky notes ----

    fun refreshNotes(scope: String = _state.value.noteScope) {
        viewModelScope.launch {
            apiCall { api.listNotes(scope) }.onSuccess {
                _state.value = _state.value.copy(notes = it, noteScope = scope)
            }
        }
    }

    fun setNoteScope(scope: String) {
        _state.value = _state.value.copy(noteScope = scope)
        refreshNotes(scope)
    }

    fun addNote(text: String, color: String) {
        if (text.isBlank()) return
        viewModelScope.launch {
            apiCall { api.createNote(_state.value.noteScope, text.trim(), color) }.onSuccess { refreshNotes() }
        }
    }

    fun editNote(id: String, text: String?, color: String?) {
        viewModelScope.launch {
            apiCall { api.updateNote(id, text, color) }.onSuccess { refreshNotes() }
        }
    }

    fun deleteNote(id: String) {
        viewModelScope.launch {
            apiCall { api.deleteNote(id) }.onSuccess { refreshNotes() }
        }
    }

    // ---- detail bottom-sheet (referenced items + document preview) ----

    fun openDocumentDetail(id: String) {
        _state.value = _state.value.copy(detail = DetailContent.Loading)
        viewModelScope.launch {
            apiCall { api.getDocument(id) }
                .onSuccess { doc ->
                    _state.value = _state.value.copy(detail = DetailContent.DocumentDetail(doc))
                    val isPdf = doc.originalMime == "application/pdf" || doc.filename.endsWith(".pdf", ignoreCase = true)
                    if (isPdf) {
                        runCatching { api.documentOriginal(id) }.getOrNull()?.let { bytes ->
                            if ((_state.value.detail as? DetailContent.DocumentDetail)?.doc?.id == id) {
                                _state.value = _state.value.copy(detail = DetailContent.DocumentDetail(doc, bytes))
                            }
                        }
                    }
                }
                .onFailure { _state.value = _state.value.copy(detail = DetailContent.Failed(it.message ?: "Not found")) }
        }
    }

    fun openTaskDetail(id: String) {
        _state.value = _state.value.copy(detail = DetailContent.Loading)
        viewModelScope.launch {
            apiCall { api.getTask(id) }
                .onSuccess { _state.value = _state.value.copy(detail = DetailContent.TaskDetail(it)) }
                .onFailure { _state.value = _state.value.copy(detail = DetailContent.Failed(it.message ?: "Not found")) }
        }
    }

    fun openReferenceDetail(ref: app.familyagent.android.data.ChatReference) {
        if (ref.type == "task") openTaskDetail(ref.id) else openDocumentDetail(ref.id)
    }

    fun closeDetail() {
        _state.value = _state.value.copy(detail = null)
    }
}
