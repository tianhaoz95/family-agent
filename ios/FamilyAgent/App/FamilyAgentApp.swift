import SwiftUI

@main
struct FamilyAgentApp: App {
    @State private var model = AppModel()
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                // The whole design system is light-only (Theme.swift, DESIGN.md).
                // Without this, a device in Dark Mode gets white system label
                // colour inside our pale-paper fields — invisible typed text.
                .preferredColorScheme(.light)
                .task { await model.restoreSession() }
                .task { ReplyNotifications.requestPermissionIfNeeded() }
                // AppDelegate can't reach `model` directly (it's constructed
                // before the environment exists), so a tapped notification's
                // target is relayed here instead.
                .onChange(of: appDelegate.pendingNav) { _, nav in
                    guard let nav else { return }
                    model.pendingNotificationNav = nav
                    appDelegate.pendingNav = nil
                }
        }
    }
}
