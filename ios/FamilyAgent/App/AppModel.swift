import SwiftUI
import Observation

// MARK: - Local state types (mirror the Kotlin sealed interfaces)

enum ConnectionStatus: Equatable {
    case connecting
    case connected(model: String)
    case unreachable(String)
}

enum AuthState: Equatable {
    case unknown
    case pickServer
    case needLogin(serverURL: String, serverName: String, error: String?)
    case authed(User)
}

/// A request to open the full-screen artifact viewer. Carries its own UUID
/// (not just the artifact id) specifically so re-opening the *same* artifact
/// — e.g. retrying after a failed load — is always a distinct value: to
/// `fullScreenCover(item:)` (see `AppModel.viewingArtifact`), an unchanged
/// item is nothing to do; to `navigationDestination(for:)` (see
/// `ArtifactsView`), a bare artifact-id `String` pushed again after being
/// popped can resolve to the *same* view identity SwiftUI already created
/// for that value, reusing its stale `@State` (including a prior error)
/// instead of mounting a fresh view that would actually reload. Hashable
/// for the second use — NavigationPath needs it, `fullScreenCover(item:)`
/// only needs Identifiable.
struct ArtifactPresentation: Identifiable, Hashable {
    let id = UUID()
    let artifactId: String
}

struct ChatMessage: Identifiable, Hashable {
    let id = UUID()
    var role: String                 // "user" | "assistant" | "error"
    var text: String
    var images: [String] = []
    var references: [ChatReference] = []
    var steps: [ToolStep] = []
    var cards: [Card] = []
}

enum DetailContent: Identifiable {
    case loading
    case task(TaskItem)
    case document(doc: Document, pdf: Data?)
    case failed(String)
    case steps([ToolStep])
    case cardSource(title: String, fragment: String)

    var id: String {
        switch self {
        case .loading: return "loading"
        case .task(let t): return "task-\(t.id)"
        case .document(let d, _): return "doc-\(d.id)"
        case .failed(let m): return "failed-\(m)"
        case .steps: return "steps"
        case .cardSource(let t, _): return "card-\(t)"
        }
    }
}

// MARK: - AppModel

@MainActor
@Observable
final class AppModel {
    // ---- auth / connection ----
    var auth: AuthState = .unknown
    var serverURL = ""
    var connection: ConnectionStatus = .connecting

    // ---- health-derived capability flags (from GET /health) ----
    var voiceEnabled = false
    var ttsEnabled = false
    var routinesEnabled = true
    var skillsMode = "off"
    var mcpMode = "off"
    var vaultMode = "off"
    var vaultAiEnabled = false
    var cardsMode = "off"
    var artifactsMode = "off"
    var semanticSearchEnabled = true
    var toolsMode = "off"
    var toolsPort = 4174

    // ---- artifacts (render_artifact → the Artifacts tab) ----
    var artifacts: [ArtifactSummary] = []
    var artifactsLoading = false
    /// Set to open the full-screen artifact viewer (from a reply's chip). A
    /// fresh identity per open — not just the artifact id — so tapping the
    /// same chip twice in a row (e.g. after the first attempt failed) always
    /// re-presents and reloads: `fullScreenCover(item:)` only reacts to the
    /// bound item's `id` *changing*, and re-assigning the same artifact id
    /// string would otherwise be a silent no-op.
    var viewingArtifact: ArtifactPresentation?

    // ---- chat ----
    var chatMessages: [ChatMessage] = []
    var chatSending = false
    var chatLiveSteps: [ToolStep] = []
    var activeChatSessionID: String?
    var chatSessions: [ChatSession] = []
    var chatTranscribing = false

    // ---- speech ----
    var speakingText: String?
    var speakLoadingText: String?
    // Stored (not a computed pass-through to `settings`) so `@Observable` sees the
    // change and re-renders — `SettingsStore` is a `let` struct writing straight to
    // UserDefaults, invisible to observation. `didSet` keeps UserDefaults in sync.
    var autoRead: Bool = SettingsStore().autoRead {
        didSet { settings.autoRead = autoRead }
    }
    /// Composer mic side — `true` = left of the text field. Device-local.
    var micOnLeft: Bool = SettingsStore().micOnLeft {
        didSet { settings.micOnLeft = micOnLeft }
    }
    /// Notify when a reply is ready and you're not looking at it. Device-local.
    var notifyOnReply: Bool = SettingsStore().notifyOnReply {
        didSet { settings.notifyOnReply = notifyOnReply }
    }

    // ---- "reply is ready" notifications: not persisted, just point-in-time
    // state read at the moment a reply lands, to skip a redundant
    // notification for whatever's already on screen. Set from MainShell. ----
    var isAppForeground = true
    var isChatScreenActive = false
    /// A tapped notification's target, relayed from AppDelegate by
    /// FamilyAgentApp; MainShell consumes and clears it.
    var pendingNotificationNav: PendingNotificationNav?
    /// Signature (createdAt) of the last resolved agent reply already
    /// notified about, per channel — see `notifyOfResolvedAgentReplies`.
    var lastNotifiedAgentReply: [String: String] = [:]
    var channelNotifySeeded = false

