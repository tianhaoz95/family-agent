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
    var semanticSearchEnabled = true
    var toolsMode = "off"
    var toolsPort = 4174

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
    var autoRead: Bool {
        get { settings.autoRead }
        set { settings.autoRead = newValue }
    }

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
    var taskView: String {
        get { settings.taskView }
        set { settings.taskView = newValue }
    }
    var calAnchor: Date = Calendar.gregorianMonday.startOfDay(for: .now)

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
        if let s = settings.session {
            serverURL = s.serverURL
            api = FamilyAgentAPI(baseURL: s.serverURL, authToken: s.token)
            do {
                let user = try await api.me()
                auth = .authed(user)
                await refreshStatus()
                await refreshChannels()
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

    func backToServerPick() { auth = .pickServer }

    func login(username: String, password: String) {
        guard case let .needLogin(url, name, _) = auth else { return }
        Task {
            do {
                let resp = try await api.login(username, password)
                finishSignIn(url: url, name: name, resp: resp)
            } catch {
                auth = .needLogin(serverURL: url, serverName: name, error: error.localizedDescription)
            }
        }
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
        auth = .authed(resp.user)
        Task { await refreshStatus(); await refreshChannels() }
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
            if case let .authed = auth {
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
