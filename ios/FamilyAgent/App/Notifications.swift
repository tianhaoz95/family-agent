import UIKit
import UserNotifications

/// Where a tapped "reply is ready" notification wants the app to go.
enum PendingNotificationNav: Equatable {
    case chat(sessionId: String)
    case channel(channelId: String)
}

private enum NotifKey {
    static let kind = "navKind"
    static let id = "navId"
    static let chat = "chat"
    static let channel = "channel"
}

/// Buys a little extra run time after the user switches away from the app,
/// specifically so an in-flight chat/channel turn has a chance to actually
/// finish and post its "reply is ready" notification — without this, a plain
/// `Task` started before backgrounding gets essentially no CPU time at all
/// once the app suspends (typically within a few seconds of leaving it, well
/// short of a real planner turn's ~30-110s+), so the notification code never
/// runs and the user sees nothing until they reopen the app themselves and
/// find it already answered. iOS still caps this at roughly 30s regardless
/// (`beginBackgroundTask`'s own budget, not something this app controls) —
/// enough for a typical turn, not a guarantee for a slow one (a "near me"
/// question that also does a web search, say). There is no stronger
/// mechanism available without a push-notification server relaying from the
/// household's own machine, which this app deliberately doesn't have (see
/// CLAUDE.md — nothing leaves the box except the opt-in web/MCP capabilities,
/// neither of which is "a cloud service this app's own notifications depend
/// on"). See docs/DECISIONS.md → "Chat replies never notified while
/// backgrounded".
@MainActor
enum BackgroundExecution {
    /// Runs `work` with a background task assertion held for its duration —
    /// call this instead of a bare `Task { ... }` for anything that should
    /// keep going, and still be able to post a notification, after the user
    /// backgrounds the app mid-turn.
    static func extend(_ label: String, _ work: @escaping @MainActor () async -> Void) {
        var taskId: UIBackgroundTaskIdentifier = .invalid
        taskId = UIApplication.shared.beginBackgroundTask(withName: label) {
            // The system calls this synchronously on the main thread when
            // time is about to run out — end promptly, don't try to cancel
            // `work` itself (it has no cooperative cancellation to offer,
            // same as the chat turn it's wrapping never having one server-side).
            if taskId != .invalid {
                UIApplication.shared.endBackgroundTask(taskId)
                taskId = .invalid
            }
        }
        // Run `work` regardless of whether the assertion above actually
        // secured background time (it can fail to — too many already held,
        // or the system just declining) — the send has to happen either way;
        // the assertion is purely insurance for the notification afterward.
        Task {
            await work()
            if taskId != .invalid {
                UIApplication.shared.endBackgroundTask(taskId)
                taskId = .invalid
            }
        }
    }
}

/// Posts (and helps navigate from) the "assistant reply is ready" local
/// notification — Chat, or a family channel's @agent reply. The Android
/// counterpart is `ReplyNotifications` in `Notifications.kt`.
enum ReplyNotifications {
    /// Ask once at app start if the OS hasn't recorded an answer yet — never
    /// re-prompts once it has, in either direction.
    static func requestPermissionIfNeeded() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
    }

    /// Explicit request from the Settings toggle — used when the user turns
    /// it on after having said no (or ignored) the app-start ask.
    static func requestPermission(_ completion: @escaping @Sendable (Bool) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async { completion(granted) }
        }
    }

    static func hasPermission(_ completion: @escaping @Sendable (Bool) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let ok = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            DispatchQueue.main.async { completion(ok) }
        }
    }

    private static func post(title: String, body: String, kind: String, id: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        content.body = text.isEmpty ? "New reply ready." : String(text.prefix(200))
        content.userInfo = [NotifKey.kind: kind, NotifKey.id: id]
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    static func postChatReply(sessionId: String, body: String) {
        post(title: "Family Agent", body: body, kind: NotifKey.chat, id: sessionId)
    }

    static func postChannelReply(channelId: String, channelTitle: String, body: String) {
        post(title: channelTitle.isEmpty ? "Family chat" : channelTitle, body: body, kind: NotifKey.channel, id: channelId)
    }

    static func pendingNav(from userInfo: [AnyHashable: Any]) -> PendingNotificationNav? {
        guard let kind = userInfo[NotifKey.kind] as? String, let id = userInfo[NotifKey.id] as? String else { return nil }
        switch kind {
        case NotifKey.chat: return .chat(sessionId: id)
        case NotifKey.channel: return .channel(channelId: id)
        default: return nil
        }
    }
}

/// SwiftUI has no scene-level notification-tap hook of its own — this is the
/// standard bridge: a tiny `UIApplicationDelegate` just to become the
/// `UNUserNotificationCenterDelegate` and hand a tapped notification's target
/// back to `AppModel` (wired in `FamilyAgentApp.swift`).
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate, ObservableObject {
    @Published var pendingNav: PendingNotificationNav?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// Show the banner even while the app is in the foreground — the
    /// "already looking at it" skip happens earlier, when deciding whether
    /// to post at all (see AppModel+Chat.swift / +Messages.swift).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        pendingNav = ReplyNotifications.pendingNav(from: response.notification.request.content.userInfo)
        completionHandler()
    }
}