    // ---- tasks / documents / activity ----
    var tasks: [TaskItem] = []
    var documents: [Document] = []
    var activity: [ActivityEntry] = []
    var documentUploadStatus: String?
    var documentSearchQuery = ""
    var documentSearchMode = "hybrid"
    var documentSearchResults: [DocumentSearchHit]?
    var documentSearching = false

    // ---- tools ----
    var tools: [Tool] = []
    var toolStatus: String?
    var toolsBaseURL: String?

    // ---- tasks screen prefs ----
    var taskView: String = SettingsStore().taskView {
        didSet { settings.taskView = taskView }
    }
    var calAnchor: Date = Calendar.gregorianMonday.startOfDay(for: .now)

    // ---- remote update-and-restart of the host desktop app ----
    var desktopUpdateStatus: DesktopUpdateStatus?
    var desktopUpdatePolling = false

    // Set while ArtifactViewerView is pushed (not presented as a sheet) —
    // mirrors `activeChannel`: MainShell hides its floating menu button while
    // this is true, since the pushed viewer's own system back button then
    // sits in the same top-left corner the floating button otherwise owns.
    var artifactViewerPushed = false

    // ---- family chat + board ----
    var familyMembers: [FamilyMember] = []
    var channels: [Channel] = []
    var activeChannel: Channel?
    var channelMessages: [Message] = []
    var channelSending = false
    var channelTranscribing = false
    var notes: [StickyNote] = []
    var noteScope = "shared"

    // ---- routines / skills / mcp ----
    var routines: [Routine] = []
    var routineStatus: String?
    var routineRuns: [String: [RoutineRun]] = [:]
    var skills: [Skill] = []
    var skillScriptsRunnable = false
    var skillStatus: String?
    var mcpServers: [McpServer] = []
    var mcpStatus: String?

    // ---- vault ----
    var vaultStatusValue: VaultStatus?
    var vaultEntries: [VaultEntry] = []
    var vaultDetail: VaultEntryDetail?
    var vaultAccessLog: [VaultAccessLogEntry] = []
    var vaultStatusMsg: String?
    var vaultRecoveryCode: String?

    // ---- settings ----
    var serverSettings: ServerSettings?

    // ---- detail sheet ----
    var detail: DetailContent?
    /// A `link` reference tapped in chat — the UI opens it in Safari and clears this.
    var externalURL: URL?
    /// One-shot error banner text.
    var lastError: String?

    // ---- infra ----
    var api = FamilyAgentAPI()
    let settings = SettingsStore()
    let audio = AudioPlayer()

    var currentUser: User? {
        if case let .authed(u) = auth { return u }
        return nil
    }
    var isAdmin: Bool { currentUser?.role == "admin" }
    var totalUnread: Int { channels.reduce(0) { $0 + $1.unreadCount } }

    // MARK: - Session

    func restoreSession() async {
        #if DEBUG
        // Screenshot / smoke-test shortcut: FA_SERVER_URL + FA_AUTOLOGIN=user:pass
        let env = ProcessInfo.processInfo.environment
        if let url = env["FA_SERVER_URL"], let creds = env["FA_AUTOLOGIN"] {
            let parts = creds.split(separator: ":", maxSplits: 1)
            serverURL = url
            api = FamilyAgentAPI(baseURL: url, authToken: nil)
            settings.setServerURL(url)
            do {
                let resp = try await api.login(String(parts[0]), String(parts.count > 1 ? parts[1] : ""))
                api = FamilyAgentAPI(baseURL: url, authToken: resp.token)
                settings.saveSession(serverURL: url, token: resp.token, serverName: "Test Home", userName: resp.user.displayName)
                auth = .authed(resp.user)
                await refreshStatus()
                await refreshChannels()
                await openMostRecentChatSession()
                return
            } catch {
                auth = .needLogin(serverURL: url, serverName: "", error: error.localizedDescription)
                return
            }
        }
        #endif
        if let s = settings.session {
            serverURL = s.serverURL
            api = FamilyAgentAPI(baseURL: s.serverURL, authToken: s.token)
            do {
                let user = try await api.me()
                auth = .authed(user)
                await refreshStatus()
                await refreshChannels()
                await openMostRecentChatSession()
                return
            } catch {
                settings.clearSession()
            }
            auth = .needLogin(serverURL: s.serverURL, serverName: s.serverName, error: nil)
        } else {
            auth = .pickServer
        }
    }

    func pickServer(_ url: String) {
        let clean = url.trimmingCharacters(in: .whitespaces)
        serverURL = clean
        api = FamilyAgentAPI(baseURL: clean, authToken: nil)
        settings.setServerURL(clean)
        Task {
            do {
                let status = try await api.authStatus()
                if status.needsSetup {
                    auth = .needLogin(serverURL: clean, serverName: status.serverName, error: "SETUP")
                } else {
                    auth = .needLogin(serverURL: clean, serverName: status.serverName, error: nil)
                }
            } catch {
                auth = .needLogin(serverURL: clean, serverName: "", error: error.localizedDescription)
            }
        }
    }

