import SwiftUI

@main
struct FamilyAgentApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                // The whole design system is light-only (Theme.swift, DESIGN.md).
                // Without this, a device in Dark Mode gets white system label
                // colour inside our pale-paper fields — invisible typed text.
                .preferredColorScheme(.light)
                .task { await model.restoreSession() }
        }
    }
}
