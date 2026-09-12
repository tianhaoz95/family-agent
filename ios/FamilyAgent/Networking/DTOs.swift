import Foundation

// The HTTP contract, mirrored from `android/.../data/ApiModels.kt` 1:1. The
// server speaks camelCase, so there are no CodingKeys and no keyDecodingStrategy.
// All value types → Sendable is free. Unknown keys are ignored automatically.

// MARK: - Tasks / Events

struct TaskItem: Codable, Sendable, Identifiable, Hashable {
    let id: String
    var title: String
    var notes: String?
    var dueDate: String?
    /// 24-hour "HH:MM" when the task has a specific time; nil = all-day.
    var dueTime: String?
    var status: String
    var createdAt: String
    var updatedAt: String
}

struct Extracted: Codable, Sendable, Hashable {
    var summary: String?
    var category: String?
    var importantDates: [String]?
}

struct Document: Codable, Sendable, Identifiable, Hashable {
    let id: String
    var filename: String
    var rawText: String
    var extracted: Extracted?
    var createdAt: String
    var sourcePath: String?
    var originalMime: String?
    var extractionStatus: String = "pending"
}

struct DocumentSearchHit: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let filename: String
    var category: String?
    var summary: String?
    var snippet: String = ""
    let createdAt: String
    var extractionStatus: String = "pending"
}

struct TaskSearchHit: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let title: String
    var notes: String?
    var dueDate: String?
    var dueTime: String?
    let status: String
    var snippet: String = ""
}

struct ActivityEntry: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let ts: String
    let actor: String
    let action: String
    let detail: String
}

// MARK: - Health / auth

struct HealthResponse: Codable, Sendable {
    var ok: Bool
    var model: String = ""
    var ollamaBaseUrl: String = ""
    var serverName: String = "Family Agent"
    var needsSetup: Bool = false
    var toolsPort: Int = 4174
    var toolsEnabled: String = "off"
    var asrEnabled: Bool = false
    var ttsEnabled: Bool = false
    var semanticSearch: String = "off"
    var routinesEnabled: Bool = true
    var web: String = "off"
    var shell: String = "off"
    var compute: Bool = true
    var skills: String = "off"
    var mcp: String = "off"
    var vault: String = "off"
    var vaultAi: Bool = false
    var cards: String = "off"
    var artifacts: String = "off"
}

// MARK: - Artifacts (render_artifact)

struct ArtifactSummary: Codable, Sendable, Hashable, Identifiable {
    let id: String
    let title: String
    var source: String? = nil
    var sourceId: String? = nil
    var revision: Int = 0
    var canRevert: Bool = false
    var openComments: Int = 0
    var createdAt: String = ""
    var updatedAt: String? = nil
}

struct Artifact: Codable, Sendable, Hashable, Identifiable {
    let id: String
    let title: String
    var source: String? = nil
    var sourceId: String? = nil
    var revision: Int = 0
    var canRevert: Bool = false
    var createdAt: String = ""
    var updatedAt: String? = nil
    /// The raw <body> fragment the model wrote (for "view source").
    var html: String = ""
    /// The full sandboxed HTML document — load into a sealed WKWebView.
    var document: String = ""
}

struct ArtifactComment: Codable, Sendable, Hashable, Identifiable {
    let id: String
    var artifactId: String = ""
    var userId: String = ""
    var body: String
    var quote: String? = nil
    var prefix: String? = nil
    var suffix: String? = nil
    var status: String = "open"
    var resolution: String? = nil
    var resolvedBy: String? = nil
    var createdAt: String = ""
    var resolvedAt: String? = nil
}

struct CommentOutcome: Codable, Sendable, Hashable {
    let id: String
    let action: String
    let resolution: String
}

struct ArtifactListResponse: Codable, Sendable { var artifacts: [ArtifactSummary] = [] }
struct ArtifactResponse: Codable, Sendable {
    let artifact: Artifact
    var comments: [ArtifactComment] = []
}
struct ArtifactCommentsResponse: Codable, Sendable { var comments: [ArtifactComment] = [] }
struct ArtifactCommentResponse: Codable, Sendable { let comment: ArtifactComment }
struct ResolveCommentsResponse: Codable, Sendable {
    let artifact: Artifact
    var comments: [ArtifactComment] = []
    var edited: Bool = false
    var outcomes: [CommentOutcome] = []
}
struct ArtifactSummaryResponse: Codable, Sendable { let artifact: ArtifactSummary }