    /// Recently connected servers — a one-tap reconnect on the discovery
    /// screen, most valuable for an address auto-scan can't rediscover
    /// (Tailscale/off-LAN). See SettingsStore.RecentServer.
    var recentServers: [SettingsStore.RecentServer] { settings.recentServers }

    func backToServerPick() { auth = .pickServer }

    /// True while a scanned pairing QR is being redeemed (brief).
    var pairing = false

    /// Handle a payload read from a "Pair a phone" QR. With a token it signs
    /// straight in; without one it's just an address → the normal login screen.
    func handleScannedPairing(_ raw: String) {
        guard let payload = PairingPayload.parse(from: raw) else { return }
        if let token = payload.token {
            redeemPairing(url: payload.serverURL, serverName: payload.serverName, token: token)
        } else {
            pickServer(payload.serverURL)
        }
    }

    private func redeemPairing(url: String, serverName: String?, token: String) {
        let clean = url.trimmingCharacters(in: .whitespaces)
        serverURL = clean
        api = FamilyAgentAPI(baseURL: clean, authToken: nil)
        settings.setServerURL(clean)
        pairing = true
        Task {
            defer { pairing = false }
            do {
                let resp = try await api.redeemPairing(token)
                finishSignIn(url: clean, name: serverName ?? "", resp: resp)
            } catch {
                // Token expired / already used / server unreachable — fall back
                // to signing in by hand on the same server.
                auth = .needLogin(serverURL: clean, serverName: serverName ?? "",
                                  error: error.localizedDescription)
            }
        }
    }

    func login(username: String, password: String, remember: Bool = false) {
        guard case let .needLogin(url, name, _) = auth else { return }
        Task {
            do {
                let resp = try await api.login(username, password)
                if remember {
                    RememberedLogin.save(username: username, password: password, for: url)
                } else {
                    RememberedLogin.clear(for: url)
                }
                finishSignIn(url: url, name: name, resp: resp)
            } catch {
                auth = .needLogin(serverURL: url, serverName: name, error: error.localizedDescription)
            }
        }
    }

    /// A saved username/password for this server, if "Remember me" was
    /// checked on a previous sign-in — the login screen pre-fills from it.
    func rememberedLogin(for serverURL: String) -> (username: String, password: String)? {
        RememberedLogin.load(for: serverURL)
    }

    func bootstrap(serverName: String, username: String, displayName: String, password: String) {
        guard case let .needLogin(url, _, _) = auth else { return }
        Task {
            do {
                let resp = try await api.bootstrap(BootstrapRequest(serverName: serverName.isEmpty ? nil : serverName,
                                                                    username: username, displayName: displayName, password: password))
                finishSignIn(url: url, name: serverName, resp: resp)
            } catch {
                auth = .needLogin(serverURL: url, serverName: serverName, error: error.localizedDescription)
            }
        }
    }

    private func finishSignIn(url: String, name: String, resp: LoginResponse) {
        api = FamilyAgentAPI(baseURL: url, authToken: resp.token)
        settings.saveSession(serverURL: url, token: resp.token, serverName: name, userName: resp.user.displayName)
        // A real sign-in just succeeded against this address — worth
        // remembering as a one-tap reconnect, since this may be the only way
        // back (an address reachable only over Tailscale can't be rescanned).
        settings.addRecentServer(name: name.isEmpty ? url : name, url: url)
        auth = .authed(resp.user)
        Task { await refreshStatus(); await refreshChannels(); await openMostRecentChatSession() }
    }

    func signOut() {
        Task { await api.logout() }
        settings.clearSession()
        auth = .pickServer
        chatMessages = []
        channels = []
        tasks = []
        documents = []
    }

    /// Intercepts a 401 anywhere and bounces to sign-in. Mirrors `AppViewModel.apiCall`.
    @discardableResult
    func perform<T>(_ op: () async throws -> T) async -> T? {
        do {
            return try await op()
        } catch APIError.unauthorized {
            settings.clearSession()
            if case .authed = auth {
                auth = .needLogin(serverURL: serverURL, serverName: settings.session?.serverName ?? "", error: "Your session expired — sign in again.")
            }
            return nil
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    // MARK: - Status / health

    func refreshStatus() async {
        connection = .connecting
        do {
            let h = try await api.health()
            connection = .connected(model: h.model)
            voiceEnabled = h.asrEnabled
            ttsEnabled = h.ttsEnabled
            routinesEnabled = h.routinesEnabled
            skillsMode = h.skills
            mcpMode = h.mcp
            vaultMode = h.vault
            vaultAiEnabled = h.vaultAi
            cardsMode = h.cards
            artifactsMode = h.artifacts
            semanticSearchEnabled = h.semanticSearch == "on"
            toolsMode = h.toolsEnabled
            toolsPort = h.toolsPort
            if let host = URL(string: serverURL)?.host {
                let scheme = URL(string: serverURL)?.scheme ?? "http"
                toolsBaseURL = "\(scheme)://\(host):\(h.toolsPort)"
            }
        } catch {
            connection = .unreachable(error.localizedDescription)
        }
    }
}
