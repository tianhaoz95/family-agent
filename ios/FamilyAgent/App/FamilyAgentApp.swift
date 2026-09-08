import SwiftUI
import MarkdownUI

@main
struct FamilyAgentApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

private struct ContentView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Family Agent")
                .font(.custom("Inter", size: 28).weight(.semibold))
            Markdown("iOS skeleton — **build OK**.")
        }
        .padding()
    }
}
