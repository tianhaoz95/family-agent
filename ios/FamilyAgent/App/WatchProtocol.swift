import Foundation

/// Wire contract for the phone<->watch relay — hand-mirrored copy of the
/// canonical `FamilyAgentWatch/WatchProtocol.swift` (the watch target), kept
/// in sync by hand like every other cross-client wire type in this codebase
/// (`DTOs.swift` vs. `ApiModels.kt`, etc.). See that file for the full
/// transport explanation. Used by `PhoneWatchBridge.swift`.
enum WatchPath {
    static let openSession = "open_session"
    static let newSession = "new_session"
    static let sendMessage = "send_message"
    static let sendVoice = "send_voice"
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