struct NewArtifactCommentRequest: Codable, Sendable {
    let body: String
    var quote: String? = nil
    var prefix: String? = nil
    var suffix: String? = nil
}

struct User: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let username: String
    let displayName: String
    let role: String
}

struct AuthStatusResponse: Codable, Sendable {
    let needsSetup: Bool
    var serverName: String = "Family Agent"
}

struct LoginRequest: Codable, Sendable {
    let username: String
    let password: String
    var deviceLabel: String? = nil
}

struct LoginResponse: Codable, Sendable {
    let token: String
    let user: User
}

/// Body for `POST /auth/pair/redeem` — the token lifted out of a pairing QR.
struct PairRedeemRequest: Codable, Sendable {
    let token: String
    var deviceLabel: String? = "ios"
}

struct MeResponse: Codable, Sendable { let user: User }

// MARK: - Family member management (admin, /users — mirrors desktop's #view-family)

struct ListUsersResponse: Codable, Sendable { let users: [User] }
struct CreateUserRequest: Codable, Sendable {
    let username: String
    let displayName: String
    let password: String
    let role: String
}
struct CreateUserResponse: Codable, Sendable { let user: User }
/// All fields optional — JSONEncoder omits a nil Optional automatically, so
/// only the fields actually being changed are sent.
struct UpdateUserRequest: Codable, Sendable {
    var displayName: String? = nil
    var password: String? = nil
    var role: String? = nil
}
struct UpdateUserResponse: Codable, Sendable { let user: User }

struct BootstrapRequest: Codable, Sendable {
    var serverName: String?
    let username: String
    let displayName: String
    let password: String
}

// MARK: - Tools

struct Tool: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String
    let kind: String
    let status: String
    var error: String?
    let createdAt: String
    var path: String?
}
struct ToolsResponse: Codable, Sendable { let tools: [Tool] }
struct BuildToolRequest: Codable, Sendable { let prompt: String }

// MARK: - Chat

struct ChatRequest: Codable, Sendable {
    let message: String
    var images: [String] = []
    var sessionId: String? = nil
    var turnId: String? = nil
}

struct ChatReference: Codable, Sendable, Hashable, Identifiable {
    let type: String
    let id: String
    let label: String
}

struct ToolStep: Codable, Sendable, Hashable, Identifiable {
    let id: String
    let tool: String
    var subagent: String?
    var phase: String = "done"
    var input: JSONValue?
    var output: String?
    var error: String?
    var startedAt: String = ""
    var endedAt: String?
    var durationMs: Double?
}

struct Card: Codable, Sendable, Hashable, Identifiable {
    let id: String
    let title: String
    var html: String = ""
    var fragment: String = ""
}

struct ChatResponse: Codable, Sendable {
    let reply: String
    var references: [ChatReference] = []
    var steps: [ToolStep] = []
    var cards: [Card] = []
    let sessionId: String
}

// MARK: - Server settings

struct ServerSettings: Codable, Sendable {
    var serverName: String = ""
    var cardsEnabled: Bool = true
    var vaultEnabled: Bool = false
    /// Whether the desktop app installs a found update on its own instead of
    /// waiting to be asked. Only meaningful to the desktop's own frontend —
    /// shown here purely so an admin can see/change it from any client.
    var autoUpdateEnabled: Bool = false
    // Internet access (research agent). webSearchApiKey is never sent back.
    var webEnabled: Bool = false
    var webSearchProvider: String = "none"
    var webSearchUrl: String = ""
    var webSearchApiKeySet: Bool = false
    var isAdmin: Bool = false
    var envLocked: EnvLocked = EnvLocked()
}
struct EnvLocked: Codable, Sendable {
    var cardsEnabled: Bool = false
    var vaultEnabled: Bool = false
    var autoUpdateEnabled: Bool = false
    var webSearchProvider: Bool = false
}
// MARK: - Remote update-and-restart of the host desktop app

struct DesktopUpdateStatus: Codable, Sendable, Equatable {
    var state: String = "idle" // idle | requested | checking | no-update | downloading | installing | restarting | error
    var message: String? = nil
    var percent: Double? = nil
    var requestedAt: String? = nil
    var requestedBy: String? = nil
}
struct UpdateReportRequest: Codable, Sendable {
    var state: String
    var message: String? = nil
    var percent: Double? = nil
}

