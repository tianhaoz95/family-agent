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

    suspend fun chat(message: String, images: List<String> = emptyList()): ChatResponse =
        json.decodeFromString(send("POST", "/chat", json.encodeToString(ChatRequest(message, images))))

    /** Upload a recorded voice clip (16 kHz mono WAV) and get back the transcript. */
    suspend fun transcribe(wav: ByteArray): TranscribeResponse = withContext(Dispatchers.IO) {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("audio", "voice.wav", wav.toRequestBody("audio/wav".toMediaTypeOrNull()))
            .build()
        val request = Request.Builder().url("$baseUrl/transcribe").post(body).withAuth().build()
        json.decodeFromString(execute(request))
    }

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

    suspend fun listTools(): List<Tool> = json.decodeFromString<ToolsResponse>(get("/tools")).tools

    suspend fun buildTool(prompt: String) {
        send("POST", "/tools", json.encodeToString(BuildToolRequest(prompt)))
    }

    suspend fun deleteTool(id: String) {
        sendNoBody("DELETE", "/tools/$id")
    }

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
