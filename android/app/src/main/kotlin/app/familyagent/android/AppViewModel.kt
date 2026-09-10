package app.familyagent.android

import android.content.Context
import android.media.MediaPlayer
import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.familyagent.android.data.AGENT_SENDER_ID
import app.familyagent.android.data.ActivityEntry
import app.familyagent.android.data.Channel
import app.familyagent.android.data.Document
import app.familyagent.android.data.DocumentSearchHit
import app.familyagent.android.data.FamilyAgentApi
import app.familyagent.android.data.FamilyMember
import app.familyagent.android.data.McpServer
import app.familyagent.android.data.Message
import app.familyagent.android.data.Routine
import app.familyagent.android.data.SaveMcpServerResponse
import app.familyagent.android.data.SaveSkillRequest
import app.familyagent.android.data.Skill
import app.familyagent.android.data.RoutineInput
import app.familyagent.android.data.RoutineRun
import app.familyagent.android.data.SettingsStore
import app.familyagent.android.data.StickyNote
import app.familyagent.android.data.Task
import app.familyagent.android.data.Tool
import app.familyagent.android.data.UnauthorizedException
import app.familyagent.android.data.User
import app.familyagent.android.data.CreateVaultEntryRequest
import app.familyagent.android.data.UpdateVaultEntryRequest
import app.familyagent.android.data.VaultAccessLogEntry
import app.familyagent.android.data.VaultEntry
import app.familyagent.android.data.VaultEntryDetail
import app.familyagent.android.data.VaultStatus
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
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
    /** Tool calls the assistant made for this reply — see agents/steps.ts. */
    val steps: List<app.familyagent.android.data.ToolStep> = emptyList(),
    /** Generated HTML cards attached to this reply — see agent-core/src/cards/. */
    val cards: List<app.familyagent.android.data.Card> = emptyList(),
)

/** What the detail bottom-sheet is currently showing (a referenced item or a doc preview). */
sealed interface DetailContent {
    data object Loading : DetailContent
    data class DocumentDetail(val doc: Document, val pdfBytes: ByteArray? = null) : DetailContent
    data class TaskDetail(val task: Task) : DetailContent
    data class Failed(val message: String) : DetailContent
    /** "Under the hood" — the tool calls behind one assistant reply. */
    data class Steps(val steps: List<app.familyagent.android.data.ToolStep>) : DetailContent
    /** The raw HTML a generated card was written from. */
    data class CardSource(val title: String, val fragment: String) : DetailContent
}

