package app.familyagent.android.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Thrown for any non-2xx response or transport failure, with a message safe to show the user. */
class ApiException(message: String) : IOException(message)

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
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build(),
) {
    fun updateBaseUrl(url: String) {
        baseUrl = url.trimEnd('/')
    }

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("$baseUrl$path").get().build()
        execute(request)
    }

    private suspend fun send(method: String, path: String, body: String): String = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .method(method, body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        execute(request)
    }

    private fun execute(request: Request): String {
        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    val detail = runCatching { json.parseToJsonElement(text) }.getOrNull()
                    throw ApiException("${request.url.encodedPath}: HTTP ${response.code}${detail?.let { " — $it" } ?: ""}")
                }
                return text
            }
        } catch (e: IOException) {
            if (e is ApiException) throw e
            throw ApiException("Could not reach $baseUrl — is the desktop app running? (${e.message})")
        }
    }

    suspend fun health(): HealthResponse = json.decodeFromString(get("/health"))

    suspend fun chat(message: String): ChatResponse =
        json.decodeFromString(send("POST", "/chat", json.encodeToString(ChatRequest(message))))

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

    suspend fun listActivity(): List<ActivityEntry> = json.decodeFromString<ActivityResponse>(get("/activity")).activity
}
