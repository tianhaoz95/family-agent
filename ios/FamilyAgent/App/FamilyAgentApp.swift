import SwiftUI

@main
struct FamilyAgentApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task { await model.restoreSession() }
        }
    }
}
