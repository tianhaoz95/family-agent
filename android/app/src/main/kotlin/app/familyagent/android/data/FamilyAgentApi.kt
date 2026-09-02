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
import java.util.concurrent.TimeUnit

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

    suspend fun listTasks(): List<Task> = json.decodeFromString<TasksResponse>(get("/tasks")).tasks

    suspend fun createTask(title: String, dueDate: String?): Task =
        json.decodeFromString<TaskResponse>(
            send("POST", "/tasks", json.encodeToString(CreateTaskRequest(title, dueDate)))
        ).task

    suspend fun completeTask(id: String): Task =
        json.decodeFromString<TaskResponse>(
            send("PATCH", "/tasks/$id", json.encodeToString(UpdateTaskRequest("done")))
        ).task

    suspend fun listDocuments(): List<Document> = json.decodeFromString<DocumentsResponse>(get("/documents")).documents

    suspend fun ingestDocument(filename: String, text: String): Document =
        json.decodeFromString<DocumentResponse>(
            send("POST", "/documents/ingest", json.encodeToString(IngestDocumentRequest(filename, text)))
        ).document

    suspend fun deleteDocument(id: String) {
        sendNoBody("DELETE", "/documents/$id")
    }

    suspend fun retryExtraction(id: String): Document =
        json.decodeFromString<DocumentResponse>(sendNoBody("POST", "/documents/$id/retry-extraction")).document

    suspend fun listActivity(): List<ActivityEntry> = json.decodeFromString<ActivityResponse>(get("/activity")).activity

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