@Immutable
data class AppUiState(
    val auth: AuthState = AuthState.Unknown,
    val serverUrl: String = "",
    val connection: ConnectionStatus = ConnectionStatus.Connecting,
    val chatMessages: List<ChatMessage> = emptyList(),
    val chatSending: Boolean = false,
    /** Tool calls made so far by the in-flight chat turn (live, while sending). */
    val chatLiveSteps: List<app.familyagent.android.data.ToolStep> = emptyList(),
    /** The persisted session behind [chatMessages]; null until the first turn of a
     *  fresh conversation gets a reply and the server hands one back. */
    val activeChatSessionId: String? = null,
    val chatSessions: List<app.familyagent.android.data.ChatSession> = emptyList(),
    /** Server offers speech-to-text (from /health) — gates the chat mic button. */
    val voiceEnabled: Boolean = false,
    /** Server offers text-to-speech (from /health) — gates the "read aloud" button. */
    val ttsEnabled: Boolean = false,
    /** Read new assistant replies aloud automatically (persisted in DataStore). */
    val autoRead: Boolean = false,
    /** Composer mic button side — true = left of the input field (persisted in DataStore). */
    val micOnLeft: Boolean = false,
    /** The reply text currently being synthesized (null = none). */
    val speakLoadingText: String? = null,
    /** The reply text currently playing aloud (null = none). */
    val speakingText: String? = null,
    /** A recorded voice clip is being transcribed right now. */
    val chatTranscribing: Boolean = false,
    val tasks: List<Task> = emptyList(),
    val documents: List<Document> = emptyList(),
    val activity: List<ActivityEntry> = emptyList(),
    val documentUploadStatus: String? = null,
    // ---- document search ----
    /** Server has an embedding model — "By meaning" search works (else it falls back). */
    val semanticSearchEnabled: Boolean = true,
    val documentSearchQuery: String = "",
    /** keyword | fuzzy | semantic | hybrid */
    val documentSearchMode: String = "hybrid",
    /** null ⇒ not searching (show the full list); a list ⇒ show these ranked hits. */
    val documentSearchResults: List<DocumentSearchHit>? = null,
    val documentSearching: Boolean = false,
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
    /** A recorded voice clip is being transcribed for the family channel. */
    val channelTranscribing: Boolean = false,
    val notes: List<StickyNote> = emptyList(),
    val noteScope: String = "shared",
    // ---- scheduled routines ----
    /** Server has routines enabled (from /health) — hides the Routines drawer item. */
    val routinesEnabled: Boolean = true,
    val routines: List<Routine> = emptyList(),
    /** Transient one-liner under the header ("Running…", "Failed: …"). */
    val routineStatus: String? = null,
    /** Recent runs, loaded on demand when a routine card is expanded. */
    val routineRuns: Map<String, List<RoutineRun>> = emptyMap(),
    // ---- skills ----
    /** /health.skills: "off" hides the Skills drawer item and the /skill command. */
    val skillsMode: String = "off",
    val skills: List<Skill> = emptyList(),
    val skillScriptsRunnable: Boolean = false,
    val skillStatus: String? = null,
    // ---- MCP connections ----
    /** /health.mcp: "on" | "no-servers" | "off". "off" hides Connections + /connect. */
    val mcpMode: String = "off",
    val mcpServers: List<McpServer> = emptyList(),
    val mcpStatus: String? = null,
    // ---- generated HTML cards ----
    /** /health.cards: "on" when the assistant may attach generated cards. */
    val cardsMode: String = "off",
    /** Loaded when the Settings screen opens — for the admin toggle. */
    val serverSettings: app.familyagent.android.data.ServerSettings? = null,
    /** Non-null while the detail bottom-sheet is open. */
    val detail: DetailContent? = null,
    // ---- password vault ----
    /** /health.vault: "on" | "off". "off" hides the Vault drawer item + /vault. */
    val vaultMode: String = "off",
    val vaultAiEnabled: Boolean = false,
    val vaultStatus: VaultStatus? = null,
    val vaultEntries: List<VaultEntry> = emptyList(),
    /** The entry whose detail sheet is open (decrypted), or null. */
    val vaultDetail: VaultEntryDetail? = null,
    val vaultAccessLog: List<VaultAccessLogEntry> = emptyList(),
    /** Transient one-liner shown on the Vault screen. */
    val vaultStatusMsg: String? = null,
    /** A one-time recovery code to show once, then clear. */
    val vaultRecoveryCode: String? = null,
) {
    /** Total unread across every conversation — drives the nav badge. */
    val totalUnread: Int get() = channels.sumOf { it.unreadCount }
}

