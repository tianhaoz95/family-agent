import Foundation
import WatchConnectivity

/// The phone side of the phone<->watch relay — the iOS counterpart of
/// Android's `PhoneWearListenerService`. A standalone `WCSessionDelegate`,
/// not routed through `AppModel`: a message from the watch is handled the
/// same way regardless of whether the app's own UI is on screen, by reading
/// the signed-in session straight out of `SettingsStore` and making a
/// short-lived `FamilyAgentAPI` call — the same thing `AppModel` would do,
/// just without an `@Observable`/SwiftUI view anywhere in the path.
///
/// `WCSession.default.delegate` must be set before `activate()`, and as
/// early as possible (`FamilyAgentApp.init`) — a message that arrives before
/// activation completes is simply dropped by WatchConnectivity, not queued.
@MainActor
final class PhoneWatchBridge: NSObject {
    static let shared = PhoneWatchBridge()

    /// Mirrors `SettingsStore.wearSessionId` on Android — which chat session
    /// the watch's composer currently has open. Kept here (not re-derived
    /// from the watch's last message) since a `sendMessage` for "send text"
    /// carries no session id of its own; the last `openSession`/`newSession`
    /// call is what pins it.
    private var currentSessionID: String?
    private var lastKnownMessages: [WatchChatMessage] = []

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private func api() -> FamilyAgentAPI? {
        guard let session = SettingsStore().session else { return nil }
        return FamilyAgentAPI(baseURL: session.serverURL, authToken: session.token)
    }

    private func syncCurrentSession(_ sessionID: String) async {
        guard let api = api() else {
            push(current: WatchCurrentSessionPayload(sessionID: sessionID, messages: [], error: "Not signed in on the phone."))
            return
        }
        do {
            let messages = try await api.chatSessionMessages(sessionID)
            push(current: WatchCurrentSessionPayload(sessionID: sessionID, messages: messages.map(WatchChatMessage.init)))
        } catch {
            push(current: WatchCurrentSessionPayload(sessionID: sessionID, messages: [], error: "Couldn't reach the server."))
        }
        await pushSessions()
    }

    private func sendAndSync(_ text: String) async {
        guard let api = api() else {
            push(current: WatchCurrentSessionPayload(sessionID: currentSessionID, messages: [], error: "Not signed in on the phone."))
            return
        }
        // Optimistic: show the user's own line immediately.
        let optimistic = lastKnownMessages + [WatchChatMessage(id: "pending", role: "user", body: text, createdAt: "")]
        push(current: WatchCurrentSessionPayload(sessionID: currentSessionID, messages: optimistic, sending: true))
        do {
            let resp = try await api.chat(text, sessionId: currentSessionID)
            currentSessionID = resp.sessionId
            await syncCurrentSession(resp.sessionId)
        } catch {
            push(current: WatchCurrentSessionPayload(
                sessionID: currentSessionID, messages: lastKnownMessages, sending: false, error: "Couldn't send — try again."
            ))
        }
    }

    private func sendVoiceAndSync(_ wav: Data) async {
        guard let api = api() else { return }
        guard let transcript = try? await api.transcribe(wav).text, !transcript.isEmpty else { return }
        await sendAndSync(transcript)
    }

    private func push(current: WatchCurrentSessionPayload) {
        lastKnownMessages = current.messages
        guard let data = try? JSONEncoder().encode(current) else { return }
        applyContext(["current": data])
    }

    private func pushSessions() async {
        guard let api = api() else { return }
        guard let sessions = try? await api.listChatSessions() else { return }
        let payload = WatchSessionsPayload(sessions: sessions.map(WatchChatSession.init))
        guard let data = try? JSONEncoder().encode(payload) else { return }
        applyContext(["sessions": data])
    }

    /// `updateApplicationContext` replaces the whole dictionary, so a partial
    /// update (just "current", or just "sessions") has to be merged onto
    /// whatever was there before rather than clobbering the other half.
    private func applyContext(_ partial: [String: Data]) {
        guard WCSession.default.activationState == .activated else { return }
        var merged = WCSession.default.applicationContext
        for (key, value) in partial { merged[key] = value }
        try? WCSession.default.updateApplicationContext(merged)
    }
}

extension PhoneWatchBridge: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {}
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }

    // Swift 6 strict concurrency: `[String: Any]` isn't safely `Sendable`, so
    // this `nonisolated` callback (WatchConnectivity calls it on an arbitrary
    // queue) pulls out only the plain, Sendable fields it needs before
    // hopping to the main actor, rather than sending the raw dictionary
    // across — same fix as `WatchBridge.swift` on the watch target.
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let path = message["path"] as? String else { return }
        let sessionId = message["sessionId"] as? String
        let text = message["text"] as? String
        let wav = message["wav"] as? Data
        Task { @MainActor in
            switch path {
            case WatchPath.openSession:
                guard let sessionId else { return }
                currentSessionID = sessionId
                await syncCurrentSession(sessionId)
            case WatchPath.newSession:
                currentSessionID = nil
                push(current: WatchCurrentSessionPayload(sessionID: nil, messages: []))
            case WatchPath.sendMessage:
                guard let text, !text.isEmpty else { return }
                await sendAndSync(text)
            case WatchPath.sendVoice:
                guard let wav, !wav.isEmpty else { return }
                await sendVoiceAndSync(wav)
            default:
                break
            }
        }
    }
}

private extension WatchChatMessage {
    init(_ m: ChatSessionMessage) {
        self.init(id: m.id, role: m.role, body: m.body, createdAt: m.createdAt)
    }
}

private extension WatchChatSession {
    init(_ s: ChatSession) {
        self.init(id: s.id, title: s.title, updatedAt: s.updatedAt, lastMessage: s.lastMessage)
    }
}
