package app.familyagent.android.data

import kotlinx.serialization.Serializable

@Serializable
data class Task(
    val id: String,
    val title: String,
    val notes: String? = null,
    val dueDate: String? = null,
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
    val ollamaBaseUrl: String,
    val toolsPort: Int = 4174,
    val toolsEnabled: String = "off",
)

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
data class CreateTaskRequest(val title: String, val dueDate: String? = null)

@Serializable
data class UpdateTaskRequest(val status: String)

@Serializable
data class IngestDocumentRequest(val filename: String, val text: String)
