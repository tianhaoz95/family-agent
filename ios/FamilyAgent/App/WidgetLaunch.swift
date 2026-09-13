import Foundation

/// What the home screen widget was tapped to do — always lands on Chat, and
/// the mic/camera variants additionally auto-trigger that control once the
/// composer is actually on screen (see ChatView's `pendingWidgetAction`
/// handling / HoldToTalkMic's `autoStartToken`). The Android counterpart is
/// `WidgetChatAction` in `Notifications.kt`.
enum WidgetChatAction: String {
    case open, mic, camera
}

/// Parses a `familyagent://chat[?action=mic|camera]` URL — the home screen
/// widget's `Link` buttons open these (see
/// `FamilyAgentWidget/FamilyAgentWidget.swift`); FamilyAgentApp's `onOpenURL`
/// is the only caller. The Android counterpart is `WidgetLaunch` in
/// `Notifications.kt`.
enum WidgetLaunch {
    static func action(from url: URL) -> WidgetChatAction? {
        guard url.scheme == "familyagent", url.host == "chat" else { return nil }
        let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "action" })?.value
        return WidgetChatAction(rawValue: raw ?? "open") ?? .open
    }
}
