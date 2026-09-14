import SwiftUI

@main
struct FamilyAgentWatchApp: App {
    @State private var bridge = WatchBridge()

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                SessionsView()
            }
            .environment(bridge)
            .task { bridge.start() }
        }
    }
}
