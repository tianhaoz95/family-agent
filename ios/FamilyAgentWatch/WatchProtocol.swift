import Foundation

/// Wire contract for the phone<->watch relay over `WatchConnectivity` — the
/// counterpart of Android's `wear/WearProtocol.kt`. This copy is canonical;
/// `FamilyAgent/App/WatchProtocol.swift` (the phone target) is a hand-mirrored
/// duplicate for `PhoneWatchBridge.swift` — same no-shared-code discipline as
/// the rest of the codebase, just within one Xcode project instead of across
/// repos (the two targets don't share a framework).
///
/// Watch -> phone is a `sendMessage` dictionary with a `"path"` discriminator
/// (no reply expected — a result comes back asynchronously via
/// `applicationContext`, not the reply handler, since a chat turn can take
/// far longer than `sendMessage`'s delivery window). Phone -> watch is always
/// `updateApplicationContext` ("current" / "sessions" keys, each raw JSON
/// `Data` from `WatchCurrentSessionPayload` / `WatchSessionsPayload`) — "last
/// write wins", durable across a watch reconnect, exactly like Android's
/// `DataClient`.
enum WatchPath {
    static let openSession = "open_session"
    static let newSession = "new_session"
    static let sendMessage = "send_message"
    static let sendVoice = "send_voice"
    /// Watch -> phone, empty payload: ask the phone to push the sessions
    /// list again right now. `applicationContext` is "last write wins" —
    /// the watch only ever sees a "sessions" entry if the phone has already
    /// pushed one, which used to happen only as a side effect of opening or
    /// sending from the watch. A fresh watch launch with no prior watch
    /// activity (the common case — real chat history already exists on the
    /// phone) had nothing to catch up to and showed an empty list.
    static let listSessions = "list_sessions"
}

struct WatchChatSession: Codable, Identifiable, Hashable {
    let id: String
    var title: String
    var updatedAt: String
    var lastMessage: String?
}

struct WatchChatMessage: Codable, Identifiable, Hashable {
    let id: String
    let role: String
    let body: String
    let createdAt: String
}

struct WatchSessionsPayload: Codable {
    var sessions: [WatchChatSession]
}

struct WatchCurrentSessionPayload: Codable {
    var sessionID: String?
    var messages: [WatchChatMessage]
    var sending: Bool = false
    var error: String?
}
