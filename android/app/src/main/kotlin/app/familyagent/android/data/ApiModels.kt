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
    /** Whether the server offers text-to-speech — the "read aloud" button hides when false. */
    val ttsEnabled: Boolean = false,
    /** "on" when an embedding model is configured for semantic document search. */
    val semanticSearch: String = "off",
    /** Whether scheduled routines are available — the Routines drawer item hides when false. */
    val routinesEnabled: Boolean = true,
    /** "on" when web access (the research agent) is configured. */
    val web: String = "off",
    /** "on" when file processing works here; "unavailable" if requested but the sandbox is missing. */
    val shell: String = "off",
    /** Whether the stateless code sandbox (run_code / the /calc command) is available. */
    val compute: Boolean = true,
    /** "full" = skills + sandboxed scripts; "docs-only" = instructions only; "off". */
    val skills: String = "off",
    /** "on" = MCP enabled with ≥1 connected server; "no-servers" = enabled, none; "off". */
    val mcp: String = "off",
    /** "on" when the password vault feature is enabled — the Vault drawer item hides when "off". */
    val vault: String = "off",
    /** Whether the assistant may read the vault via the "/vault" chat command. */
    val vaultAi: Boolean = false,
    /** "on" when the assistant may answer with a generated HTML card (render_card). */
    val cards: String = "off",
    /** "on" when render_artifact + the Artifacts tab are available. */
    val artifacts: String = "off",
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

// ---- artifacts (render_artifact) ----

@Serializable
data class ArtifactSummary(
    val id: String,
    val title: String,
    val source: String? = null,
    val sourceId: String? = null,
    val revision: Int = 0,
    val canRevert: Boolean = false,
    val openComments: Int = 0,
    val createdAt: String = "",
    val updatedAt: String? = null,
)

@Serializable
data class Artifact(
    val id: String,
    val title: String,
    val source: String? = null,
    val sourceId: String? = null,
    val revision: Int = 0,
    val canRevert: Boolean = false,
    val openComments: Int = 0,
    val createdAt: String = "",
    val updatedAt: String? = null,
    /** The raw <body> fragment the model wrote. */
    val html: String = "",
    /** The full sandboxed HTML document — load into a sealed WebView. */
    val document: String = "",
)

@Serializable
data class ArtifactComment(
    val id: String,
    val artifactId: String = "",
    val userId: String = "",
    val body: String,
    val quote: String? = null,
    val prefix: String? = null,
    val suffix: String? = null,
    val status: String = "open",
    val resolution: String? = null,
    val resolvedBy: String? = null,
    val createdAt: String = "",
    val resolvedAt: String? = null,
)

@Serializable
data class CommentOutcome(val id: String, val action: String, val resolution: String)

/** The minimal comment shape the in-page runtime needs to anchor a highlight. */
@Serializable
data class ArtifactCommentAnchor(
    val id: String,
    val quote: String,
    val prefix: String,
    val suffix: String,
    val status: String,
)

@Serializable
data class ArtifactListResponse(val artifacts: List<ArtifactSummary> = emptyList())

@Serializable
data class ArtifactResponse(
    val artifact: Artifact,
    val comments: List<ArtifactComment> = emptyList(),
)

@Serializable
data class ArtifactCommentsResponse(val comments: List<ArtifactComment> = emptyList())

@Serializable
data class ArtifactCommentResponse(val comment: ArtifactComment)

@Serializable
data class ResolveCommentsResponse(
    val artifact: Artifact,
    val comments: List<ArtifactComment> = emptyList(),
    val edited: Boolean = false,
    val outcomes: List<CommentOutcome> = emptyList(),
)

@Serializable
data class ArtifactSummaryResponse(val artifact: ArtifactSummary)

@Serializable
data class RenameArtifactRequest(val title: String)

@Serializable
data class NewArtifactCommentRequest(
    val body: String,
    val quote: String? = null,
    val prefix: String? = null,
    val suffix: String? = null,
)

@Serializable
data class ResolveCommentsRequest(val commentIds: List<String>? = null)

@Serializable
data class ReopenCommentRequest(val status: String = "open")

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
    // Client-generated id for polling GET /chat/turns/:turnId for live tool-call
    // visibility while the reply is in flight.
    val turnId: String? = null,
)

@Serializable
data class ChatReference(val type: String, val id: String, val label: String)

/** One tool call the agent made during a turn — see agent-core/src/agents/steps.ts. */
@Serializable
data class ToolStep(
    val id: String,
    val tool: String,
    val subagent: String? = null,
    val phase: String = "done",
    val input: kotlinx.serialization.json.JsonElement? = null,
    val output: String? = null,
    val error: String? = null,
    val startedAt: String = "",
    val endedAt: String? = null,
    val durationMs: Long? = null,
)

/** A generated HTML card — see agent-core/src/cards/. `html` is the full sealed
 *  document for a sandboxed WebView; `fragment` is the raw snippet (for "view code"). */
@Serializable
data class Card(
    val id: String,
    val title: String,
    val html: String = "",
    val fragment: String = "",
)

