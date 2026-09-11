package app.familyagent.android.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

private fun String.encodeQuery(): String = URLEncoder.encode(this, "UTF-8")

/** Thrown for any non-2xx response or transport failure, with a message safe to show the user. */
open class ApiException(message: String) : IOException(message)

/** The server rejected our session token — the app should drop back to sign-in. */
class UnauthorizedException(message: String = "Your session has expired. Sign in again.") : ApiException(message)

private val JSON_MEDIA_TYPE = "application/json".toMediaType()
private val json = Json { ignoreUnknownKeys = true }

/**
 * Thin client over agent-core's local HTTP API. Takes a base URL rather than
 * assuming localhost, since on a phone that's always the desktop's address
 * on the LAN (or, once wired up, the tailnet) — see docs/DECISIONS.md for
 * why this app doesn't yet do Tailscale discovery itself.
 */
class FamilyAgentApi(
    private var baseUrl: String,
    /** Bearer token for the signed-in family member; null before sign-in. */
    var authToken: String? = null,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build(),
) {
    fun updateBaseUrl(url: String) {
        baseUrl = url.trimEnd('/')
    }

    private fun Request.Builder.withAuth(): Request.Builder =
        authToken?.let { header("Authorization", "Bearer $it") } ?: this

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        execute(Request.Builder().url("$baseUrl$path").get().withAuth().build())
    }

    /** Raw response bytes — for a document's original file (PDF / image preview). */
    suspend fun getBytes(path: String): ByteArray = withContext(Dispatchers.IO) {
        try {
            client.newCall(Request.Builder().url("$baseUrl$path").get().withAuth().build()).execute().use { response ->
                if (response.code == 401) throw UnauthorizedException()
                if (!response.isSuccessful) throw ApiException("${path}: HTTP ${response.code}")
                response.body?.bytes() ?: ByteArray(0)
            }
        } catch (e: IOException) {
            if (e is ApiException) throw e
            throw ApiException("Could not reach $baseUrl — is the home server running? (${e.message})")
        }
    }

    private suspend fun send(method: String, path: String, body: String): String = withContext(Dispatchers.IO) {
        execute(
            Request.Builder()
                .url("$baseUrl$path")
                .method(method, body.toRequestBody(JSON_MEDIA_TYPE))
                .withAuth()
                .build()
        )
    }

    private suspend fun sendNoBody(method: String, path: String): String = withContext(Dispatchers.IO) {
        // OkHttp requires a non-null body for POST but allows null for DELETE.
        // Send an empty body with NO content-type — Fastify 400s a request that
        // declares application/json but has an empty body.
        val body = if (method == "DELETE") null else ByteArray(0).toRequestBody(null)
        execute(Request.Builder().url("$baseUrl$path").method(method, body).withAuth().build())
    }

    private fun execute(request: Request): String {
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (response.code == 401) {
                    throw UnauthorizedException()
                }
                if (!response.isSuccessful) {
                    val detail = runCatching { json.parseToJsonElement(text) }.getOrNull()
                    throw ApiException("${request.url.encodedPath}: HTTP ${response.code}${detail?.let { " — $it" } ?: ""}")
                }
                return text
            }
        } catch (e: IOException) {
            if (e is ApiException) throw e
            throw ApiException("Could not reach $baseUrl — is the home server running? (${e.message})")
        }
    }

    suspend fun health(): HealthResponse = json.decodeFromString(get("/health"))

    // ---- auth ----
    suspend fun authStatus(): AuthStatusResponse = json.decodeFromString(get("/auth/status"))

    suspend fun login(username: String, password: String): LoginResponse =
        json.decodeFromString(
            send("POST", "/auth/login", json.encodeToString(LoginRequest(username, password, deviceLabel = "android")))
        )

    suspend fun me(): User = json.decodeFromString<MeResponse>(get("/auth/me")).user

    suspend fun logout() {
        runCatching { sendNoBody("POST", "/auth/logout") }
    }

    suspend fun chat(
        message: String,
        images: List<String> = emptyList(),
        sessionId: String? = null,
        turnId: String? = null,
    ): ChatResponse =
        json.decodeFromString(send("POST", "/chat", json.encodeToString(ChatRequest(message, images, sessionId, turnId))))

    /** Poll the tool calls made so far by an in-flight turn. */
    suspend fun turnSteps(turnId: String): TurnStepsResponse =
        json.decodeFromString(get("/chat/turns/${turnId.encodeQuery()}"))

    suspend fun getSettings(): ServerSettings = json.decodeFromString(get("/settings"))

    suspend fun setCardsEnabled(enabled: Boolean): ServerSettings =
        json.decodeFromString(send("PUT", "/settings", json.encodeToString(UpdateSettingsRequest(cardsEnabled = enabled))))

    suspend fun setVaultEnabled(enabled: Boolean): ServerSettings =
        json.decodeFromString(send("PUT", "/settings", json.encodeToString(UpdateSettingsRequest(vaultEnabled = enabled))))

    // ---- remote update-and-restart of the host desktop app ----
    suspend fun getDesktopUpdateStatus(): DesktopUpdateStatus = json.decodeFromString(get("/system/update-status"))
    suspend fun requestDesktopUpdate(): DesktopUpdateStatus =
        json.decodeFromString(sendNoBody("POST", "/system/update-request"))

    /** Set the internet-access provider (`"none"` = off) and its companion URL / API key. */
    suspend fun setWebAccess(provider: String, url: String? = null, apiKey: String? = null): ServerSettings =
        json.decodeFromString(
            send(
                "PUT", "/settings",
                json.encodeToString(
                    UpdateSettingsRequest(webSearchProvider = provider, webSearchUrl = url, webSearchApiKey = apiKey),
                ),
            ),
        )

    // ---- chat history sessions (private 1:1 assistant chat) ----
    suspend fun listChatSessions(): List<ChatSession> =
        json.decodeFromString<ChatSessionsResponse>(get("/chat/sessions")).sessions

    suspend fun getChatSessionMessages(id: String): List<ChatSessionMessage> =
        json.decodeFromString<ChatSessionMessagesResponse>(get("/chat/sessions/$id/messages")).messages

    suspend fun renameChatSession(id: String, title: String): ChatSession =
        json.decodeFromString<ChatSessionResponse>(
            send("PATCH", "/chat/sessions/$id", json.encodeToString(RenameChatSessionRequest(title)))
        ).session

    suspend fun deleteChatSession(id: String) {
        sendNoBody("DELETE", "/chat/sessions/$id")
    }

    /** Upload a recorded voice clip (16 kHz mono WAV) and get back the transcript. */
    suspend fun transcribe(wav: ByteArray): TranscribeResponse = withContext(Dispatchers.IO) {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("audio", "voice.wav", wav.toRequestBody("audio/wav".toMediaTypeOrNull()))
            .build()
        val request = Request.Builder().url("$baseUrl/transcribe").post(body).withAuth().build()
        json.decodeFromString(execute(request))
    }

    /** Synthesize an assistant reply to speech — returns WAV bytes to play.
     *  The first call downloads the Kokoro model (~86 MB) so it can take ~20s. */
    suspend fun speak(text: String, voice: String? = null): ByteArray = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url("$baseUrl/speak")
            .post(json.encodeToString(SpeakRequest(text, voice)).toRequestBody(JSON_MEDIA_TYPE))
            .withAuth()
            .build()
        try {
            client.newCall(req).execute().use { response ->
                if (response.code == 401) throw UnauthorizedException()
                if (!response.isSuccessful) {
                    val detail = runCatching { json.parseToJsonElement(response.body?.string().orEmpty()) }.getOrNull()
                    throw ApiException("/speak: HTTP ${response.code}${detail?.let { " — $it" } ?: ""}")
                }
                response.body?.bytes() ?: ByteArray(0)
            }
        } catch (e: IOException) {
            if (e is ApiException) throw e
            throw ApiException("Could not reach $baseUrl (${e.message})")
        }
    }

    suspend fun ttsVoices(): TtsVoicesResponse = json.decodeFromString(get("/tts/voices"))

    suspend fun listTasks(): List<Task> = json.decodeFromString<TasksResponse>(get("/tasks")).tasks

    suspend fun getTask(id: String): Task = json.decodeFromString<TaskResponse>(get("/tasks/$id")).task

    suspend fun getDocument(id: String): Document =
        json.decodeFromString<DocumentResponse>(get("/documents/$id")).document

    suspend fun createTask(title: String, dueDate: String?, dueTime: String? = null): Task =
        json.decodeFromString<TaskResponse>(
            send("POST", "/tasks", json.encodeToString(CreateTaskRequest(title, dueDate, dueTime)))
        ).task

    suspend fun completeTask(id: String): Task =
        json.decodeFromString<TaskResponse>(
            send("PATCH", "/tasks/$id", json.encodeToString(UpdateTaskRequest("done")))
        ).task

    suspend fun rescheduleTask(id: String, dueDate: String?, dueTime: String?): Task =
        json.decodeFromString<TaskResponse>(
            send("PATCH", "/tasks/$id", json.encodeToString(RescheduleTaskRequest(dueDate, dueTime)))
        ).task

    suspend fun listDocuments(): List<Document> = json.decodeFromString<DocumentsResponse>(get("/documents")).documents

    /**
     * Search documents (filename + full text + summary), ranked, with optional
     * filters. [mode] picks the strategy: keyword | fuzzy (typo-tolerant) |
     * semantic (by meaning) | hybrid (all, the server default).
     */
    suspend fun searchDocuments(
        query: String,
        mode: String? = null,
        category: String? = null,
        dueBefore: String? = null,
        dueAfter: String? = null,
        limit: Int? = null,
    ): List<DocumentSearchHit> {
        val params = buildString {
            append("q=").append(query.encodeQuery())
            mode?.let { append("&mode=").append(it.encodeQuery()) }
            category?.let { append("&category=").append(it.encodeQuery()) }
            dueBefore?.let { append("&dueBefore=").append(it.encodeQuery()) }
            dueAfter?.let { append("&dueAfter=").append(it.encodeQuery()) }
            limit?.let { append("&limit=").append(it) }
        }
        return json.decodeFromString<DocumentSearchResponse>(get("/documents/search?$params")).results
    }

    /** Keyword search over task titles and notes, ranked, optionally filtered by status. */
    suspend fun searchTasks(query: String, status: String? = null): List<TaskSearchHit> {
        val params = buildString {
            append("q=").append(query.encodeQuery())
            status?.let { append("&status=").append(it.encodeQuery()) }
        }
        return json.decodeFromString<TaskSearchResponse>(get("/tasks/search?$params")).results
    }

    suspend fun ingestDocument(filename: String, text: String): Document =
        json.decodeFromString<DocumentResponse>(
            send("POST", "/documents/ingest", json.encodeToString(IngestDocumentRequest(filename, text)))
        ).document

    suspend fun deleteDocument(id: String) {
        sendNoBody("DELETE", "/documents/$id")
    }

    /** The document's original file (PDF / image) for previewing. */
    suspend fun documentOriginal(id: String): ByteArray = getBytes("/documents/$id/original")

    suspend fun retryExtraction(id: String): Document =
        json.decodeFromString<DocumentResponse>(sendNoBody("POST", "/documents/$id/retry-extraction")).document

    /** Rename a document. [by] is "document-agent" when applying an AI suggestion the user confirmed. */
    suspend fun renameDocument(id: String, filename: String, by: String = "user"): Document =
        json.decodeFromString<DocumentResponse>(
            send("PATCH", "/documents/$id", json.encodeToString(RenameDocumentRequest(filename, by)))
        ).document

    /** Ask the local model for a better filename from the document's content. Does not apply it. */
    suspend fun suggestDocumentName(id: String): SuggestNameResponse =
        json.decodeFromString(sendNoBody("POST", "/documents/$id/suggest-name"))

    suspend fun listActivity(): List<ActivityEntry> = json.decodeFromString<ActivityResponse>(get("/activity")).activity

    // ---- family chat ----
    suspend fun listFamilyMembers(): List<FamilyMember> =
        json.decodeFromString<FamilyMembersResponse>(get("/family/members")).members

    suspend fun listChannels(): List<Channel> =
        json.decodeFromString<ChannelsResponse>(get("/channels")).channels

    suspend fun createChannel(kind: String, memberIds: List<String>, name: String?): Channel =
        json.decodeFromString<ChannelResponse>(
            send("POST", "/channels", json.encodeToString(CreateChannelRequest(kind, memberIds, name)))
        ).channel

    suspend fun getChannel(id: String): Channel =
        json.decodeFromString<ChannelResponse>(get("/channels/$id")).channel

    suspend fun listMessages(id: String, after: String? = null): List<Message> {
        val q = if (after != null) "?after=${after.encodeQuery()}" else ""
        return json.decodeFromString<MessagesResponse>(get("/channels/$id/messages$q")).messages
    }

    suspend fun postMessage(
        id: String,
        body: String,
        mentionAgent: Boolean,
        images: List<String> = emptyList(),
    ): Message =
        json.decodeFromString<MessageResponse>(
            send("POST", "/channels/$id/messages", json.encodeToString(PostMessageRequest(body, mentionAgent, images)))
        ).message

    suspend fun markChannelRead(id: String, ts: String) {
        runCatching { send("POST", "/channels/$id/read", json.encodeToString(MarkReadRequest(ts))) }
    }

    /** Delete a conversation and its messages for everyone in it. Any member can. */
    suspend fun deleteChannel(id: String) {
        sendNoBody("DELETE", "/channels/$id")
    }

    // ---- sticky notes ----
    suspend fun listNotes(scope: String): List<StickyNote> =
        json.decodeFromString<NotesResponse>(get("/notes?scope=${scope.encodeQuery()}")).notes

    suspend fun createNote(
        scope: String,
        text: String,
        color: String?,
        x: Float? = null,
        y: Float? = null,
    ): StickyNote =
        json.decodeFromString<NoteResponse>(
            send("POST", "/notes", json.encodeToString(CreateNoteRequest(scope, text, color, x, y)))
        ).note

    suspend fun updateNote(
        id: String,
        text: String? = null,
        color: String? = null,
        x: Float? = null,
        y: Float? = null,
    ): StickyNote =
        json.decodeFromString<NoteResponse>(
            send("PATCH", "/notes/$id", json.encodeToString(UpdateNoteRequest(text, color, x, y)))
        ).note

    suspend fun deleteNote(id: String) {
        sendNoBody("DELETE", "/notes/$id")
    }

    // ---- scheduled routines ----
    suspend fun listRoutines(): List<Routine> =
        json.decodeFromString<RoutinesResponse>(get("/routines")).routines

    suspend fun createRoutine(input: RoutineInput): Routine =
        json.decodeFromString<RoutineResponse>(
            send("POST", "/routines", json.encodeToString(input))
        ).routine

    suspend fun updateRoutine(id: String, input: RoutineInput): Routine =
        json.decodeFromString<RoutineResponse>(
            send("PATCH", "/routines/$id", json.encodeToString(input))
        ).routine

    suspend fun setRoutineEnabled(id: String, enabled: Boolean): Routine =
        json.decodeFromString<RoutineResponse>(
            send("PATCH", "/routines/$id", json.encodeToString(SetRoutineEnabledRequest(enabled)))
        ).routine

    suspend fun deleteRoutine(id: String) {
        sendNoBody("DELETE", "/routines/$id")
    }

    suspend fun listRoutineRuns(id: String, limit: Int = 20): List<RoutineRun> =
        json.decodeFromString<RoutineRunsResponse>(get("/routines/$id/runs?limit=$limit")).runs

    /** Run a routine now. The call blocks until the run finishes (can be slow). */
    suspend fun runRoutine(id: String): RunRoutineResponse =
        json.decodeFromString(sendNoBody("POST", "/routines/$id/run"))

    // ---- skills ----
    suspend fun listSkills(): SkillsResponse = json.decodeFromString(get("/skills"))

    suspend fun getSkill(name: String): Skill =
        json.decodeFromString<SkillResponse>(get("/skills/${name.encodeQuery()}")).skill

    suspend fun saveSkill(req: SaveSkillRequest): Skill =
        json.decodeFromString<SkillResponse>(send("POST", "/skills", json.encodeToString(req))).skill

    suspend fun setSkillEnabled(name: String, enabled: Boolean): Skill =
        json.decodeFromString<SkillResponse>(
            send("PATCH", "/skills/${name.encodeQuery()}", json.encodeToString(SetSkillEnabledRequest(enabled)))
        ).skill

    suspend fun deleteSkill(name: String) {
        sendNoBody("DELETE", "/skills/${name.encodeQuery()}")
    }

    suspend fun draftSkill(name: String, description: String): String =
        json.decodeFromString<DraftSkillResponse>(
            send("POST", "/skills/draft", json.encodeToString(DraftSkillRequest(name, description)))
        ).markdown

    // ---- MCP connections ----
    suspend fun listMcpServers(): List<McpServer> =
        json.decodeFromString<McpServersResponse>(get("/mcp/servers")).servers

    suspend fun saveMcpServer(server: McpServer): SaveMcpServerResponse =
        json.decodeFromString(send("POST", "/mcp/servers", json.encodeToString(server)))

    suspend fun setMcpServerEnabled(name: String, enabled: Boolean) {
        send("PATCH", "/mcp/servers/${name.encodeQuery()}", json.encodeToString(SetSkillEnabledRequest(enabled)))
    }

    suspend fun deleteMcpServer(name: String) {
        sendNoBody("DELETE", "/mcp/servers/${name.encodeQuery()}")
    }

    suspend fun probeMcpServer(name: String): McpProbeResult =
        json.decodeFromString(sendNoBody("POST", "/mcp/servers/${name.encodeQuery()}/probe"))

    suspend fun listMcpTools(): List<McpToolInfo> =
        json.decodeFromString<McpToolsResponse>(get("/mcp/tools")).tools

    suspend fun listTools(): List<Tool> = json.decodeFromString<ToolsResponse>(get("/tools")).tools

    suspend fun buildTool(prompt: String) {
        send("POST", "/tools", json.encodeToString(BuildToolRequest(prompt)))
    }

    suspend fun deleteTool(id: String) {
        sendNoBody("DELETE", "/tools/$id")
    }

    // ---- artifacts (render_artifact) ----

    suspend fun listArtifacts(): List<ArtifactSummary> =
        json.decodeFromString<ArtifactListResponse>(get("/artifacts")).artifacts

    suspend fun getArtifact(id: String): ArtifactResponse =
        json.decodeFromString<ArtifactResponse>(get("/artifacts/$id"))

    suspend fun renameArtifact(id: String, title: String): ArtifactSummary =
        json.decodeFromString<ArtifactSummaryResponse>(
            send("PATCH", "/artifacts/$id", json.encodeToString(RenameArtifactRequest(title)))
        ).artifact

    suspend fun deleteArtifact(id: String) {
        sendNoBody("DELETE", "/artifacts/$id")
    }

    suspend fun revertArtifact(id: String): ResolveCommentsResponse =
        json.decodeFromString(send("POST", "/artifacts/$id/revert", "{}"))

    suspend fun artifactComments(id: String): List<ArtifactComment> =
        json.decodeFromString<ArtifactCommentsResponse>(get("/artifacts/$id/comments")).comments

    suspend fun addArtifactComment(id: String, req: NewArtifactCommentRequest): ArtifactComment =
        json.decodeFromString<ArtifactCommentResponse>(
            send("POST", "/artifacts/$id/comments", json.encodeToString(req))
        ).comment

    suspend fun deleteArtifactComment(id: String, cid: String) {
        sendNoBody("DELETE", "/artifacts/$id/comments/$cid")
    }

    suspend fun reopenArtifactComment(id: String, cid: String): ArtifactComment =
        json.decodeFromString<ArtifactCommentResponse>(
            send("PATCH", "/artifacts/$id/comments/$cid", json.encodeToString(ReopenCommentRequest()))
        ).comment

    suspend fun resolveArtifactComments(id: String, commentIds: List<String>?): ResolveCommentsResponse =
        json.decodeFromString(
            send("POST", "/artifacts/$id/resolve-comments", json.encodeToString(ResolveCommentsRequest(commentIds)))
        )

    // ---- password vault ----

    suspend fun vaultStatus(): VaultStatus = json.decodeFromString(get("/vault/status"))

    suspend fun vaultSetup(password: String): VaultSetupResponse =
        json.decodeFromString(send("POST", "/vault/setup", json.encodeToString(VaultPasswordRequest(password))))

    suspend fun vaultUnlock(password: String): VaultUnlockResponse =
        json.decodeFromString(send("POST", "/vault/unlock", json.encodeToString(VaultPasswordRequest(password))))

    suspend fun vaultLock(): VaultUnlockResponse =
        json.decodeFromString(sendNoBody("POST", "/vault/lock"))

    suspend fun vaultRecover(recoveryCode: String, password: String): VaultSetupResponse =
        json.decodeFromString(
            send("POST", "/vault/recover", json.encodeToString(VaultRecoverRequest(recoveryCode, password)))
        )

    suspend fun vaultFamilySync(): VaultFamilySyncResponse =
        json.decodeFromString(sendNoBody("POST", "/vault/family/sync"))

    suspend fun listVaultEntries(): List<VaultEntry> =
        json.decodeFromString<VaultEntriesResponse>(get("/vault/entries")).entries

    suspend fun getVaultEntry(id: String): VaultEntryDetail =
        json.decodeFromString<VaultEntryDetailResponse>(get("/vault/entries/$id")).entry

    suspend fun createVaultEntry(req: CreateVaultEntryRequest): VaultEntry =
        json.decodeFromString<VaultEntryResponse>(send("POST", "/vault/entries", json.encodeToString(req))).entry

    suspend fun updateVaultEntry(id: String, req: UpdateVaultEntryRequest): VaultEntry =
        json.decodeFromString<VaultEntryResponse>(send("PATCH", "/vault/entries/$id", json.encodeToString(req))).entry

    suspend fun deleteVaultEntry(id: String) {
        sendNoBody("DELETE", "/vault/entries/$id")
    }

    suspend fun vaultTotp(id: String): VaultTotpResponse =
        json.decodeFromString(get("/vault/entries/$id/totp"))

    suspend fun vaultAccessLog(): List<VaultAccessLogEntry> =
        json.decodeFromString<VaultAccessLogResponse>(get("/vault/access-log")).entries

    /** Uploads a PDF, photo, or camera scan — the actual "scan a document" path. */
    suspend fun uploadDocument(filename: String, bytes: ByteArray, mimeType: String?): Document =
        withContext(Dispatchers.IO) {
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", filename, bytes.toRequestBody(mimeType?.toMediaTypeOrNull()))
                .build()
            val request = Request.Builder().url("$baseUrl/documents/upload").post(body).withAuth().build()
            json.decodeFromString<DocumentResponse>(execute(request)).document
        }
}