class AppViewModel(
    private val api: FamilyAgentApi,
    private val settings: SettingsStore,
    private val appContext: Context,
) : ViewModel() {
    private val _state = MutableStateFlow(AppUiState())
    val state: StateFlow<AppUiState> = _state.asStateFlow()

    // ---- text-to-speech playback ----
    private var mediaPlayer: MediaPlayer? = null
    private val speechCache = HashMap<String, ByteArray>()

    init {
        viewModelScope.launch {
            settings.taskView.collect { view ->
                _state.value = _state.value.copy(taskView = view)
            }
        }
        viewModelScope.launch {
            settings.autoRead.collect { on ->
                _state.value = _state.value.copy(autoRead = on)
            }
        }
        viewModelScope.launch {
            settings.micOnLeft.collect { on ->
                _state.value = _state.value.copy(micOnLeft = on)
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
                    activeChatSessionId = null,
                    chatSessions = emptyList(),
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
                        ttsEnabled = h.ttsEnabled,
                        semanticSearchEnabled = h.semanticSearch == "on",
                        routinesEnabled = h.routinesEnabled,
                        skillsMode = h.skills,
                        mcpMode = h.mcp,
                        vaultMode = h.vault,
                        vaultAiEnabled = h.vaultAi,
                        cardsMode = h.cards,
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

    fun sendChat(message: String, images: List<String> = emptyList(), speakReply: Boolean = false) {
        if (message.isBlank() && images.isEmpty()) return
        // The model needs a prompt; supply a default when it's an image only.
        val prompt = message.ifBlank { "What's in this image?" }
        viewModelScope.launch {
            val withUser = _state.value.chatMessages + ChatMessage("user", message, images)
            _state.value = _state.value.copy(chatMessages = withUser, chatSending = true, chatLiveSteps = emptyList())
            val sessionId = _state.value.activeChatSessionId
            val turnId = java.util.UUID.randomUUID().toString()
            // Poll tool calls while the reply is in flight, for live visibility.
            val poll = launch {
                while (isActive) {
                    val r = runCatching { api.turnSteps(turnId) }.getOrNull()
                    if (r != null && r.steps.isNotEmpty()) {
                        _state.value = _state.value.copy(chatLiveSteps = r.steps)
                    }
                    if (r?.done == true) break
                    delay(1000)
                }
            }
            val assistant = apiCall { api.chat(prompt, images, sessionId, turnId) }
                .fold(
                    onSuccess = {
                        _state.value = _state.value.copy(activeChatSessionId = it.sessionId)
                        ChatMessage("assistant", it.reply, references = it.references, steps = it.steps, cards = it.cards)
                    },
                    onFailure = { ChatMessage("assistant", "Error: ${it.message}") },
                )
            poll.cancel()
            _state.value = _state.value.copy(
                chatMessages = withUser + assistant,
                chatSending = false,
                chatLiveSteps = emptyList(),
            )
            // Speak the reply when auto-read is on, or when this turn came in by
            // voice (push-to-talk) — the user chose to talk, so talk back.
            if (assistant.role == "assistant" && !assistant.text.startsWith("Error:") &&
                _state.value.ttsEnabled && (speakReply || _state.value.autoRead)
            ) {
                speak(assistant.text)
            }
            refreshActivity()
            refreshChatSessions()
        }
    }

    /** Transcribe a clip via /transcribe. Reports a friendly message on empty
     *  speech or failure; returns the text (or null). */
    private suspend fun runTranscribe(wav: ByteArray, onProblem: (String) -> Unit): String? {
        if (wav.isEmpty()) return null
        return apiCall { api.transcribe(wav) }.fold(
            onSuccess = { r ->
                if (r.text.isBlank()) {
                    onProblem("Didn't catch any speech — try again, closer to the mic.")
                    null
                } else r.text
            },
            onFailure = { onProblem("Voice input failed: ${it.message}"); null },
        )
    }

    /** Push-to-talk in Chat: transcribe the held clip, then send it and speak
     *  the reply back. */
    fun sendChatVoice(wav: ByteArray) {
        viewModelScope.launch {
            _state.value = _state.value.copy(chatTranscribing = true)
            val text = runTranscribe(wav) { msg ->
                _state.value = _state.value.copy(
                    chatMessages = _state.value.chatMessages + ChatMessage("assistant", msg),
                )
            }
            _state.value = _state.value.copy(chatTranscribing = false)
            if (text != null) sendChat(text, speakReply = true)
        }
    }

    // ---- read a reply aloud (TTS) ----
    // One player at a time; the synthesized WAV is cached per reply so a replay
    // is instant. The button in the bubble reflects speakLoadingText /
    // speakingText.

    fun speak(text: String) {
        val body = text.trim()
        if (body.isEmpty()) return
        if (_state.value.speakingText == body || _state.value.speakLoadingText == body) {
            stopSpeech()
            return
        }
        stopSpeech()
        val cached = speechCache[body]
        if (cached != null) {
            playWav(body, cached)
            return
        }
        _state.value = _state.value.copy(speakLoadingText = body)
        viewModelScope.launch {
            apiCall { api.speak(body) }.fold(
                onSuccess = { bytes ->
                    speechCache[body] = bytes
                    // The user may have hit stop / navigated while it loaded.
                    if (_state.value.speakLoadingText == body) playWav(body, bytes)
                    else _state.value = _state.value.copy(speakLoadingText = null)
                },
                onFailure = {
                    _state.value = _state.value.copy(
                        speakLoadingText = null,
                        chatMessages = _state.value.chatMessages +
                            ChatMessage("assistant", "Couldn't read that aloud: ${it.message}"),
                    )
                },
            )
        }
    }

    private fun playWav(text: String, bytes: ByteArray) {
        runCatching {
            val file = java.io.File(appContext.cacheDir, "tts-reply.wav")
            file.writeBytes(bytes)
            val mp = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener { stopSpeech() }
                setOnErrorListener { _, _, _ -> stopSpeech(); true }
                prepare()
                start()
            }
            mediaPlayer = mp
            _state.value = _state.value.copy(speakLoadingText = null, speakingText = text)
        }.onFailure {
            _state.value = _state.value.copy(speakLoadingText = null, speakingText = null)
        }
    }

    fun stopSpeech() {
        mediaPlayer?.let { runCatching { it.stop() }; it.release() }
        mediaPlayer = null
        if (_state.value.speakingText != null || _state.value.speakLoadingText != null) {
            _state.value = _state.value.copy(speakingText = null, speakLoadingText = null)
        }
    }

    fun setAutoRead(on: Boolean) {
        viewModelScope.launch { settings.setAutoRead(on) }
    }

    fun setMicOnLeft(on: Boolean) {
        viewModelScope.launch { settings.setMicOnLeft(on) }
    }

    override fun onCleared() {
        mediaPlayer?.release()
        mediaPlayer = null
        super.onCleared()
    }

    // ---- chat history sessions (private 1:1 assistant chat) ----
    // Single-writer (this device), so unlike family chat there's no polling —
    // just refresh-on-demand.

    fun refreshChatSessions() {
        viewModelScope.launch {
            apiCall { api.listChatSessions() }.onSuccess { _state.value = _state.value.copy(chatSessions = it) }
        }
    }

    /** Start a brand-new conversation. Nothing is created server-side until the
     *  first message actually sends (see POST /chat's lazy session creation). */
    fun startNewChatSession() {
        _state.value = _state.value.copy(chatMessages = emptyList(), activeChatSessionId = null)
    }

    fun openChatSession(id: String) {
        if (id == _state.value.activeChatSessionId) return
        viewModelScope.launch {
            apiCall { api.getChatSessionMessages(id) }.onSuccess { messages ->
                _state.value = _state.value.copy(
                    activeChatSessionId = id,
                    chatMessages = messages.map {
                        ChatMessage(role = it.role, text = it.body, images = it.images, references = it.refs, steps = it.steps, cards = it.cards)
                    },
                )
            }
        }
    }

    fun deleteChatSession(id: String) {
        viewModelScope.launch {
            apiCall { api.deleteChatSession(id) }.onSuccess {
                _state.value = _state.value.copy(chatSessions = _state.value.chatSessions.filter { it.id != id })
                if (id == _state.value.activeChatSessionId) startNewChatSession()
            }
        }
    }

    /**
     * Transcribe a recorded voice clip and hand the text back to the composer
     * (via [onText]) for the user to review — never auto-sent. A failed or
     * empty transcription drops an assistant note into the chat thread.
     */
    fun transcribeVoice(wav: ByteArray, onText: (String) -> Unit) {
        if (wav.isEmpty()) return
        viewModelScope.launch {
            _state.value = _state.value.copy(chatTranscribing = true)
            val text = runTranscribe(wav) { msg ->
                _state.value = _state.value.copy(
                    chatMessages = _state.value.chatMessages + ChatMessage("assistant", msg),
                )
            }
            _state.value = _state.value.copy(chatTranscribing = false)
            if (text != null) onText(text)
            refreshActivity()
        }
    }

    /** Dictation in a family channel — transcript goes to the composer for
     *  review (never auto-sent). Errors are surfaced by the mic returning to
     *  idle with nothing inserted. */
    fun transcribeChannelVoice(wav: ByteArray, onText: (String) -> Unit) {
        if (wav.isEmpty()) return
        viewModelScope.launch {
            _state.value = _state.value.copy(channelTranscribing = true)
            val text = runTranscribe(wav) { /* transient */ }
            _state.value = _state.value.copy(channelTranscribing = false)
            if (text != null) onText(text)
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
        // Keep an active search fresh too, so a delete / rename / extraction poll
        // re-ranks rather than dropping the user back to the list.
        _state.value.documentSearchQuery.takeIf { it.isNotBlank() }?.let {
            runDocumentSearch(it, _state.value.documentSearchMode)
        }
    }

    // ---- document search ----

    private var docSearchJob: Job? = null

    /** Update the query / mode from the Documents search bar (debounced). Blank
     *  query ⇒ clear results and show the full list. */
    fun setDocumentSearch(query: String, mode: String) {
        _state.value = _state.value.copy(documentSearchQuery = query, documentSearchMode = mode)
        docSearchJob?.cancel()
        if (query.isBlank()) {
            _state.value = _state.value.copy(documentSearchResults = null, documentSearching = false)
            return
        }
        docSearchJob = viewModelScope.launch {
            delay(220)
            runDocumentSearch(query, mode)
        }
    }

    private fun runDocumentSearch(query: String, mode: String) {
        viewModelScope.launch {
            _state.value = _state.value.copy(documentSearching = true)
            apiCall { api.searchDocuments(query, mode = mode, limit = 12) }
                .onSuccess {
                    // Ignore a stale response if the query moved on.
                    if (_state.value.documentSearchQuery == query) {
                        _state.value = _state.value.copy(documentSearchResults = it, documentSearching = false)
                    }
                }
                .onFailure { err ->
                    _state.value = _state.value.copy(
                        documentSearching = false,
                        documentUploadStatus = "Search failed: ${err.message}",
                    )
                }
        }
    }

    /** Drop out of search — used after adding a document so the new file shows. */
    private fun clearDocumentSearch() {
        docSearchJob?.cancel()
        _state.value = _state.value.copy(
            documentSearchQuery = "",
            documentSearchResults = null,
            documentSearching = false,
        )
    }

    fun ingestDocument(filename: String, text: String) {
        viewModelScope.launch {
            apiCall { api.ingestDocument(filename, text) }.onSuccess {
                clearDocumentSearch()
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

    /** Apply a rename the user confirmed. [byAgent] tags an AI-suggested name in the activity log. */
    fun renameDocument(id: String, filename: String, byAgent: Boolean) {
        viewModelScope.launch {
            apiCall { api.renameDocument(id, filename, if (byAgent) "document-agent" else "user") }
                .onSuccess {
                    refreshDocuments()
                    refreshActivity()
                }
                .onFailure { err ->
                    _state.value = _state.value.copy(documentUploadStatus = "Rename failed: ${err.message}")
                }
        }
    }

    /** Fetch an AI-proposed name for the user to confirm or edit. Never applies it. */
    fun suggestDocumentName(id: String, onResult: (Result<String>) -> Unit) {
        viewModelScope.launch {
            onResult(apiCall { api.suggestDocumentName(id).suggestion.filename })
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
                    clearDocumentSearch()
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
        speakNextChannelReplyUntil = 0L
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
                    maybeSpeakChannelReply(merged.lastOrNull())
                }
                // A pending assistant reply resolves in place — re-pull the tail.
                if (_state.value.channelMessages.any { it.pending }) {
                    apiCall { api.listMessages(id, null) }.getOrNull()?.let { all ->
                        _state.value = _state.value.copy(channelMessages = all)
                        lastTs = all.lastOrNull()?.createdAt
                        maybeSpeakChannelReply(all.lastOrNull())
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

    // A push-to-talk send in a channel wants the @agent reply spoken back once
    // it lands (it arrives via the poll loop). Timestamped so a stale intent
    // can't grab an unrelated later reply; tracks the id it already spoke.
    private var speakNextChannelReplyUntil = 0L
    private var spokenChannelReplyId: String? = null

    private fun maybeSpeakChannelReply(last: Message?) {
        if (last == null || System.currentTimeMillis() >= speakNextChannelReplyUntil) return
        if (last.senderId != AGENT_SENDER_ID || last.pending || last.body.isBlank()) return
        if (last.id == spokenChannelReplyId) return
        spokenChannelReplyId = last.id
        speakNextChannelReplyUntil = 0L
        if (_state.value.ttsEnabled) speak(last.body)
    }

    fun sendChannelMessage(body: String, images: List<String> = emptyList(), speakReply: Boolean = false) {
        val channelId = _state.value.activeChannel?.id ?: return
        if (body.isBlank() && images.isEmpty()) return
        // The server requires a non-empty body; stand in for an image-only message.
        val text = body.trim().ifBlank { if (images.size > 1) "(shared images)" else "(shared an image)" }
        val mention = Regex("(^|[^\\w@])@(agent|ai|assistant)\\b", RegexOption.IGNORE_CASE).containsMatchIn(text)
        if (speakReply) {
            speakNextChannelReplyUntil = System.currentTimeMillis() + 240_000
            spokenChannelReplyId = null
        }
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

    /** Push-to-talk in a family channel: transcribe the held clip, send it, and
     *  speak the @agent reply back when it arrives. */
    fun sendChannelVoice(wav: ByteArray) {
        viewModelScope.launch {
            _state.value = _state.value.copy(channelTranscribing = true)
            val text = runTranscribe(wav) { /* transient — surfaced via the mic returning to idle */ }
            _state.value = _state.value.copy(channelTranscribing = false)
            // Send as spoken. If it addresses @agent (or a "/" command), the
            // reply is spoken back when it lands; a plain message to family
            // members has no reply to speak, which is correct.
            if (text != null) sendChannelMessage(text, speakReply = true)
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

    /** "+ Add" — pins a blank note the user then fills in. [onCreated] gets the new note. */
    fun addBlankNote(x: Float, y: Float, onCreated: (StickyNote) -> Unit) {
        viewModelScope.launch {
            apiCall { api.createNote(_state.value.noteScope, "", null, x, y) }.onSuccess { note ->
                _state.value = _state.value.copy(notes = _state.value.notes + note)
                onCreated(note)
            }
        }
    }

    fun editNote(id: String, text: String?, color: String?) {
        viewModelScope.launch {
            apiCall { api.updateNote(id, text = text, color = color) }.onSuccess { refreshNotes() }
        }
    }

    /** A drag ended — persist the new position, keeping the local copy in step. */
    fun moveNote(id: String, x: Float, y: Float) {
        _state.value = _state.value.copy(
            notes = _state.value.notes.map { if (it.id == id) it.copy(x = x, y = y) else it },
        )
        viewModelScope.launch { apiCall { api.updateNote(id, x = x, y = y) } }
    }

    fun deleteNote(id: String) {
        _state.value = _state.value.copy(notes = _state.value.notes.filterNot { it.id == id })
        viewModelScope.launch {
            apiCall { api.deleteNote(id) }.onSuccess { refreshNotes() }
        }
    }

    // ---- scheduled routines ----

    fun refreshRoutines() {
        viewModelScope.launch {
            apiCall { api.listRoutines() }
                .onSuccess { _state.value = _state.value.copy(routines = it) }
                .onFailure { _state.value = _state.value.copy(routineStatus = it.message) }
        }
    }

    /** Create or (when [id] is non-null) edit a routine. [onDone] closes the sheet;
     *  [onError] shows the server's validation message inside it. */
    fun saveRoutine(id: String?, input: RoutineInput, onDone: () -> Unit, onError: (String) -> Unit) {
        viewModelScope.launch {
            val call = if (id == null) apiCall { api.createRoutine(input) } else apiCall { api.updateRoutine(id, input) }
            call
                .onSuccess {
                    onDone()
                    refreshRoutines()
                }
                .onFailure { onError(it.message ?: "Could not save the routine.") }
        }
    }

    fun setRoutineEnabled(id: String, enabled: Boolean) {
        _state.value = _state.value.copy(
            routines = _state.value.routines.map { if (it.id == id) it.copy(enabled = enabled) else it },
        )
        viewModelScope.launch {
            apiCall { api.setRoutineEnabled(id, enabled) }.onSuccess { refreshRoutines() }
        }
    }

    fun deleteRoutine(id: String) {
        _state.value = _state.value.copy(routines = _state.value.routines.filterNot { it.id == id })
        viewModelScope.launch { apiCall { api.deleteRoutine(id) }.onSuccess { refreshRoutines() } }
    }

    fun runRoutineNow(id: String) {
        val name = _state.value.routines.find { it.id == id }?.name ?: "routine"
        _state.value = _state.value.copy(routineStatus = "Running \"$name\"…")
        viewModelScope.launch {
            apiCall { api.runRoutine(id) }
                .onSuccess { r ->
                    _state.value = _state.value.copy(
                        routineStatus = if (r.status == "ok") "\"$name\" ran." else "\"$name\" failed: ${r.error ?: "unknown error"}",
                    )
                    loadRoutineRuns(id)
                    refreshRoutines()
                }
                .onFailure { _state.value = _state.value.copy(routineStatus = it.message ?: "Run failed.") }
        }
    }

    fun loadRoutineRuns(id: String) {
        viewModelScope.launch {
            apiCall { api.listRoutineRuns(id, 10) }.onSuccess { runs ->
                _state.value = _state.value.copy(routineRuns = _state.value.routineRuns + (id to runs))
            }
        }
    }

    // ---- password vault ----
    // Thin wrapper over /vault/*. All crypto is server-side; the app only ever
    // sees decrypted values for entries the signed-in user may read, and only
    // while their vault is unlocked (in-memory, server-side).

    fun refreshVault() {
        if (_state.value.vaultMode != "on") return
        viewModelScope.launch {
            apiCall { api.vaultStatus() }.onSuccess { st ->
                _state.value = _state.value.copy(vaultStatus = st)
                if (st.unlocked) {
                    apiCall { api.listVaultEntries() }
                        .onSuccess { _state.value = _state.value.copy(vaultEntries = it, vaultStatusMsg = null) }
                        .onFailure { _state.value = _state.value.copy(vaultStatusMsg = it.message) }
                }
            }
        }
    }

    private fun vaultBusy(msg: String?) {
        _state.value = _state.value.copy(vaultStatusMsg = msg)
    }

    fun vaultSetup(password: String) {
        vaultBusy("Creating…")
        viewModelScope.launch {
            apiCall { api.vaultSetup(password) }
                .onSuccess {
                    _state.value = _state.value.copy(
                        vaultStatus = it.status,
                        vaultRecoveryCode = it.recoveryCode,
                        vaultStatusMsg = null,
                    )
                    refreshVault()
                }
                .onFailure { vaultBusy(it.message ?: "Setup failed.") }
        }
    }

    fun vaultUnlock(password: String) {
        vaultBusy("Unlocking…")
        viewModelScope.launch {
            apiCall { api.vaultUnlock(password) }
                .onSuccess {
                    _state.value = _state.value.copy(vaultStatus = it.status, vaultStatusMsg = null)
                    refreshVault()
                }
                .onFailure { vaultBusy(it.message ?: "Wrong password.") }
        }
    }

    fun vaultLock() {
        viewModelScope.launch {
            apiCall { api.vaultLock() }.onSuccess {
                _state.value = _state.value.copy(
                    vaultStatus = it.status, vaultEntries = emptyList(), vaultDetail = null,
                )
            }
        }
    }

    fun vaultRecover(recoveryCode: String, password: String) {
        vaultBusy("Recovering…")
        viewModelScope.launch {
            apiCall { api.vaultRecover(recoveryCode, password) }
                .onSuccess {
                    _state.value = _state.value.copy(
                        vaultStatus = it.status,
                        vaultRecoveryCode = it.recoveryCode,
                        vaultStatusMsg = null,
                    )
                    refreshVault()
                }
                .onFailure { vaultBusy(it.message ?: "Recovery failed.") }
        }
    }

    fun vaultFamilySync() {
        viewModelScope.launch {
            apiCall { api.vaultFamilySync() }
                .onSuccess {
                    vaultBusy(if (it.granted > 0) "Granted access to ${it.granted} member(s)." else "Everyone already has access.")
                    refreshVault()
                }
                .onFailure { vaultBusy(it.message ?: "Sync failed.") }
        }
    }

    fun dismissVaultRecoveryCode() {
        _state.value = _state.value.copy(vaultRecoveryCode = null)
    }

    fun openVaultEntry(id: String) {
        viewModelScope.launch {
            apiCall { api.getVaultEntry(id) }
                .onSuccess { _state.value = _state.value.copy(vaultDetail = it) }
                .onFailure { vaultBusy(it.message) }
        }
    }

    fun closeVaultEntry() {
        _state.value = _state.value.copy(vaultDetail = null)
    }

    suspend fun vaultCurrentTotp(id: String): Pair<String, Int>? =
        apiCall { api.vaultTotp(id) }.getOrNull()?.let { it.code to it.expiresInSeconds }

    fun saveVaultEntry(
        id: String?,
        req: CreateVaultEntryRequest?,
        patch: UpdateVaultEntryRequest?,
        onDone: () -> Unit,
        onError: (String) -> Unit,
    ) {
        viewModelScope.launch {
            val call =
                if (id == null && req != null) apiCall { api.createVaultEntry(req) }
                else if (id != null && patch != null) apiCall { api.updateVaultEntry(id, patch) }
                else { onError("nothing to save"); return@launch }
            call
                .onSuccess {
                    onDone()
                    if (id != null) openVaultEntry(id)
                    refreshVault()
                }
                .onFailure { onError(it.message ?: "Could not save.") }
        }
    }

    fun deleteVaultEntry(id: String) {
        _state.value = _state.value.copy(
            vaultEntries = _state.value.vaultEntries.filterNot { it.id == id },
            vaultDetail = null,
        )
        viewModelScope.launch { apiCall { api.deleteVaultEntry(id) }.onSuccess { refreshVault() } }
    }

    fun loadVaultAccessLog() {
        viewModelScope.launch {
            apiCall { api.vaultAccessLog() }.onSuccess {
                _state.value = _state.value.copy(vaultAccessLog = it)
            }
        }
    }

    // ---- skills ----
    // All the skill logic (markdown parsing, sandboxed scripts) is in agent-core;
    // this is a thin CRUD wrapper over GET/POST/PATCH/DELETE /skills.

    fun refreshSkills() {
        if (_state.value.skillsMode == "off") return
        viewModelScope.launch {
            apiCall { api.listSkills() }
                .onSuccess {
                    _state.value = _state.value.copy(
                        skills = it.skills,
                        skillScriptsRunnable = it.scriptsRunnable,
                        skillStatus = null,
                    )
                }
                .onFailure { _state.value = _state.value.copy(skillStatus = it.message) }
        }
    }

    /** Loads the full markdown body for the edit sheet. */
    fun loadSkillBody(name: String, onBody: (String) -> Unit) {
        viewModelScope.launch {
            apiCall { api.getSkill(name) }
                .onSuccess { onBody(it.body ?: "") }
                .onFailure { onBody("") }
        }
    }

    fun saveSkill(req: SaveSkillRequest, onDone: () -> Unit, onError: (String) -> Unit) {
        viewModelScope.launch {
            apiCall { api.saveSkill(req) }
                .onSuccess { onDone(); refreshSkills() }
                .onFailure { onError(it.message ?: "Could not save the skill.") }
        }
    }

    fun draftSkill(name: String, description: String, onDraft: (String) -> Unit, onError: (String) -> Unit) {
        viewModelScope.launch {
            apiCall { api.draftSkill(name, description) }
                .onSuccess { onDraft(it) }
                .onFailure { onError(it.message ?: "Draft failed.") }
        }
    }

    fun setSkillEnabled(name: String, enabled: Boolean) {
        _state.value = _state.value.copy(
            skills = _state.value.skills.map { if (it.name == name) it.copy(enabled = enabled) else it },
        )
        viewModelScope.launch { apiCall { api.setSkillEnabled(name, enabled) }.onSuccess { refreshSkills() } }
    }

    fun deleteSkill(name: String) {
        _state.value = _state.value.copy(skills = _state.value.skills.filterNot { it.name == name })
        viewModelScope.launch { apiCall { api.deleteSkill(name) }.onSuccess { refreshSkills() } }
    }

    // ---- MCP connections ----

    fun refreshConnections() {
        if (_state.value.mcpMode == "off") return
        viewModelScope.launch {
            apiCall { api.listMcpServers() }
                .onSuccess { _state.value = _state.value.copy(mcpServers = it, mcpStatus = null) }
                .onFailure { _state.value = _state.value.copy(mcpStatus = it.message) }
        }
    }

    fun saveMcpServer(server: McpServer, onResult: (SaveMcpServerResponse) -> Unit, onError: (String) -> Unit) {
        viewModelScope.launch {
            apiCall { api.saveMcpServer(server) }
                .onSuccess { onResult(it); refreshStatus(); refreshConnections() }
                .onFailure { onError(it.message ?: "Could not save the connection.") }
        }
    }

    fun setMcpServerEnabled(name: String, enabled: Boolean) {
        _state.value = _state.value.copy(
            mcpServers = _state.value.mcpServers.map { if (it.name == name) it.copy(enabled = enabled) else it },
        )
        viewModelScope.launch {
            apiCall { api.setMcpServerEnabled(name, enabled) }.onSuccess { refreshStatus(); refreshConnections() }
        }
    }

    fun deleteMcpServer(name: String) {
        _state.value = _state.value.copy(mcpServers = _state.value.mcpServers.filterNot { it.name == name })
        viewModelScope.launch {
            apiCall { api.deleteMcpServer(name) }.onSuccess { refreshStatus(); refreshConnections() }
        }
    }

    fun probeMcpServer(name: String, onResult: (String) -> Unit) {
        viewModelScope.launch {
            apiCall { api.probeMcpServer(name) }
                .onSuccess { onResult(if (it.ok) "${it.toolCount ?: 0} tool(s) available" else "Failed: ${it.error ?: "unknown"}") }
                .onFailure { onResult(it.message ?: "Test failed.") }
        }
    }

    // ---- detail bottom-sheet (referenced items + document preview) ----

    fun showStepsDetail(steps: List<app.familyagent.android.data.ToolStep>) {
        _state.value = _state.value.copy(detail = DetailContent.Steps(steps))
    }

    fun showCardSource(card: app.familyagent.android.data.Card) {
        _state.value = _state.value.copy(detail = DetailContent.CardSource(card.title, card.fragment))
    }

    fun refreshServerSettings() {
        viewModelScope.launch {
            apiCall { api.getSettings() }.onSuccess { _state.value = _state.value.copy(serverSettings = it) }
        }
    }

    fun setCardsEnabled(enabled: Boolean) {
        viewModelScope.launch {
            apiCall { api.setCardsEnabled(enabled) }.onSuccess {
                _state.value = _state.value.copy(serverSettings = it, cardsMode = if (it.cardsEnabled) "on" else "off")
            }
        }
    }

    /** Set internet access: provider "none" = off; searxng needs [url]; tavily/brave need [apiKey]. */
    fun setWebAccess(provider: String, url: String?, apiKey: String?, onDone: () -> Unit, onError: (String) -> Unit) {
        viewModelScope.launch {
            apiCall { api.setWebAccess(provider, url, apiKey) }
                .onSuccess {
                    _state.value = _state.value.copy(serverSettings = it)
                    onDone()
                }
                .onFailure { onError(it.message ?: "Couldn't change internet access") }
        }
    }

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