@Serializable
data class ChatResponse(
    val reply: String,
    val references: List<ChatReference> = emptyList(),
    val steps: List<ToolStep> = emptyList(),
    val cards: List<Card> = emptyList(),
    val sessionId: String,
)

// ---- server settings (machine-wide, from GET/PUT /settings) ----

@Serializable
data class ServerSettings(
    val serverName: String = "",
    val cardsEnabled: Boolean = true,
    val vaultEnabled: Boolean = false,
    // Whether the desktop app installs a found update on its own instead of
    // waiting to be asked. Only meaningful to the desktop's own frontend —
    // shown here purely so an admin can see/change it from any client.
    val autoUpdateEnabled: Boolean = false,
    // Internet access (research agent). webSearchApiKey is never sent back.
    val webEnabled: Boolean = false,
    val webSearchProvider: String = "none",
    val webSearchUrl: String = "",
    val webSearchApiKeySet: Boolean = false,
    val isAdmin: Boolean = false,
    val envLocked: EnvLocked = EnvLocked(),
)

@Serializable
data class EnvLocked(
    val cardsEnabled: Boolean = false,
    val vaultEnabled: Boolean = false,
    val autoUpdateEnabled: Boolean = false,
    val webSearchProvider: Boolean = false,
)

// ---- remote update-and-restart of the host desktop app ----

@Serializable
data class DesktopUpdateStatus(
    // idle | requested | checking | no-update | downloading | installing | restarting | error
    val state: String = "idle",
    val message: String? = null,
    val percent: Double? = null,
    val requestedAt: String? = null,
    val requestedBy: String? = null,
)

@Serializable
data class UpdateSettingsRequest(
    val cardsEnabled: Boolean? = null,
    val vaultEnabled: Boolean? = null,
    val autoUpdateEnabled: Boolean? = null,
    val webSearchProvider: String? = null,
    val webSearchUrl: String? = null,
    val webSearchApiKey: String? = null,
)

@Serializable
data class TurnStepsResponse(val steps: List<ToolStep> = emptyList(), val done: Boolean = false)

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
    val steps: List<ToolStep> = emptyList(),
    val cards: List<Card> = emptyList(),
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
data class SpeakRequest(val text: String, val voice: String? = null)

@Serializable
data class TtsVoicesResponse(val voices: List<String> = emptyList(), val current: String = "")

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
    /** Tool calls the assistant made for this reply (agent messages). */
    val steps: List<ToolStep> = emptyList(),
    /** Generated HTML cards attached to this reply (agent messages). */
    val cards: List<Card> = emptyList(),
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

// ---- scheduled routines ----
// The server's RoutineTrigger is a discriminated union {kind: cron|once|every, …};
// modelled flat here (only the field for `kind` is populated) rather than as a
// sealed class, the same pragmatic choice as `Extracted`.
@Serializable
data class RoutineTrigger(
    val kind: String,
    val expr: String? = null,
    val at: String? = null,
    val minutes: Int? = null,
)

@Serializable
data class RoutineAction(
    /** planner | task | document | notes | tools — never "builder". */
    val agent: String = "planner",
    val instruction: String,
)

/** Friendly schedule fields for POST/PATCH /routines — exactly one is set. */
@Serializable
data class RoutineTriggerInput(
    val cron: String? = null,
    val dailyAt: String? = null,
    val weeklyOn: String? = null,
    val weeklyAt: String? = null,
    val monthlyDay: Int? = null,
    val monthlyAt: String? = null,
    val onceAt: String? = null,
    val everyMinutes: Int? = null,
)

