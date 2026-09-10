import Foundation

/// Thin async client over agent-core's local HTTP API — the iOS mirror of
/// `android/.../data/FamilyAgentApi.kt`. Value type; `AppModel` holds the source
/// of truth for `baseURL` / `authToken` and swaps a fresh copy when they change.
struct FamilyAgentAPI: Sendable {
    var baseURL: URL
    var authToken: String?

    private var session: URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        // Matches `FamilyAgentApi.kt`'s OkHttp `readTimeout(120s)`. This was 15s,
        // which is far shorter than Android and shorter than a planner turn: a
        // `POST /chat` sends nothing until the model finishes, and a full turn has
        // taken ~110s on modest hardware (see CLAUDE.md → "Test tiers"). Long turns
        // surfaced to the user as "Could not reach <server> — is the home server
        // running?", which blames the wrong thing entirely.
        cfg.timeoutIntervalForRequest = 120
        cfg.timeoutIntervalForResource = 300
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }

    private static let decoder = JSONDecoder()
    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    init(baseURL: String = "http://localhost:4173", authToken: String? = nil) {
        self.baseURL = URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")))
            ?? URL(string: "http://localhost:4173")!
        self.authToken = authToken
    }

    // MARK: - Core

    private func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = []) -> URLRequest {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        if let token = authToken {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    private func run(_ req: URLRequest) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.transport("Could not reach \(baseURL.absoluteString) — is the home server running? (\(error.localizedDescription))")
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("Unexpected response from \(baseURL.absoluteString)")
        }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            let detail = (try? JSONSerialization.jsonObject(with: data)).map { " — \($0)" }
                ?? (String(data: data, encoding: .utf8).map { $0.isEmpty ? "" : " — \($0)" } ?? "")
            throw APIError.http(status: http.statusCode, message: "\(req.url?.path ?? path(req)): HTTP \(http.statusCode)\(detail)")
        }
        return data
    }

    private func path(_ req: URLRequest) -> String { req.url?.path ?? "?" }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try Self.decoder.decode(T.self, from: data) }
        catch { throw APIError.transport("Bad response: \(error)") }
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self) async throws -> T {
        try decode(T.self, await run(makeRequest("GET", path, query: query)))
    }

    private func getData(_ path: String) async throws -> Data {
        try await run(makeRequest("GET", path))
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        var req = makeRequest(method, path)
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(AnyEncodable(body))
        } else if method != "DELETE" {
            req.httpBody = Data()   // Fastify 400s an empty application/json body → send no content-type
        }
        return try decode(T.self, await run(req))
    }

    private func sendVoid(_ method: String, _ path: String, body: (any Encodable)? = nil) async throws {
        var req = makeRequest(method, path)
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(AnyEncodable(body))
        } else if method != "DELETE" {
            req.httpBody = Data()
        }
        _ = try await run(req)
    }

    private func upload<T: Decodable>(_ path: String, partName: String, filename: String, mime: String?, bytes: Data, as type: T.Type = T.self) async throws -> T {
        let boundary = "Boundary-\(UUID().uuidString)"
        var body = Data()
        func append(_ s: String) { body.append(s.data(using: .utf8)!) }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"\(partName)\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: \(mime ?? "application/octet-stream")\r\n\r\n")
        body.append(bytes)
        append("\r\n--\(boundary)--\r\n")

        var req = makeRequest("POST", path)
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        return try decode(T.self, await run(req))
    }

    // MARK: - Health / auth

    func health() async throws -> HealthResponse { try await get("/health") }
    func authStatus() async throws -> AuthStatusResponse { try await get("/auth/status") }
    func login(_ username: String, _ password: String) async throws -> LoginResponse {
        try await send("POST", "/auth/login", body: LoginRequest(username: username, password: password, deviceLabel: "ios"))
    }
    func bootstrap(_ req: BootstrapRequest) async throws -> LoginResponse {
        try await send("POST", "/auth/bootstrap", body: req)
    }
    /// Trade a QR pairing token for a real session (no password). Public route.
    func redeemPairing(_ token: String) async throws -> LoginResponse {
        try await send("POST", "/auth/pair/redeem", body: PairRedeemRequest(token: token))
    }
    func me() async throws -> User { try await get("/auth/me", as: MeResponse.self).user }
    func logout() async { _ = try? await sendVoid("POST", "/auth/logout") }

    // MARK: - Chat

    func chat(_ message: String, images: [String] = [], sessionId: String? = nil, turnId: String? = nil) async throws -> ChatResponse {
        try await send("POST", "/chat", body: ChatRequest(message: message, images: images, sessionId: sessionId, turnId: turnId))
    }
    func turnSteps(_ turnId: String) async throws -> TurnStepsResponse {
        try await get("/chat/turns/\(turnId.pathEscaped)")
    }

    // MARK: - Chat history sessions

    func listChatSessions() async throws -> [ChatSession] {
        try await get("/chat/sessions", as: ChatSessionsEnvelope.self).sessions
    }
    func chatSessionMessages(_ id: String) async throws -> [ChatSessionMessage] {
        try await get("/chat/sessions/\(id)/messages", as: ChatSessionMessagesEnvelope.self).messages
    }
    func renameChatSession(_ id: String, title: String) async throws -> ChatSession {
        try await send("PATCH", "/chat/sessions/\(id)", body: RenameChatSessionRequest(title: title), as: ChatSessionEnvelope.self).session
    }
    func deleteChatSession(_ id: String) async throws { try await sendVoid("DELETE", "/chat/sessions/\(id)") }

    // MARK: - Voice

    func transcribe(_ wav: Data) async throws -> TranscribeResponse {
        try await upload("/transcribe", partName: "audio", filename: "voice.wav", mime: "audio/wav", bytes: wav)
    }
    func speak(_ text: String, voice: String? = nil) async throws -> Data {
        var req = makeRequest("POST", "/speak")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(SpeakRequest(text: text, voice: voice))
        return try await run(req)
    }
    func ttsVoices() async throws -> TtsVoicesResponse { try await get("/tts/voices") }

    // MARK: - Settings

    func getSettings() async throws -> ServerSettings { try await get("/settings") }
    func setCardsEnabled(_ enabled: Bool) async throws -> ServerSettings {
        try await send("PUT", "/settings", body: UpdateSettingsRequest(cardsEnabled: enabled))
    }
    /// Set the internet-access provider (`"none"` = off) plus its companion URL / API key.
    func setWebAccess(provider: String, url: String? = nil, apiKey: String? = nil) async throws -> ServerSettings {
        try await send("PUT", "/settings", body: UpdateSettingsRequest(
            webSearchProvider: provider, webSearchUrl: url, webSearchApiKey: apiKey))
    }

    // MARK: - Tasks

    func listTasks() async throws -> [TaskItem] { try await get("/tasks", as: TasksEnvelope.self).tasks }
    func getTask(_ id: String) async throws -> TaskItem { try await get("/tasks/\(id)", as: TaskEnvelope.self).task }
    func createTask(title: String, dueDate: String?, dueTime: String? = nil) async throws -> TaskItem {
        try await send("POST", "/tasks", body: CreateTaskRequest(title: title, dueDate: dueDate, dueTime: dueTime), as: TaskEnvelope.self).task
    }
    func completeTask(_ id: String) async throws -> TaskItem {
        try await send("PATCH", "/tasks/\(id)", body: UpdateTaskStatusRequest(status: "done"), as: TaskEnvelope.self).task
    }
    func rescheduleTask(_ id: String, dueDate: String?, dueTime: String?) async throws -> TaskItem {
        try await send("PATCH", "/tasks/\(id)", body: RescheduleTaskRequest(dueDate: dueDate, dueTime: dueTime), as: TaskEnvelope.self).task
    }
    func searchTasks(_ query: String, status: String? = nil) async throws -> [TaskSearchHit] {
        var q = [URLQueryItem(name: "q", value: query)]
        if let status { q.append(URLQueryItem(name: "status", value: status)) }
        return try await get("/tasks/search", query: q, as: TaskSearchEnvelope.self).results
    }

    // MARK: - Documents

    func listDocuments() async throws -> [Document] { try await get("/documents", as: DocumentsEnvelope.self).documents }
    func getDocument(_ id: String) async throws -> Document { try await get("/documents/\(id)", as: DocumentEnvelope.self).document }
    func searchDocuments(_ query: String, mode: String? = nil, category: String? = nil, dueBefore: String? = nil, dueAfter: String? = nil, limit: Int? = nil) async throws -> [DocumentSearchHit] {
        var q = [URLQueryItem(name: "q", value: query)]
        if let mode { q.append(URLQueryItem(name: "mode", value: mode)) }
        if let category { q.append(URLQueryItem(name: "category", value: category)) }
        if let dueBefore { q.append(URLQueryItem(name: "dueBefore", value: dueBefore)) }
        if let dueAfter { q.append(URLQueryItem(name: "dueAfter", value: dueAfter)) }
        if let limit { q.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await get("/documents/search", query: q, as: DocumentSearchEnvelope.self).results
    }
    func ingestDocument(filename: String, text: String) async throws -> Document {
        try await send("POST", "/documents/ingest", body: IngestDocumentRequest(filename: filename, text: text), as: DocumentEnvelope.self).document
    }
    func uploadDocument(filename: String, bytes: Data, mime: String?) async throws -> Document {
        try await upload("/documents/upload", partName: "file", filename: filename, mime: mime, bytes: bytes, as: DocumentEnvelope.self).document
    }
    func deleteDocument(_ id: String) async throws { try await sendVoid("DELETE", "/documents/\(id)") }
    func documentOriginal(_ id: String) async throws -> Data { try await getData("/documents/\(id)/original") }
    func retryExtraction(_ id: String) async throws -> Document {
        try await send("POST", "/documents/\(id)/retry-extraction", as: DocumentEnvelope.self).document
    }
    func renameDocument(_ id: String, filename: String, by: String = "user") async throws -> Document {
        try await send("PATCH", "/documents/\(id)", body: RenameDocumentRequest(filename: filename, by: by), as: DocumentEnvelope.self).document
    }
    func suggestDocumentName(_ id: String) async throws -> SuggestNameResponse {
        try await send("POST", "/documents/\(id)/suggest-name")
    }

    // MARK: - Activity

    func listActivity() async throws -> [ActivityEntry] { try await get("/activity", as: ActivityEnvelope.self).activity }

    // MARK: - Family chat

    func listFamilyMembers() async throws -> [FamilyMember] { try await get("/family/members", as: FamilyMembersEnvelope.self).members }
    func listChannels() async throws -> [Channel] { try await get("/channels", as: ChannelsEnvelope.self).channels }
    func createChannel(kind: String, memberIds: [String], name: String?) async throws -> Channel {
        try await send("POST", "/channels", body: CreateChannelRequest(kind: kind, memberIds: memberIds, name: name), as: ChannelEnvelope.self).channel
    }
    func getChannel(_ id: String) async throws -> Channel { try await get("/channels/\(id)", as: ChannelEnvelope.self).channel }
    func listMessages(_ id: String, after: String? = nil) async throws -> [Message] {
        let q = after.map { [URLQueryItem(name: "after", value: $0)] } ?? []
        return try await get("/channels/\(id)/messages", query: q, as: MessagesEnvelope.self).messages
    }
    func postMessage(_ id: String, body: String, mentionAgent: Bool, images: [String] = []) async throws -> Message {
        try await send("POST", "/channels/\(id)/messages", body: PostMessageRequest(body: body, mentionAgent: mentionAgent, images: images), as: MessageEnvelope.self).message
    }
    func markChannelRead(_ id: String, ts: String) async { _ = try? await sendVoid("POST", "/channels/\(id)/read", body: MarkReadRequest(ts: ts)) }
    func deleteChannel(_ id: String) async throws { try await sendVoid("DELETE", "/channels/\(id)") }

    // MARK: - Sticky notes

    func listNotes(scope: String) async throws -> [StickyNote] {
        try await get("/notes", query: [URLQueryItem(name: "scope", value: scope)], as: NotesEnvelope.self).notes
    }
    func createNote(scope: String, text: String, color: String?, x: Double? = nil, y: Double? = nil) async throws -> StickyNote {
        try await send("POST", "/notes", body: CreateNoteRequest(scope: scope, text: text, color: color, x: x, y: y), as: NoteEnvelope.self).note
    }
    func updateNote(_ id: String, text: String? = nil, color: String? = nil, x: Double? = nil, y: Double? = nil) async throws -> StickyNote {
        try await send("PATCH", "/notes/\(id)", body: UpdateNoteRequest(text: text, color: color, x: x, y: y), as: NoteEnvelope.self).note
    }
    func deleteNote(_ id: String) async throws { try await sendVoid("DELETE", "/notes/\(id)") }

    // MARK: - Routines

    func listRoutines() async throws -> [Routine] { try await get("/routines", as: RoutinesEnvelope.self).routines }
    func createRoutine(_ input: RoutineInput) async throws -> Routine {
        try await send("POST", "/routines", body: input, as: RoutineEnvelope.self).routine
    }
    func updateRoutine(_ id: String, _ input: RoutineInput) async throws -> Routine {
        try await send("PATCH", "/routines/\(id)", body: input, as: RoutineEnvelope.self).routine
    }
    func setRoutineEnabled(_ id: String, enabled: Bool) async throws -> Routine {
        try await send("PATCH", "/routines/\(id)", body: SetRoutineEnabledRequest(enabled: enabled), as: RoutineEnvelope.self).routine
    }
    func deleteRoutine(_ id: String) async throws { try await sendVoid("DELETE", "/routines/\(id)") }
    func listRoutineRuns(_ id: String, limit: Int = 20) async throws -> [RoutineRun] {
        try await get("/routines/\(id)/runs", query: [URLQueryItem(name: "limit", value: String(limit))], as: RoutineRunsEnvelope.self).runs
    }
    func runRoutine(_ id: String) async throws -> RunRoutineResponse {
        try await send("POST", "/routines/\(id)/run")
    }

    // MARK: - Skills

    func listSkills() async throws -> SkillsResponse { try await get("/skills") }
    func getSkill(_ name: String) async throws -> Skill {
        try await get("/skills/\(name.pathEscaped)", as: SkillEnvelope.self).skill
    }
    func saveSkill(_ req: SaveSkillRequest) async throws -> Skill {
        try await send("POST", "/skills", body: req, as: SkillEnvelope.self).skill
    }
    func setSkillEnabled(_ name: String, enabled: Bool) async throws -> Skill {
        try await send("PATCH", "/skills/\(name.pathEscaped)", body: SetEnabledRequest(enabled: enabled), as: SkillEnvelope.self).skill
    }
    func deleteSkill(_ name: String) async throws { try await sendVoid("DELETE", "/skills/\(name.pathEscaped)") }
    func draftSkill(_ name: String, description: String) async throws -> String {
        try await send("POST", "/skills/draft", body: DraftSkillRequest(name: name, description: description), as: DraftSkillResponse.self).markdown
    }

    // MARK: - MCP

    func listMcpServers() async throws -> [McpServer] { try await get("/mcp/servers", as: McpServersEnvelope.self).servers }
    func saveMcpServer(_ server: McpServer) async throws -> SaveMcpServerResponse {
        try await send("POST", "/mcp/servers", body: server)
    }
    func setMcpServerEnabled(_ name: String, enabled: Bool) async throws {
        try await sendVoid("PATCH", "/mcp/servers/\(name.pathEscaped)", body: SetEnabledRequest(enabled: enabled))
    }
    func deleteMcpServer(_ name: String) async throws { try await sendVoid("DELETE", "/mcp/servers/\(name.pathEscaped)") }
    func probeMcpServer(_ name: String) async throws -> McpProbeResult {
        try await send("POST", "/mcp/servers/\(name.pathEscaped)/probe")
    }
    func listMcpTools() async throws -> [McpToolInfo] { try await get("/mcp/tools", as: McpToolsResponse.self).tools }

    // MARK: - Tools

    func listTools() async throws -> [Tool] { try await get("/tools", as: ToolsResponse.self).tools }
    func buildTool(_ prompt: String) async throws { try await sendVoid("POST", "/tools", body: BuildToolRequest(prompt: prompt)) }
    func deleteTool(_ id: String) async throws { try await sendVoid("DELETE", "/tools/\(id)") }

    // MARK: - Artifacts (render_artifact)

    func listArtifacts() async throws -> [ArtifactSummary] {
        try await get("/artifacts", as: ArtifactListResponse.self).artifacts
    }
    func getArtifact(_ id: String) async throws -> Artifact {
        try await get("/artifacts/\(id)", as: ArtifactResponse.self).artifact
    }
    func renameArtifact(_ id: String, title: String) async throws -> ArtifactSummary {
        try await send("PATCH", "/artifacts/\(id)", body: ["title": title], as: ArtifactSummaryResponse.self).artifact
    }
    func deleteArtifact(_ id: String) async throws { try await sendVoid("DELETE", "/artifacts/\(id)") }

    // MARK: - Vault

    func vaultStatus() async throws -> VaultStatus { try await get("/vault/status") }
    func vaultSetup(_ password: String) async throws -> VaultSetupResponse {
        try await send("POST", "/vault/setup", body: VaultPasswordRequest(password: password))
    }
    func vaultUnlock(_ password: String) async throws -> VaultUnlockResponse {
        try await send("POST", "/vault/unlock", body: VaultPasswordRequest(password: password))
    }
    func vaultLock() async throws -> VaultUnlockResponse { try await send("POST", "/vault/lock") }
    func vaultRecover(recoveryCode: String, password: String) async throws -> VaultSetupResponse {
        try await send("POST", "/vault/recover", body: VaultRecoverRequest(recoveryCode: recoveryCode, password: password))
    }
    func vaultFamilySync() async throws -> VaultFamilySyncResponse { try await send("POST", "/vault/family/sync") }
    func listVaultEntries() async throws -> [VaultEntry] { try await get("/vault/entries", as: VaultEntriesEnvelope.self).entries }
    func getVaultEntry(_ id: String) async throws -> VaultEntryDetail {
        try await get("/vault/entries/\(id)", as: VaultEntryDetailEnvelope.self).entry
    }
    func createVaultEntry(_ req: CreateVaultEntryRequest) async throws -> VaultEntry {
        try await send("POST", "/vault/entries", body: req, as: VaultEntryEnvelope.self).entry
    }
    func updateVaultEntry(_ id: String, _ req: UpdateVaultEntryRequest) async throws -> VaultEntry {
        try await send("PATCH", "/vault/entries/\(id)", body: req, as: VaultEntryEnvelope.self).entry
    }
    func deleteVaultEntry(_ id: String) async throws { try await sendVoid("DELETE", "/vault/entries/\(id)") }
    func vaultTotp(_ id: String) async throws -> VaultTotpResponse { try await get("/vault/entries/\(id)/totp") }
    func vaultAccessLog() async throws -> [VaultAccessLogEntry] { try await get("/vault/access-log", as: VaultAccessLogEnvelope.self).entries }
}

// MARK: - helpers

private extension String {
    var pathEscaped: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? self
    }
}

/// Type-erased Encodable so `send` can take `any Encodable`.
struct AnyEncodable: Encodable {
    private let encodeFn: (Encoder) throws -> Void
    init(_ wrapped: any Encodable) { encodeFn = wrapped.encode }
    func encode(to encoder: Encoder) throws { try encodeFn(encoder) }
}
