import Foundation

/// Plain list refreshes + simple mutations. The chat / voice / conversation
/// polling lives in `AppModel+Chat.swift` / `AppModel+Messages.swift`.
extension AppModel {

    // MARK: Activity

    func refreshActivity() async {
        if let a = await perform({ try await api.listActivity() }) { activity = a }
    }

    // MARK: Tasks

    func refreshTasks() async {
        if let t = await perform({ try await api.listTasks() }) { tasks = t }
    }
    func addTask(title: String, dueDate: String?, dueTime: String?) {
        Task {
            if await perform({ try await api.createTask(title: title, dueDate: dueDate, dueTime: dueTime) }) != nil {
                await refreshTasks()
            }
        }
    }
    func completeTask(_ id: String) {
        Task {
            _ = await perform { try await api.completeTask(id) }
            await refreshTasks()
        }
    }
    func rescheduleTask(_ id: String, dueDate: String?, dueTime: String?) {
        Task {
            _ = await perform { try await api.rescheduleTask(id, dueDate: dueDate, dueTime: dueTime) }
            await refreshTasks()
        }
    }

    // MARK: Documents

    func refreshDocuments() async {
        if let d = await perform({ try await api.listDocuments() }) { documents = d }
    }
    func ingestDocument(filename: String, text: String) {
        Task {
            documentUploadStatus = "Adding…"
            _ = await perform { try await api.ingestDocument(filename: filename, text: text) }
            documentUploadStatus = nil
            await refreshDocuments()
        }
    }
    func uploadDocument(filename: String, bytes: Data, mime: String?) {
        Task {
            documentUploadStatus = "Uploading \(filename)…"
            _ = await perform { try await api.uploadDocument(filename: filename, bytes: bytes, mime: mime) }
            documentUploadStatus = nil
            await refreshDocuments()
        }
    }
    func deleteDocument(_ id: String) {
        Task { _ = await perform { try await api.deleteDocument(id) }; await refreshDocuments() }
    }
    func retryExtraction(_ id: String) {
        Task { _ = await perform { try await api.retryExtraction(id) }; await refreshDocuments() }
    }
    func renameDocument(_ id: String, filename: String, byAgent: Bool) {
        Task {
            _ = await perform { try await api.renameDocument(id, filename: filename, by: byAgent ? "document-agent" : "user") }
            await refreshDocuments()
        }
    }