struct UpdateSettingsRequest: Codable, Sendable {
    var cardsEnabled: Bool? = nil
    var vaultEnabled: Bool? = nil
    var autoUpdateEnabled: Bool? = nil
    var webSearchProvider: String? = nil
    var webSearchUrl: String? = nil
    var webSearchApiKey: String? = nil
}

struct TurnStepsResponse: Codable, Sendable {
    var steps: [ToolStep] = []
    var done: Bool = false
}

// MARK: - Chat history sessions

struct ChatSession: Codable, Sendable, Identifiable, Hashable {
    let id: String
    var title: String
    let createdAt: String
    var updatedAt: String
    var lastMessage: String?
    var messageCount: Int = 0
}

struct ChatSessionMessage: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let role: String
    let body: String
    var images: [String] = []
    var refs: [ChatReference] = []
    var steps: [ToolStep] = []
    var cards: [Card] = []
    let createdAt: String
}

struct RenameChatSessionRequest: Codable, Sendable { let title: String }
struct TranscribeResponse: Codable, Sendable { let text: String }
struct SpeakRequest: Codable, Sendable { let text: String; var voice: String? = nil }
struct TtsVoicesResponse: Codable, Sendable { var voices: [String] = []; var current: String = "" }

// MARK: - TaskItem requests

struct CreateTaskRequest: Codable, Sendable {
    let title: String
    var dueDate: String? = nil
    var dueTime: String? = nil
}
struct UpdateTaskStatusRequest: Codable, Sendable { let status: String }

/// Explicit-null payload — the server reads a literal `null` as "clear this field".
struct RescheduleTaskRequest: Codable, Sendable {
    let dueDate: String?
    let dueTime: String?
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(dueDate, forKey: .dueDate)
        try c.encode(dueTime, forKey: .dueTime)
    }
    enum CodingKeys: String, CodingKey { case dueDate, dueTime }
}

struct IngestDocumentRequest: Codable, Sendable { let filename: String; let text: String }
struct RenameDocumentRequest: Codable, Sendable { let filename: String; var by: String = "user" }
struct NameSuggestion: Codable, Sendable { let filename: String }
struct SuggestNameResponse: Codable, Sendable { let suggestion: NameSuggestion; let current: String }

// MARK: - Family chat

let AGENT_SENDER_ID = "_agent_"

struct FamilyMember: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let username: String
    let displayName: String
}

struct ChannelMember: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let username: String
    let displayName: String
}

struct ChannelLastMessage: Codable, Sendable, Hashable {
    let senderId: String
    let body: String
    let createdAt: String
    var pending: Bool = false
}

struct Channel: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let kind: String
    var name: String?
    let createdBy: String
    let createdAt: String
    var members: [ChannelMember] = []
    var title: String = ""
    var lastMessage: ChannelLastMessage?
    var unreadCount: Int = 0
}

struct Message: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let channelId: String
    let senderId: String
    let body: String
    var images: [String] = []
    var steps: [ToolStep] = []
    var cards: [Card] = []
    var pending: Bool = false
    let createdAt: String
}

struct CreateChannelRequest: Codable, Sendable {
    let kind: String
    let memberIds: [String]
    var name: String? = nil
}
struct PostMessageRequest: Codable, Sendable {
    let body: String
    var mentionAgent: Bool = false
    var images: [String] = []
}
struct MarkReadRequest: Codable, Sendable { let ts: String }

// MARK: - Sticky notes

struct StickyNote: Codable, Sendable, Identifiable, Hashable {
    let id: String
    var scope: String
    var userId: String
    var text: String
    var color: String = "butter"
    var x: Double = 0
    var y: Double = 0
    let createdAt: String
    var updatedAt: String
}

struct CreateNoteRequest: Codable, Sendable {
    let scope: String
    let text: String
    var color: String? = nil
    var x: Double? = nil
    var y: Double? = nil
}
struct UpdateNoteRequest: Codable, Sendable {
    var text: String? = nil
    var color: String? = nil
    var x: Double? = nil
    var y: Double? = nil
}

// MARK: - Routines

struct RoutineTrigger: Codable, Sendable, Hashable {
    let kind: String
    var expr: String?
    var at: String?
    var minutes: Int?
}

struct RoutineAction: Codable, Sendable, Hashable {
    var agent: String = "planner"
    var instruction: String
}

