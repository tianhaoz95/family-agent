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
    /** MIME of the stored original file (uploads), for the preview. null = none / not recorded. */
    val originalMime: String? = null,
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
    /** "on" when an embedding model is configured for semantic document search. */
    val semanticSearch: String = "off",
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
    // The persisted chat session to continue; null starts (server-side, lazily) a new one.
    val sessionId: String? = null,
)

@Serializable
data class ChatReference(val type: String, val id: String, val label: String)

@Serializable
data class ChatResponse(val reply: String, val references: List<ChatReference> = emptyList(), val sessionId: String)

// ---- chat history sessions (private 1:1 assistant chat) ----

@Serializable
data class ChatSession(
    val id: String,
    val title: String,
    val createdAt: String,
    val updatedAt: String,
    val lastMessage: String? = null,
    val messageCount: Int = 0,
)

@Serializable
data class ChatSessionMessage(
    val id: String,
    val role: String,
    val body: String,
    val images: List<String> = emptyList(),
    val refs: List<ChatReference> = emptyList(),
    val createdAt: String,
)

@Serializable
data class ChatSessionsResponse(val sessions: List<ChatSession>)

@Serializable
data class ChatSessionMessagesResponse(val messages: List<ChatSessionMessage>)

@Serializable
data class ChatSessionResponse(val session: ChatSession)

@Serializable
data class RenameChatSessionRequest(val title: String)

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

@Serializable
data class RenameDocumentRequest(val filename: String, val by: String = "user")

@Serializable
data class NameSuggestion(val filename: String)

@Serializable
data class SuggestNameResponse(val suggestion: NameSuggestion, val current: String)

// ---- family chat ----

/** senderId of an assistant message (mirrors AGENT_SENDER_ID server-side). */
const val AGENT_SENDER_ID = "_agent_"

@Serializable
data class FamilyMember(val id: String, val username: String, val displayName: String)

@Serializable
data class FamilyMembersResponse(val members: List<FamilyMember>)

@Serializable
data class ChannelMember(val id: String, val username: String, val displayName: String)

@Serializable
data class ChannelLastMessage(
    val senderId: String,
    val body: String,
    val createdAt: String,
    val pending: Boolean = false,
)

@Serializable
data class Channel(
    val id: String,
    val kind: String,
    val name: String? = null,
    val createdBy: String,
    val createdAt: String,
    val members: List<ChannelMember> = emptyList(),
    val title: String = "",
    val lastMessage: ChannelLastMessage? = null,
    val unreadCount: Int = 0,
)

@Serializable
data class Message(
    val id: String,
    val channelId: String,
    val senderId: String,
    val body: String,
    /** Image attachments as data URIs — same as the 1:1 chat composer. */
    val images: List<String> = emptyList(),
    val pending: Boolean = false,
    val createdAt: String,
)

@Serializable
data class ChannelsResponse(val channels: List<Channel>)

@Serializable
data class ChannelResponse(val channel: Channel)

@Serializable
data class MessagesResponse(val messages: List<Message>)

@Serializable
data class MessageResponse(val message: Message)

@Serializable
data class CreateChannelRequest(
    val kind: String,
    val memberIds: List<String>,
    val name: String? = null,
)

@Serializable
data class PostMessageRequest(
    val body: String,
    val mentionAgent: Boolean = false,
    val images: List<String> = emptyList(),
)

@Serializable
data class MarkReadRequest(val ts: String)

// ---- sticky notes ----

@Serializable
data class StickyNote(
    val id: String,
    val scope: String,
    val userId: String,
    val text: String,
    val color: String = "butter",
    /** Position on the corkboard, in dp from its top-left. */
    val x: Float = 0f,
    val y: Float = 0f,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class NotesResponse(val notes: List<StickyNote>)

@Serializable
data class NoteResponse(val note: StickyNote)

@Serializable
data class CreateNoteRequest(
    val scope: String,
    val text: String,
    val color: String? = null,
    val x: Float? = null,
    val y: Float? = null,
)

@Serializable
data class UpdateNoteRequest(
    val text: String? = null,
    val color: String? = null,
    val x: Float? = null,
    val y: Float? = null,
)