    private static var docSearchGeneration = 0
    func setDocumentSearch(query: String, mode: String) {
        documentSearchQuery = query
        documentSearchMode = mode
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            documentSearchResults = nil
            documentSearching = false
            return
        }
        Self.docSearchGeneration += 1
        let gen = Self.docSearchGeneration
        documentSearching = true
        Task {
            try? await Task.sleep(for: .milliseconds(220))
            guard gen == Self.docSearchGeneration else { return }
            let hits = await perform { try await api.searchDocuments(trimmed, mode: mode) }
            guard gen == Self.docSearchGeneration else { return }
            documentSearchResults = hits ?? []
            documentSearching = false
        }
    }

    func openDocumentDetail(_ id: String) {
        detail = .loading
        Task {
            guard let doc = await perform({ try await api.getDocument(id) }) else {
                detail = .failed("Couldn't load that document.")
                return
            }
            var pdf: Data?
            let isPDF = (doc.originalMime?.contains("pdf") ?? false) || doc.filename.lowercased().hasSuffix(".pdf")
            if isPDF {
                pdf = try? await api.documentOriginal(id)
            }
            detail = .document(doc: doc, pdf: pdf)
        }
    }
    func openTaskDetail(_ id: String) {
        detail = .loading
        Task {
            if let t = await perform({ try await api.getTask(id) }) { detail = .task(t) }
            else { detail = .failed("Couldn't load that item.") }
        }
    }
    func suggestDocumentName(_ id: String) async -> String? {
        await perform { try await api.suggestDocumentName(id).suggestion.filename }
    }
    func closeDetail() { detail = nil }

    // MARK: Tools

    func refreshTools() async {
        if let t = await perform({ try await api.listTools() }) { tools = t }
    }
    func buildTool(_ prompt: String) {
        Task {
            toolStatus = "Building…"
            _ = await perform { try await api.buildTool(prompt) }
            await refreshTools()
            toolStatus = nil
        }
    }
    func deleteTool(_ id: String) {
        Task { _ = await perform { try await api.deleteTool(id) }; await refreshTools() }
    }

    // MARK: Artifacts (render_artifact)

    func refreshArtifacts() async {
        artifactsLoading = true
        if let a = await perform({ try await api.listArtifacts() }) { artifacts = a }
        artifactsLoading = false
    }
    /// Distinguishes a genuine 404 from any other failure (a network blip, a
    /// timeout, a decode error) — `perform`'s blanket `nil` on any `catch`
    /// doesn't, which previously made the viewer report "deleted" for every
    /// kind of failure, transient ones included.
    enum ArtifactLoadResult {
        case success(ArtifactResponse)
        case notFound
        case failed(String)
    }
    func loadArtifact(_ id: String) async -> ArtifactLoadResult {
        do {
            return .success(try await api.getArtifact(id))
        } catch APIError.unauthorized {
            settings.clearSession()
            if case .authed = auth {
                auth = .needLogin(serverURL: serverURL, serverName: settings.session?.serverName ?? "", error: "Your session expired — sign in again.")
            }
            return .failed("Your session expired — sign in again.")
        } catch APIError.http(404, _) {
            return .notFound
        } catch {
            return .failed(error.localizedDescription)
        }
    }
    func renameArtifact(_ id: String, title: String) {
        Task {
            _ = await perform { try await api.renameArtifact(id, title: title) }
            await refreshArtifacts()
        }
    }
    func deleteArtifact(_ id: String) {
        Task {
            _ = await perform { try await api.deleteArtifact(id) }
            if viewingArtifact?.artifactId == id { viewingArtifact = nil }
            await refreshArtifacts()
        }
    }
    /// Open the full-screen viewer for one artifact (from a reply's chip).
    /// Always a fresh `ArtifactPresentation` — see its doc comment for why.
    func openArtifact(_ id: String) { viewingArtifact = ArtifactPresentation(artifactId: id) }

    // MARK: Routines

    func refreshRoutines() async {
        if let r = await perform({ try await api.listRoutines() }) { routines = r }
    }
    func saveRoutine(id: String?, _ input: RoutineInput) {
        Task {
            if let id {
                _ = await perform { try await api.updateRoutine(id, input) }
            } else {
                _ = await perform { try await api.createRoutine(input) }
            }
            await refreshRoutines()
        }
    }
    func setRoutineEnabled(_ id: String, _ enabled: Bool) {
        Task { _ = await perform { try await api.setRoutineEnabled(id, enabled: enabled) }; await refreshRoutines() }
    }
    func deleteRoutine(_ id: String) {
        Task { _ = await perform { try await api.deleteRoutine(id) }; await refreshRoutines() }
    }
    func loadRoutineRuns(_ id: String) {
        Task {
            if let runs = await perform({ try await api.listRoutineRuns(id) }) { routineRuns[id] = runs }
        }
    }
    func runRoutineNow(_ id: String) {
        Task {
            routineStatus = "Running…"
            let r = await perform { try await api.runRoutine(id) }
            routineStatus = r.map { $0.status == "ok" ? nil : ("Failed: " + ($0.error ?? "unknown")) } ?? "Failed"
            await refreshRoutines()
            loadRoutineRuns(id)
        }
    }

    // MARK: Skills

    func refreshSkills() async {
        if let s = await perform({ try await api.listSkills() }) {
            skills = s.skills
            skillScriptsRunnable = s.scriptsRunnable
        }
    }
    func loadSkillBody(_ name: String) async -> String? {
        (await perform { try await api.getSkill(name) })?.body
    }
    func saveSkill(_ req: SaveSkillRequest) {
        Task { _ = await perform { try await api.saveSkill(req) }; await refreshSkills() }
    }
    func setSkillEnabled(_ name: String, _ enabled: Bool) {
        Task { _ = await perform { try await api.setSkillEnabled(name, enabled: enabled) }; await refreshSkills() }
    }
    func deleteSkill(_ name: String) {
        Task { _ = await perform { try await api.deleteSkill(name) }; await refreshSkills() }
    }
    func draftSkill(_ name: String, _ description: String) async -> String? {
        await perform { try await api.draftSkill(name, description: description) }
    }

    // MARK: Connections (MCP)

    func refreshConnections() async {
        if let s = await perform({ try await api.listMcpServers() }) { mcpServers = s }
    }
    func saveMcpServer(_ server: McpServer) {
        Task {
            let r = await perform { try await api.saveMcpServer(server) }
            mcpStatus = r.map { $0.probe.ok ? "Connected — \($0.probe.toolCount ?? 0) tools" : ("Probe failed: " + ($0.probe.error ?? "unknown")) }
            await refreshConnections()
        }
    }
    func setMcpServerEnabled(_ name: String, _ enabled: Bool) {
        Task { _ = await perform { try await api.setMcpServerEnabled(name, enabled: enabled) }; await refreshConnections() }
    }
    func deleteMcpServer(_ name: String) {
        Task { _ = await perform { try await api.deleteMcpServer(name) }; await refreshConnections() }
    }
    func probeMcpServer(_ name: String) {
        Task {
            let r = await perform { try await api.probeMcpServer(name) }
            mcpStatus = r.map { $0.ok ? "OK — \($0.toolCount ?? 0) tools" : ("Failed: " + ($0.error ?? "unknown")) }
        }
    }

    // MARK: Vault

    func refreshVault() async {
        guard let s = await perform({ try await api.vaultStatus() }) else { return }
        vaultStatusValue = s
        if s.unlocked {
            vaultEntries = (await perform { try await api.listVaultEntries() }) ?? []
        }
    }
    func vaultSetup(_ password: String) {
        Task {
            if let r = await perform({ try await api.vaultSetup(password) }) {
                vaultRecoveryCode = r.recoveryCode
                vaultStatusValue = r.status
            }
            await refreshVault()
        }
    }
    func vaultUnlock(_ password: String) {
        Task {
            let r = await perform { try await api.vaultUnlock(password) }
            if r == nil { vaultStatusMsg = "Wrong password." }
            await refreshVault()
        }
    }
    func vaultLock() {
        Task { _ = await perform { try await api.vaultLock() }; vaultDetail = nil; await refreshVault() }
    }
    func vaultRecover(code: String, password: String) {
        Task {
            if let r = await perform({ try await api.vaultRecover(recoveryCode: code, password: password) }) {
                vaultRecoveryCode = r.recoveryCode
            }
            await refreshVault()
        }
    }
    func vaultFamilySync() {
        Task {
            let r = await perform { try await api.vaultFamilySync() }
            vaultStatusMsg = r.map { "Shared with \($0.granted) member\($0.granted == 1 ? "" : "s")." }
            await refreshVault()
        }
    }
    func dismissVaultRecoveryCode() { vaultRecoveryCode = nil }
    func openVaultEntry(_ id: String) {
        Task { vaultDetail = await perform { try await api.getVaultEntry(id) } }
    }
    func closeVaultEntry() { vaultDetail = nil }
    func saveVaultEntry(id: String?, create: CreateVaultEntryRequest?, update: UpdateVaultEntryRequest?) {
        Task {
            if let id, let update {
                _ = await perform { try await api.updateVaultEntry(id, update) }
            } else if let create {
                _ = await perform { try await api.createVaultEntry(create) }
            }
            await refreshVault()
        }
    }
    func deleteVaultEntry(_ id: String) {
        Task { _ = await perform { try await api.deleteVaultEntry(id) }; vaultDetail = nil; await refreshVault() }
    }
    func loadVaultAccessLog() {
        Task { vaultAccessLog = (await perform { try await api.vaultAccessLog() }) ?? [] }
    }
    func vaultCurrentTotp(_ id: String) async -> VaultTotpResponse? {
        await perform { try await api.vaultTotp(id) }
    }

    // MARK: Server settings

    func refreshServerSettings() async {
        serverSettings = await perform { try await api.getSettings() }
    }
    func setCardsEnabled(_ enabled: Bool) {
        Task {
            serverSettings = await perform { try await api.setCardsEnabled(enabled) }
            await refreshStatus()
        }
    }
    func setVaultEnabled(_ enabled: Bool) {
        Task {
            serverSettings = await perform { try await api.setVaultEnabled(enabled) }
            await refreshStatus()
        }
    }

    // MARK: Remote update-and-restart of the host desktop app
    //
    // The desktop app itself does the actual check/download/install/relaunch
    // (only its webview has the Tauri updater plugin) — this just asks it to,
    // then polls the same hand-off status every client can see. A restart
    // drops the connection out from under this poll partway through, which is
    // expected and not an error: stop after a run of consecutive failures
    // and let the normal connection banner take it from there.

    func triggerDesktopUpdate() {
        guard !desktopUpdatePolling else { return }
        Task {
            desktopUpdateStatus = await perform { try await api.requestDesktopUpdate() }
            guard desktopUpdateStatus != nil else { return }
            desktopUpdatePolling = true
            var consecutiveFailures = 0
            for _ in 0..<45 { // ~90s at 2s/tick — comfortably covers check+download+install
                try? await Task.sleep(for: .seconds(2))
                do {
                    let status = try await api.getDesktopUpdateStatus()
                    desktopUpdateStatus = status
                    consecutiveFailures = 0
                    if status.state == "no-update" || status.state == "error" { break }
                } catch {
                    consecutiveFailures += 1
                    // A few misses in a row almost certainly means the host is
                    // mid-relaunch, not that something's actually wrong.
                    if consecutiveFailures >= 3 {
                        desktopUpdateStatus = DesktopUpdateStatus(state: "restarting", requestedAt: desktopUpdateStatus?.requestedAt, requestedBy: desktopUpdateStatus?.requestedBy)
                        break
                    }
                }
            }
            desktopUpdatePolling = false
        }
    }
    /// Internet access: provider "none" = off; searxng needs `url`; tavily/brave need `apiKey`.
    func setWebAccess(provider: String, url: String?, apiKey: String?) {
        Task {
            if let s = await perform({ try await api.setWebAccess(provider: provider, url: url, apiKey: apiKey) }) {
                serverSettings = s
                await refreshStatus()
            }
        }
    }
    func setServerURL(_ url: String) {
        pickServer(url)
    }

    // MARK: Chat sessions

    func refreshChatSessions() async {
        if let s = await perform({ try await api.listChatSessions() }) { chatSessions = s }
    }
    func deleteChatSession(_ id: String) {
        Task {
            _ = await perform { try await api.deleteChatSession(id) }
            if activeChatSessionID == id { startNewChatSession() }
            await refreshChatSessions()
        }
    }
}