@Serializable
data class Routine(
    val id: String,
    val name: String,
    val enabled: Boolean,
    val trigger: RoutineTrigger,
    /** Human sentence for the schedule, e.g. "every day at 7:00 AM". */
    val triggerText: String = "",
    val action: RoutineAction,
    val deliverChannelId: String? = null,
    val catchUp: String = "skip",
    val nextRunAt: String? = null,
    val lastRunAt: String? = null,
    val lastStatus: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class RoutineRun(
    val id: String,
    val routineId: String,
    val startedAt: String,
    val finishedAt: String? = null,
    val status: String,
    val trigger: String = "schedule",
    val output: String? = null,
    val error: String? = null,
)

/** Create / full-edit payload. `deliverChannelId` has no default so an explicit
 *  `null` is sent — the server reads that as "clear the delivery target". */
@Serializable
data class RoutineInput(
    val name: String,
    val trigger: RoutineTriggerInput,
    val action: RoutineAction,
    val deliverChannelId: String?,
)

/** No default so `enabled` is always serialized (pause / resume). */
@Serializable
data class SetRoutineEnabledRequest(val enabled: Boolean)

@Serializable
data class RoutinesResponse(val routines: List<Routine>)

@Serializable
data class RoutineResponse(val routine: Routine)

@Serializable
data class RoutineRunsResponse(val runs: List<RoutineRun>)

@Serializable
data class RunRoutineResponse(
    val status: String,
    val output: String? = null,
    val error: String? = null,
    val run: RoutineRun? = null,
)

// ---- skills ----

@Serializable
data class Skill(
    val name: String,
    val description: String = "",
    val whenToUse: String? = null,
    val enabled: Boolean = true,
    val scripts: List<String> = emptyList(),
    val updatedAt: String = "",
    /** Only present from GET /skills/:name. */
    val body: String? = null,
)

@Serializable
data class SkillsResponse(val skills: List<Skill>, val scriptsRunnable: Boolean = false)

@Serializable
data class SkillResponse(val skill: Skill)

@Serializable
data class SaveSkillRequest(
    val name: String,
    val description: String? = null,
    val whenToUse: String? = null,
    val enabled: Boolean = true,
    val markdown: String,
)

@Serializable
data class SetSkillEnabledRequest(val enabled: Boolean)

@Serializable
data class DraftSkillRequest(val name: String, val description: String)

@Serializable
data class DraftSkillResponse(val markdown: String)

// ---- MCP connections ----

@Serializable
data class McpServer(
    val name: String,
    val transport: String = "http",
    val enabled: Boolean = true,
    val url: String? = null,
    val headers: Map<String, String>? = null,
    val command: String? = null,
    val args: List<String>? = null,
    val env: Map<String, String>? = null,
    val allowHosts: List<String>? = null,
    val scope: String? = null,
    val note: String? = null,
)

@Serializable
data class McpServersResponse(val servers: List<McpServer>)

@Serializable
data class McpProbeResult(
    val ok: Boolean = false,
    val toolCount: Int? = null,
    val error: String? = null,
)

@Serializable
data class SaveMcpServerResponse(val server: McpServer, val probe: McpProbeResult = McpProbeResult())

@Serializable
data class McpToolInfo(val server: String, val name: String, val description: String = "")

@Serializable
data class McpToolsResponse(val tools: List<McpToolInfo> = emptyList())

// ---- password vault ----

@Serializable
data class VaultStatus(
    val enabled: Boolean = false,
    val aiEnabled: Boolean = false,
    val exists: Boolean = false,
    val unlocked: Boolean = false,
    val hasRecovery: Boolean = false,
    val hasSharedAccess: Boolean = false,
    val familyVaultInitialised: Boolean = false,
    val entryCount: Int = 0,
)

@Serializable
data class VaultEntry(
    val id: String,
    val userId: String = "",
    val scope: String = "private",
    val folder: String? = null,
    val title: String,
    val username: String? = null,
    val url: String? = null,
    val hasTotp: Boolean = false,
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class VaultTotpConfig(
    val secret: String = "",
    val digits: Int = 6,
    val period: Int = 30,
    val algorithm: String = "SHA1",
    val issuer: String? = null,
)

@Serializable
data class VaultCustomField(val label: String, val value: String, val secret: Boolean = false)

@Serializable
data class VaultSecret(
    val password: String? = null,
    val totp: VaultTotpConfig? = null,
    val notes: String? = null,
    val fields: List<VaultCustomField> = emptyList(),
)

@Serializable
data class VaultEntryDetail(
    val id: String,
    val userId: String = "",
    val scope: String = "private",
    val folder: String? = null,
    val title: String,
    val username: String? = null,
    val url: String? = null,
    val hasTotp: Boolean = false,
    val createdAt: String = "",
    val updatedAt: String = "",
    val secret: VaultSecret = VaultSecret(),
)

@Serializable
data class VaultAccessLogEntry(
    val id: String,
    val entryId: String? = null,
    val entryTitle: String,
    val actor: String,
    val action: String,
    val at: String,
)

@Serializable
data class VaultEntriesResponse(val entries: List<VaultEntry> = emptyList())

@Serializable
data class VaultEntryResponse(val entry: VaultEntry)

@Serializable
data class VaultEntryDetailResponse(val entry: VaultEntryDetail)

@Serializable
data class VaultAccessLogResponse(val entries: List<VaultAccessLogEntry> = emptyList())

@Serializable
data class VaultPasswordRequest(val password: String)

@Serializable
data class VaultRecoverRequest(val recoveryCode: String, val password: String)

@Serializable
data class VaultSetupResponse(
    val ok: Boolean = true,
    val recoveryCode: String = "",
    val status: VaultStatus = VaultStatus(),
)

@Serializable
data class VaultUnlockResponse(val ok: Boolean = true, val status: VaultStatus = VaultStatus())

@Serializable
data class VaultFamilySyncResponse(val ok: Boolean = true, val granted: Int = 0)

@Serializable
data class VaultTotpResponse(val code: String, val expiresInSeconds: Int)

@Serializable
data class CreateVaultEntryRequest(
    val scope: String,
    val title: String,
    val folder: String? = null,
    val username: String? = null,
    val url: String? = null,
    val password: String? = null,
    val totpInput: String? = null,
    val notes: String? = null,
)

@Serializable
data class UpdateVaultEntryRequest(
    val title: String? = null,
    val folder: String? = null,
    val username: String? = null,
    val url: String? = null,
    val password: String? = null,
    val totpInput: String? = null,
    val clearTotp: Boolean? = null,
    val notes: String? = null,
)