struct RoutineTriggerInput: Codable, Sendable, Hashable {
    var cron: String? = nil
    var dailyAt: String? = nil
    var weeklyOn: String? = nil
    var weeklyAt: String? = nil
    var monthlyDay: Int? = nil
    var monthlyAt: String? = nil
    var onceAt: String? = nil
    var everyMinutes: Int? = nil
}

struct Routine: Codable, Sendable, Identifiable, Hashable {
    let id: String
    var name: String
    var enabled: Bool
    var trigger: RoutineTrigger
    var triggerText: String = ""
    var action: RoutineAction
    var deliverChannelId: String?
    var catchUp: String = "skip"
    var nextRunAt: String?
    var lastRunAt: String?
    var lastStatus: String?
    let createdAt: String
    var updatedAt: String
}

struct RoutineRun: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let routineId: String
    let startedAt: String
    var finishedAt: String?
    let status: String
    var trigger: String = "schedule"
    var output: String?
    var error: String?
}

/// Explicit-null `deliverChannelId` — "clear the delivery target".
struct RoutineInput: Codable, Sendable {
    let name: String
    let trigger: RoutineTriggerInput
    let action: RoutineAction
    let deliverChannelId: String?
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(trigger, forKey: .trigger)
        try c.encode(action, forKey: .action)
        try c.encode(deliverChannelId, forKey: .deliverChannelId)
    }
    enum CodingKeys: String, CodingKey { case name, trigger, action, deliverChannelId }
}

struct SetRoutineEnabledRequest: Codable, Sendable { let enabled: Bool }

struct RunRoutineResponse: Codable, Sendable {
    let status: String
    var output: String?
    var error: String?
    var run: RoutineRun?
}

// MARK: - Skills

struct Skill: Codable, Sendable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    var description: String = ""
    var whenToUse: String?
    var enabled: Bool = true
    var scripts: [String] = []
    var updatedAt: String = ""
    var body: String?
}
struct SkillsResponse: Codable, Sendable { let skills: [Skill]; var scriptsRunnable: Bool = false }
struct SaveSkillRequest: Codable, Sendable {
    let name: String
    var description: String? = nil
    var whenToUse: String? = nil
    var enabled: Bool = true
    let markdown: String
}
struct SetEnabledRequest: Codable, Sendable { let enabled: Bool }
struct DraftSkillRequest: Codable, Sendable { let name: String; let description: String }
struct DraftSkillResponse: Codable, Sendable { let markdown: String }

// MARK: - MCP connections

struct McpServer: Codable, Sendable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    var transport: String = "http"
    var enabled: Bool = true
    var url: String?
    var headers: [String: String]?
    var command: String?
    var args: [String]?
    var env: [String: String]?
    var allowHosts: [String]?
    var scope: String?
    var note: String?
}
struct McpProbeResult: Codable, Sendable {
    var ok: Bool = false
    var toolCount: Int?
    var error: String?
}
struct SaveMcpServerResponse: Codable, Sendable {
    let server: McpServer
    var probe: McpProbeResult = McpProbeResult()
}
struct McpToolInfo: Codable, Sendable, Identifiable, Hashable {
    var id: String { "\(server)/\(name)" }
    let server: String
    let name: String
    var description: String = ""
}
struct McpToolsResponse: Codable, Sendable { var tools: [McpToolInfo] = [] }

// MARK: - Vault

struct VaultStatus: Codable, Sendable, Hashable {
    var enabled: Bool = false
    var aiEnabled: Bool = false
    var exists: Bool = false
    var unlocked: Bool = false
    var hasRecovery: Bool = false
    var hasSharedAccess: Bool = false
    var familyVaultInitialised: Bool = false
    var entryCount: Int = 0
}

struct VaultEntry: Codable, Sendable, Identifiable, Hashable {
    let id: String
    var userId: String = ""
    var scope: String = "private"
    var folder: String?
    var title: String
    var username: String?
    var url: String?
    var hasTotp: Bool = false
    var createdAt: String = ""
    var updatedAt: String = ""
}

