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
