import SwiftUI
import MarkdownUI

extension MarkdownUI.Theme {
    /// Warm-paper markdown — Inter body, accent links, sunk code. Block-level
    /// customisation (heading margins etc.) is left at MarkdownUI's defaults:
    /// its `config in config.label…` builders run nonisolated and can't call the
    /// `@MainActor` view modifiers under Swift 6 strict concurrency.
    static var familyAgent: MarkdownUI.Theme {
        MarkdownUI.Theme.gitHub
            .text {
                FontFamily(.custom("Inter"))
                ForegroundColor(Theme.textStrong)
                FontSize(15)
            }
            .code {
                FontFamilyVariant(.monospaced)
                FontSize(13)
                BackgroundColor(Theme.surfaceSunk)
            }
            .strong { FontWeight(.semibold) }
            .link { ForegroundColor(Theme.accent) }
    }
}

/// Convenience: render agent Markdown with the shared theme.
struct AgentMarkdown: View {
    let text: String
    var body: some View {
        Markdown(text)
            .markdownTheme(.familyAgent)
            .textSelection(.enabled)
    }
}
