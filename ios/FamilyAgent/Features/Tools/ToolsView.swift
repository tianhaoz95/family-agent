import SwiftUI

struct ToolsView: View {
    @Environment(AppModel.self) private var model
    @State private var prompt = ""
    @State private var openURL: IdentURL?
    @State private var openDbTool: Tool?

    var body: some View {
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
                        ToolCard(tool: tool, openURL: $openURL, openDbTool: $openDbTool)
                    }
                }
            }
        }
        .task { await model.refreshTools() }
        .task {
            while !Task.isCancelled {
                if model.tools.contains(where: { $0.status == "building" || $0.status == "pending" || $0.revisionState == "revising" }) {
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
        .navigationDestination(item: $openDbTool) { tool in
            ToolDatabaseView(tool: tool)
        }
    }
}

private struct ToolCard: View {
    let tool: Tool
    @Environment(AppModel.self) private var model
    @Binding var openURL: IdentURL?
    @Binding var openDbTool: Tool?
    @State private var improving = false
    // What the chat assistant can actually do with this tool — fetched once
    // per ready tool (its operations don't change without an improve, which
    // already re-keys this `.task(id:)` via revisionCount below).
    @State private var operationPhrases: [String] = []

    private var revising: Bool { tool.revisionState == "revising" }

    var body: some View {
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
                    Text(tool.revisionCount > 0 ? "Rebuilding\u{2026}" : "Building\u{2026}").appBody().foregroundStyle(Theme.textMuted)
                }
            case "failed":
                Text(tool.error.map { "Failed: \($0)" } ?? "Build failed.")
                    .appBody().foregroundStyle(Theme.danger)
                Spacer().frame(height: 8)
                if improving {
                    ImproveField(label: "What should be different? e.g. \u{201C}the total is wrong\u{201D}") { instruction in
                        model.iterateTool(tool.id, instruction: instruction)
                        improving = false
                    }
                } else {
                    Button("Fix it") { improving = true }.buttonStyle(.soft)
                }
            default:
                HStack(spacing: 8) {
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
                    Button { openDbTool = tool } label: {
                        Label(tool.kind == "server" ? "Inspect data" : "View saved data", systemImage: "cylinder.split.1x2")
                    }
                    .buttonStyle(.soft)
                }
                Spacer().frame(height: 8)
                if revising {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.mini)
                        Text("Improving\u{2026}").appBody().foregroundStyle(Theme.textMuted)
                    }
                } else if improving {
                    ImproveField(label: "What should change? e.g. \u{201C}add a due date to each loan\u{201D}") { instruction in
                        model.iterateTool(tool.id, instruction: instruction)
                        improving = false
                    }
                } else {
                    HStack(spacing: 8) {
                        Button("Improve") { improving = true }.buttonStyle(.soft)
                        if tool.canRevert {
                            Button("Undo last change") { model.revertTool(tool.id) }.buttonStyle(.soft)
                        }
                    }
                }
                // A failed improve: the tool still works, but say the change didn't land.
                if let state = tool.revisionState, !revising {
                    Spacer().frame(height: 6)
                    Text("Last change didn\u{2019}t work: \(state)").appLabelSmall().foregroundStyle(Theme.danger)
                } else if tool.revisionCount > 0 && !revising {
                    Spacer().frame(height: 6)
                    Text("Improved \(tool.revisionCount) time\(tool.revisionCount == 1 ? "" : "s")").appLabelSmall().foregroundStyle(Theme.textMuted)
                }
                // What the assistant can do with this tool without opening
                // it — the same operations the chat agent's call_family_tool
                // sees, in plain language instead of a snake_case name.
                if !operationPhrases.isEmpty {
                    Spacer().frame(height: 10)
                    Text("IN CHAT YOU CAN").font(.inter(11, .bold)).foregroundStyle(Theme.textMuted)
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(operationPhrases, id: \.self) { phrase in
                            Text("\u{2022} \(phrase)").appBodySmall().foregroundStyle(Theme.textMuted)
                        }
                    }
                }
            }
        }
        .task(id: "\(tool.id)-\(tool.status)-\(tool.revisionCount)") {
            guard tool.status == "ready" else { operationPhrases = []; return }
            operationPhrases = await model.loadToolOperations(tool.id).map(humanizeOperation).filter { !$0.isEmpty }
        }
    }
}

/// Turn a tool operation into a plain imperative phrase a family member can
/// read, e.g. { name: "add_loan", description: "Record that someone
/// borrowed an item" } \u{2192} "record that someone borrowed an item". No
/// snake_case, no jargon. Mirrors desktop's own humanizeOperation/OP_VERBS
/// in main.ts.
private let opVerbsRegex = try? NSRegularExpression(
    pattern: "^(record|log|list|show|display|add|create|save|store|mark|remove|delete|update|edit|change|rename|find|"
        + "look up|search|get|see|view|browse|track|check|set|clear|count|split|calculate|total|note|pick|choose|send)\\b",
    options: [.caseInsensitive]
)

private func humanizeOperation(_ o: ToolOperation) -> String {
    var d = o.description.trimmingCharacters(in: .whitespaces)
    if d.hasSuffix(".") { d.removeLast() }
    func lowercasedFirst(_ s: String) -> String { s.isEmpty ? s : s.prefix(1).lowercased() + s.dropFirst() }
    if !d.isEmpty, let regex = opVerbsRegex, regex.firstMatch(in: d, range: NSRange(d.startIndex..., in: d)) != nil {
        return lowercasedFirst(d)
    }
    if !d.isEmpty { return "see \(lowercasedFirst(d))" }
    let name = o.name.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
    if name.isEmpty { return "" }
    return o.access == "read" ? "see \(name)" : name
}

/// "Improve" / "Fix it": an inline text field + Send, same shape desktop's own instruction box has.
private struct ImproveField: View {
    let label: String
    let onSubmit: (String) -> Void
    @State private var instruction = ""

    var body: some View {
        HStack(spacing: 8) {
            TextField(label, text: $instruction).textFieldStyle(.app)
            Button("Send") {
                let t = instruction.trimmingCharacters(in: .whitespaces)
                if t.count >= 3 { onSubmit(t) }
            }
            .buttonStyle(.primary)
            .disabled(instruction.trimmingCharacters(in: .whitespaces).count < 3)
        }
    }
}

struct IdentURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
    init(_ url: URL) { self.url = url }
}
