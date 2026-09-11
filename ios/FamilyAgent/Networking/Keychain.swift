import Foundation
import Security

/// Tiny wrapper over the login keychain for the session bearer token.
enum Keychain {
    private static let service = "app.familyagent.ios"

    static func set(_ value: String, account: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = data
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attrs as CFDictionary, nil)
    }

    static func get(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// "Remember me" on the login screen — a username + password saved in the
/// Keychain (never UserDefaults/plist), keyed per server address so switching
/// servers doesn't leak one home's saved login into another's fields. Mirrors
/// Android's `SettingsStore.rememberedLogin` (plain DataStore there, same
/// trust boundary as the session token already stored in it — this is a
/// per-platform convenience, not a shared security guarantee). Distinct from
/// the session bearer token above: this is what refills the sign-in form
/// itself, not what keeps you signed in.
enum RememberedLogin {
    private struct Saved: Codable {
        let username: String
        let password: String
    }

    private static func account(for serverURL: String) -> String { "login:\(serverURL)" }

    static func save(username: String, password: String, for serverURL: String) {
        guard let data = try? JSONEncoder().encode(Saved(username: username, password: password)) else { return }
        Keychain.set(String(decoding: data, as: UTF8.self), account: account(for: serverURL))
    }

    static func load(for serverURL: String) -> (username: String, password: String)? {
        guard let raw = Keychain.get(account: account(for: serverURL)),
              let saved = try? JSONDecoder().decode(Saved.self, from: Data(raw.utf8)) else { return nil }
        return (saved.username, saved.password)
    }

    static func clear(for serverURL: String) {
        Keychain.delete(account: account(for: serverURL))
    }
}
