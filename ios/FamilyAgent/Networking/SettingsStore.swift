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
    }

    struct Session {
        var serverURL: String
        var token: String
        var serverName: String
        var userName: String
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
}
