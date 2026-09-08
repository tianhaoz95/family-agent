import SwiftUI

struct ToolsView: View {
    @Environment(AppModel.self) private var model
    @State private var prompt = ""
    @State private var openURL: IdentURL?

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Tools", subtitle: "Ask the agent to build a small web tool to help finish a task \u{2014} generated and run locally.") {
                VStack(alignment: .leading, spacing: 12) {
                    AppCard {
                        TextField("e.g. a chore chart for the kids", text: $prompt, axis: .vertical)
                            .lineLimit(1...4)
                            .textFieldStyle(.roundedBorder)
                        Button {
                            model.buildTool(prompt); prompt = ""
                        } label: {
                            Label("Build", systemImage: "hammer")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(prompt.trimmingCharacters(in: .whitespaces).isEmpty)
                        if let s = model.toolStatus {
                            Text(s).appLabelSmall().foregroundStyle(Theme.textMuted)
                        }
                    }

                    if model.tools.isEmpty {
                        EmptyState(text: "No tools yet. Describe one above, or ask in Chat (\u{201C}build me a\u{2026}\u{201D}).", systemImage: "wrench.and.screwdriver")
                    } else {
                        ForEach(model.tools) { tool in
                            AppCard {
                                HStack {
                                    Text(tool.name).appTitleSmall()
                                    Spacer()
                                    Chip(text: tool.status,
                                         color: tool.status == "ready" ? Theme.ok :
                                                tool.status == "failed" ? Theme.danger : Theme.warn)
                                }
                                if !tool.description.isEmpty {
                                    Text(tool.description).appBodySmall().foregroundStyle(Theme.textBody)
                                }
                                if let err = tool.error, tool.status == "failed" {
                                    Text(err).appLabelSmall().foregroundStyle(Theme.danger).lineLimit(3)
                                }
                                HStack {
                                    if tool.status == "ready", let base = model.toolsBaseURL,
                                       let u = URL(string: "\(base)/\(tool.id)/") {
                                        Button("Open") { openURL = IdentURL(u) }
                                    }
                                    Spacer()
                                    Button("Delete", role: .destructive) { model.deleteTool(tool.id) }
                                        .font(.inter(13))
                                }
                                .padding(.top, 4)
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