struct VaultTotpConfig: Codable, Sendable, Hashable {
    var secret: String = ""
    var digits: Int = 6
    var period: Int = 30
    var algorithm: String = "SHA1"
    var issuer: String?
}
struct VaultCustomField: Codable, Sendable, Hashable {
    let label: String
    let value: String
    var secret: Bool = false
}
struct VaultSecret: Codable, Sendable, Hashable {
    var password: String?
    var totp: VaultTotpConfig?
    var notes: String?
    var fields: [VaultCustomField] = []
}
struct VaultEntryDetail: Codable, Sendable, Identifiable, Hashable {
    let id: String
    var userId: String = ""
    var scope: String = "private"
    var folder: String?
    var title: String
    var username: String?
    var url: String?
    var hasTotp: Bool = false
    var createdAt: String = ""
    var updatedAt: String = ""
    var secret: VaultSecret = VaultSecret()
}
struct VaultAccessLogEntry: Codable, Sendable, Identifiable, Hashable {
    let id: String
    var entryId: String?
    let entryTitle: String
    let actor: String
    let action: String
    let at: String
}
struct VaultPasswordRequest: Codable, Sendable { let password: String }
struct VaultRecoverRequest: Codable, Sendable { let recoveryCode: String; let password: String }
struct VaultSetupResponse: Codable, Sendable {
    var ok: Bool = true
    var recoveryCode: String = ""
    var status: VaultStatus = VaultStatus()
}
struct VaultUnlockResponse: Codable, Sendable {
    var ok: Bool = true
    var status: VaultStatus = VaultStatus()
}
struct VaultFamilySyncResponse: Codable, Sendable { var ok: Bool = true; var granted: Int = 0 }
struct VaultTotpResponse: Codable, Sendable { let code: String; let expiresInSeconds: Int }
struct CreateVaultEntryRequest: Codable, Sendable {
    let scope: String
    let title: String
    var folder: String? = nil
    var username: String? = nil
    var url: String? = nil
    var password: String? = nil
    var totpInput: String? = nil
    var notes: String? = nil
}
struct UpdateVaultEntryRequest: Codable, Sendable {
    var title: String? = nil
    var folder: String? = nil
    var username: String? = nil
    var url: String? = nil
    var password: String? = nil
    var totpInput: String? = nil
    var clearTotp: Bool? = nil
    var notes: String? = nil
}

// MARK: - Response envelopes (unwrapped by FamilyAgentAPI)

struct TasksEnvelope: Codable, Sendable { let tasks: [TaskItem] }
struct TaskEnvelope: Codable, Sendable { let task: TaskItem }
struct DocumentsEnvelope: Codable, Sendable { let documents: [Document] }
struct DocumentEnvelope: Codable, Sendable { let document: Document }
struct DocumentSearchEnvelope: Codable, Sendable { let results: [DocumentSearchHit] }
struct TaskSearchEnvelope: Codable, Sendable { let results: [TaskSearchHit] }
struct ActivityEnvelope: Codable, Sendable { let activity: [ActivityEntry] }
struct ChatSessionsEnvelope: Codable, Sendable { let sessions: [ChatSession] }
struct ChatSessionMessagesEnvelope: Codable, Sendable { let messages: [ChatSessionMessage] }
struct ChatSessionEnvelope: Codable, Sendable { let session: ChatSession }
struct FamilyMembersEnvelope: Codable, Sendable { let members: [FamilyMember] }
struct ChannelsEnvelope: Codable, Sendable { let channels: [Channel] }
struct ChannelEnvelope: Codable, Sendable { let channel: Channel }
struct MessagesEnvelope: Codable, Sendable { let messages: [Message] }
struct MessageEnvelope: Codable, Sendable { let message: Message }
struct NotesEnvelope: Codable, Sendable { let notes: [StickyNote] }
struct NoteEnvelope: Codable, Sendable { let note: StickyNote }
struct RoutinesEnvelope: Codable, Sendable { let routines: [Routine] }
struct RoutineEnvelope: Codable, Sendable { let routine: Routine }
struct RoutineRunsEnvelope: Codable, Sendable { let runs: [RoutineRun] }
struct SkillEnvelope: Codable, Sendable { let skill: Skill }
struct McpServersEnvelope: Codable, Sendable { let servers: [McpServer] }
struct VaultEntriesEnvelope: Codable, Sendable { var entries: [VaultEntry] = [] }
struct VaultEntryEnvelope: Codable, Sendable { let entry: VaultEntry }
struct VaultEntryDetailEnvelope: Codable, Sendable { let entry: VaultEntryDetail }
struct VaultAccessLogEnvelope: Codable, Sendable { var entries: [VaultAccessLogEntry] = [] }
