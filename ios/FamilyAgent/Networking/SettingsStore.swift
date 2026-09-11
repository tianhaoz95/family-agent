import Foundation

/// Persisted session + client-local preferences — the iOS mirror of
/// `android/.../data/SettingsStore.kt`. Server URL + names in `UserDefaults`,
/// the bearer token in the Keychain.
struct SettingsStore {
    private let defaults = UserDefaults.standard
    private static let tokenAccount = "session"

    private enum K {
        static let serverURL = "server_url"
        static let serverName = "server_name"
        static let userName = "user_display_name"
        static let taskView = "task_view"
        static let autoRead = "auto_read_replies"
        static let micOnLeft = "mic_button_on_left"
        static let notifyOnReply = "notify_on_reply"
        static let recentServers = "recent_servers"
    }

    struct Session {
        var serverURL: String
        var token: String
        var serverName: String
        var userName: String
    }

    /// A server this device has successfully connected to before — shown on
    /// the discovery screen as a one-tap reconnect. This is what makes a
    /// Tailscale (or any off-LAN) address usable at all after the first time:
    /// Bonjour/mDNS can't find it again on its own (multicast doesn't cross
    /// a tailnet), so remembering it here is the fix, not a better scan.
    struct RecentServer: Codable, Identifiable, Equatable {
        var name: String
        var url: String
        var id: String { url }
    }

    /// Most-recently-used first, deduped by URL, capped at 5.
    var recentServers: [RecentServer] {
        get {
            guard let data = defaults.data(forKey: K.recentServers),
                  let list = try? JSONDecoder().decode([RecentServer].self, from: data) else { return [] }
            return list
        }
        nonmutating set {
            guard let data = try? JSONEncoder().encode(Array(newValue.prefix(5))) else { return }
            defaults.set(data, forKey: K.recentServers)
        }
    }

    func addRecentServer(name: String, url: String) {
        var list = recentServers
        list.removeAll { $0.url == url }
        list.insert(RecentServer(name: name, url: url), at: 0)
        recentServers = list
    }

    var session: Session? {
        guard let url = defaults.string(forKey: K.serverURL),
              let token = Keychain.get(account: Self.tokenAccount) else { return nil }
        return Session(
            serverURL: url,
            token: token,
            serverName: defaults.string(forKey: K.serverName) ?? "",
            userName: defaults.string(forKey: K.userName) ?? ""
        )
    }

    func saveSession(serverURL: String, token: String, serverName: String, userName: String) {
        defaults.set(serverURL, forKey: K.serverURL)
        defaults.set(serverName, forKey: K.serverName)
        defaults.set(userName, forKey: K.userName)
        Keychain.set(token, account: Self.tokenAccount)
    }

    func clearSession() {
        Keychain.delete(account: Self.tokenAccount)
        defaults.removeObject(forKey: K.userName)
    }

    func setServerURL(_ url: String) { defaults.set(url, forKey: K.serverURL) }
    var serverURL: String { defaults.string(forKey: K.serverURL) ?? "" }

    var taskView: String {
        get {
            let v = defaults.string(forKey: K.taskView) ?? "week"
            return v == "calendar" ? "month" : v
        }
        nonmutating set { defaults.set(newValue, forKey: K.taskView) }
    }

    var autoRead: Bool {
        get { defaults.bool(forKey: K.autoRead) }
        nonmutating set { defaults.set(newValue, forKey: K.autoRead) }
    }

    /// Which side of the composer the hold-to-talk mic sits on. Default `false`
    /// = right (next to Send); `true` puts it left of the text field for
    /// left-handed reach. Device-local, like `autoRead`.
    var micOnLeft: Bool {
        get { defaults.bool(forKey: K.micOnLeft) }
        nonmutating set { defaults.set(newValue, forKey: K.micOnLeft) }
    }

    /// Notify when a reply is ready and you're not looking at it — Chat, or
    /// a family channel's @agent reply. Default true (unlike autoRead/
    /// micOnLeft, which default off): the actual OS notification permission
    /// is requested separately (once at app start, and again from this
    /// toggle if it's still missing), so this alone can't surprise anyone
    /// with a system prompt. Device-local, survives sign-out.
    var notifyOnReply: Bool {
        get { defaults.object(forKey: K.notifyOnReply) == nil ? true : defaults.bool(forKey: K.notifyOnReply) }
        nonmutating set { defaults.set(newValue, forKey: K.notifyOnReply) }
    }
}
