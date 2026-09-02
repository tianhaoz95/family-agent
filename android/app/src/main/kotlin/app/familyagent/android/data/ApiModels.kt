package app.familyagent.android.data

import kotlinx.serialization.Serializable

@Serializable
data class Task(
    val id: String,
    val title: String,
    val notes: String? = null,
    val dueDate: String? = null,
    /** 24-hour "HH:MM" when the task has a specific time; null = all-day. */
    val dueTime: String? = null,
    val status: String,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class Extracted(
    val summary: String? = null,
    val category: String? = null,
    val importantDates: List<String>? = null,
)

@Serializable
data class Document(
    val id: String,
    val filename: String,
    val rawText: String,
    val extracted: Extracted? = null,
    val createdAt: String,
    val sourcePath: String? = null,
    /** "pending" while extraction runs, "done" once fields are saved, "failed" after retries are exhausted. */
    val extractionStatus: String = "pending",
)

/** One hit from GET /documents/search — a list row plus a match snippet. */
@Serializable
data class DocumentSearchHit(
    val id: String,
    val filename: String,
    val category: String? = null,
    val summary: String? = null,
    val snippet: String = "",
    val createdAt: String,
    val extractionStatus: String = "pending",
)

/** One hit from GET /tasks/search. */
@Serializable
data class TaskSearchHit(
    val id: String,
    val title: String,
    val notes: String? = null,
    val dueDate: String? = null,
    val dueTime: String? = null,
    val status: String,
    val snippet: String = "",
)

@Serializable
data class DocumentSearchResponse(val results: List<DocumentSearchHit>)

@Serializable
data class TaskSearchResponse(val results: List<TaskSearchHit>)

@Serializable
data class ActivityEntry(
    val id: String,
    val ts: String,
    val actor: String,
    val action: String,
    val detail: String,
)

@Serializable
data class HealthResponse(
    val ok: Boolean,
    val model: String,
    val ollamaBaseUrl: String = "",
    val serverName: String = "Family Agent",
    val needsSetup: Boolean = false,
    val toolsPort: Int = 4174,
    val toolsEnabled: String = "off",
    /** Whether the server offers speech-to-text — the chat mic button hides when false. */
    val asrEnabled: Boolean = false,
)

@Serializable
data class User(
    val id: String,
    val username: String,
    val displayName: String,
    val role: String,
)

@Serializable
data class AuthStatusResponse(val needsSetup: Boolean, val serverName: String = "Family Agent")

@Serializable
data class LoginRequest(
    val username: String,
    val password: String,
    val deviceLabel: String? = null,
)

@Serializable
data class LoginResponse(val token: String, val user: User)

@Serializable
data class MeResponse(val user: User)

@Serializable
data class Tool(
    val id: String,
    val name: String,
    val description: String,
    val kind: String,
    val status: String,
    val error: String? = null,
    val createdAt: String,
    val path: String? = null,
)

@Serializable
data class ToolsResponse(val tools: List<Tool>)

@Serializable
data class BuildToolRequest(val prompt: String)

@Serializable
data class ChatRequest(
    val message: String,
    // Data URIs (data:image/jpeg;base64,…). Json is configured with
    // encodeDefaults=false, so an empty list is simply omitted from the body.
    val images: List<String> = emptyList(),
)

@Serializable
data class ChatResponse(val reply: String)

@Serializable
data class TranscribeResponse(val text: String)

@Serializable
data class TasksResponse(val tasks: List<Task>)

@Serializable
data class TaskResponse(val task: Task)

@Serializable
data class DocumentsResponse(val documents: List<Document>)

@Serializable
data class DocumentResponse(val document: Document)

@Serializable
data class ActivityResponse(val activity: List<ActivityEntry>)

@Serializable
data class CreateTaskRequest(
    val title: String,
    val dueDate: String? = null,
    val dueTime: String? = null,
)

@Serializable
data class UpdateTaskRequest(val status: String)

/** No defaults so `null` is serialized explicitly — the server reads an explicit
 *  `null` as "clear this field". Clearing dueDate also clears dueTime server-side. */
@Serializable
data class RescheduleTaskRequest(val dueDate: String?, val dueTime: String?)

@Serializable
data class IngestDocumentRequest(val filename: String, val text: String)
