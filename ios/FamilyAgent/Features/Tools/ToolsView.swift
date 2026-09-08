import SwiftUI

struct ToolsView: View {
    @Environment(AppModel.self) private var model
    @State private var prompt = ""
    @State private var openURL: IdentURL?

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Tools", subtitle: "Ask the agent to build a small web tool to help finish a task \u{2014} generated and run locally.") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        TextField("e.g. split our vacation budget 4 ways", text: $prompt)
                            .textFieldStyle(.app)
                        Button("Build") {
                            guard !prompt.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                            model.buildTool(prompt); prompt = ""
                        }
                        .buttonStyle(.primary)
                    }
                    if let s = model.toolStatus {
                        Text(s).appLabelSmall().foregroundStyle(Theme.textMuted)
                    }

                    if model.tools.isEmpty {
                        EmptyState(text: "No tools yet. Describe one above, or ask in Chat (\u{201C}build me a\u{2026}\u{201D}).", systemImage: "wrench.and.screwdriver")
                    } else {
                        ForEach(model.tools) { tool in
                            AppCard {
                                HStack(spacing: 6) {
                                    Text(tool.name).appTitleSmall().lineLimit(1)
                                    Spacer()
                                    if tool.kind == "server" { Chip(text: "shared") }
                                    Button { model.deleteTool(tool.id) } label: {
                                        Image(systemName: "trash").font(.system(size: 15)).foregroundStyle(Theme.textMuted)
                                    }.buttonStyle(.plain)
                                }
                                Spacer().frame(height: 4)
                                Text(tool.description).appBodySmall().foregroundStyle(Theme.textMuted)
                                Spacer().frame(height: 10)
                                switch tool.status {
                                case "building":
                                    HStack(spacing: 8) {
                                        ProgressView().controlSize(.mini)
                                        Text("Building…").appBody().foregroundStyle(Theme.textMuted)
                                    }
                                case "failed":
                                    Text(tool.error.map { "Failed: \($0)" } ?? "Build failed.")
                                        .appBody().foregroundStyle(Theme.danger)
                                default:
                                    if let base = model.toolsBaseURL, let path = tool.path,
                                       let u = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) {
                                        // Ghost, not primary: the screen's one filled
                                        // accent is "Build" up top (DESIGN.md — one
                                        // filled pill per screen).
                                        Button { openURL = IdentURL(u) } label: {
                                            Label("Open", systemImage: "arrow.up.forward.app")
                                        }
                                        .buttonStyle(.ghost)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .task { await model.refreshTools() }
        .task {
            while !Task.isCancelled {
                if model.tools.contains(where: { $0.status == "building" || $0.status == "pending" }) {
                    try? await Task.sleep(for: .seconds(4))
                    await model.refreshTools()
                } else {
                    try? await Task.sleep(for: .seconds(4))
                }
            }
        }
        .fullScreenCover(item: $openURL) { wrapped in
            ToolWebView(url: wrapped.url) { openURL = nil }
        }
    }
}

struct IdentURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
    init(_ url: URL) { self.url = url }
}
