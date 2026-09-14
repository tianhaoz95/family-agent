import Foundation
import WatchConnectivity

/// The watch side of the phone<->watch relay — the WatchOS counterpart of
/// Android's `wear/WearBridge.kt`. Foreground-only by design (a plain
/// `@Observable` object the views read while on screen), same simplification
/// Android made: this v1 scope doesn't need the watch to receive chat
/// updates while its own UI isn't active.
///
/// Outbound calls (`openSession`/`newSession`/`sendText`/`sendVoice`) are
/// fire-and-forget `sendMessage`s — no reply is awaited; the actual result
/// comes back asynchronously via `applicationContext`, since a chat turn can
/// run far longer than a message's own delivery window and the round trip
/// needs to survive the watch screen sleeping/waking in between.
@MainActor
@Observable
final class WatchBridge: NSObject {
    private(set) var sessions: [WatchChatSession] = []
    private(set) var current: WatchCurrentSessionPayload?
    private(set) var phoneReachable = false

    private let session: WCSession? = WCSession.isSupported() ? .default : nil
    private let decoder = JSONDecoder()

    func start() {
        guard let session else { return }
        session.delegate = self
        session.activate()
    }

    /// Ask the phone to push the sessions list again right now — see
    /// `WatchPath.listSessions`'s doc comment for why this is needed at all.
    /// Safe to call freely (e.g. every time the sessions screen appears): a
    /// no-op message with no state of its own.
    func refreshSessions() {
        send(["path": WatchPath.listSessions])
    }

    func openSession(_ id: String) {
        send([
            "path": WatchPath.openSession,
            "sessionId": id,
        ])
    }

    func newSession() {
        send(["path": WatchPath.newSession])
    }

    func sendText(_ text: String) {
        guard !text.isEmpty else { return }
        send([
            "path": WatchPath.sendMessage,
            "text": text,
        ])
    }

    func sendVoice(_ wav: Data) {
        guard !wav.isEmpty else { return }
        send([
            "path": WatchPath.sendVoice,
            "wav": wav,
        ])
    }

    private func send(_ message: [String: Any]) {
        guard let session, session.isReachable else {
            phoneReachable = false
            return
        }
        session.sendMessage(message, replyHandler: nil) { [weak self] _ in
            Task { @MainActor in self?.phoneReachable = false }
        }
    }

    private func applyContext(sessionsData: Data?, currentData: Data?) {
        if let sessionsData, let payload = try? decoder.decode(WatchSessionsPayload.self, from: sessionsData) {
            sessions = payload.sessions
        }
        if let currentData, let payload = try? decoder.decode(WatchCurrentSessionPayload.self, from: currentData) {
            current = payload
        }
    }
}

extension WatchBridge: WCSessionDelegate {
    // Swift 6 strict concurrency: `WCSession`/`[String: Any]` aren't safely
    // `Sendable`, so each delegate callback (called on an arbitrary queue,
    // hence `nonisolated`) pulls out only the plain, Sendable values it needs
    // — a `Bool`, a couple of `Data?` — before hopping to the main actor,
    // rather than sending the session or the raw dictionary across.
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {
        let reachable = session.isReachable
        let context = session.receivedApplicationContext
        let sessionsData = context["sessions"] as? Data
        let currentData = context["current"] as? Data
        Task { @MainActor in
            self.phoneReachable = reachable
            self.applyContext(sessionsData: sessionsData, currentData: currentData)
            // The catch-up read above (`receivedApplicationContext`) only
            // has something if the phone already pushed a "sessions" entry
            // at some point — ask for a fresh one regardless, same reasoning
            // as `refreshSessions()`'s doc comment.
            if reachable { self.refreshSessions() }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let sessionsData = applicationContext["sessions"] as? Data
        let currentData = applicationContext["current"] as? Data
        Task { @MainActor in self.applyContext(sessionsData: sessionsData, currentData: currentData) }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reachable = session.isReachable
        Task { @MainActor in
            self.phoneReachable = reachable
            // The phone may have just become reachable after the watch's
            // very first request silently no-op'd (send() requires
            // isReachable) — retry now that it's true.
            if reachable { self.refreshSessions() }
        }
    }
}
