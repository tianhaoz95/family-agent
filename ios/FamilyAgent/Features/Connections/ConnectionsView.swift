import SwiftUI

struct ConnectionsView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: McpServer?
    @State private var confirmDelete: McpServer?

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Connections", subtitle: "External services (MCP) the assistant can call. Their results are treated as information only, never as instructions.") {
                VStack(alignment: .leading, spacing: 12) {
                    Button("Add connection") {
                        editing = McpServer(name: "", transport: "http", enabled: true)
                    }
                    .buttonStyle(.borderedProminent)

                    if let s = model.mcpStatus {
                        Text(s).appLabelSmall().foregroundStyle(Theme.textMuted)
                    }

                    if model.mcpServers.isEmpty {
                        EmptyState(text: "No connections yet.", systemImage: "point.3.connected.trianglepath.dotted")
                    } else {
                        ForEach(model.mcpServers) { server in
                            AppCard {
                                HStack(spacing: 10) {
                                    Toggle("", isOn: Binding(
                                        get: { server.enabled },
                                        set: { model.setMcpServerEnabled(server.name, $0) }
                                    )).labelsHidden()
                                    Text(server.name).appTitle().lineLimit(1)
                                    Spacer()
                                    Text(server.transport).appLabelSmall().foregroundStyle(Theme.textMuted)
                                }
                                Spacer().frame(height: 6)
                                Text(server.transport == "http"
                                     ? (server.url ?? "")
                                     : ([server.command].compactMap { $0 } + (server.args ?? [])).joined(separator: " "))
                                    .appBodySmall().foregroundStyle(Theme.textMuted).lineLimit(1)
                                Spacer().frame(height: 8)
                                HStack {
                                    Button("Test") { model.probeMcpServer(server.name) }.font(.inter(13))
                                    Button("Edit") { editing = server }.font(.inter(13))
                                    Spacer()
                                    Button("Remove", role: .destructive) { confirmDelete = server }.font(.inter(13))
                                }
                            }
                        }
                    }
                }
            }
        }
        .task { await model.refreshConnections() }
        .sheet(item: $editing) { McpEditor(server: $0) }
        .alert("Remove connection?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button("Remove", role: .destructive) {
                if let s = confirmDelete { model.deleteMcpServer(s.name) }
                confirmDelete = nil
            }
            Button("Cancel", role: .cancel) { confirmDelete = nil }
        } message: {
            Text("\u{201C}\(confirmDelete?.name ?? "")\u{201D} will be disconnected.")
        }
    }
}

private struct McpEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let server: McpServer

    @State private var name = ""
    @State private var transport = "http"
    @State private var url = ""
    @State private var command = ""
    @State private var headersText = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name).autocorrectionDisabled()
                Picker("Transport", selection: $transport) {
                    Text("HTTP").tag("http")
                    Text("stdio").tag("stdio")
                }
                .pickerStyle(.segmented)
                if transport == "http" {
                    TextField("https://…", text: $url)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Section("Headers (Name: value per line)") {
                        TextEditor(text: $headersText).frame(minHeight: 80)
                            .font(.system(.footnote, design: .monospaced))
                    }
                } else {
                    TextField("command …args", text: $command).autocorrectionDisabled()
                }
            }
            .navigationTitle(server.name.isEmpty ? "New connection" : server.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var headers: [String: String] = [:]
                        for line in headersText.split(separator: "\n") {
                            let parts = line.split(separator: ":", maxSplits: 1)
                            if parts.count == 2 {
                                headers[parts[0].trimmingCharacters(in: .whitespaces)] =
                                    parts[1].trimmingCharacters(in: .whitespaces)
                            }
                        }
                        let cmd = command.split(separator: " ").map(String.init)
                        model.saveMcpServer(McpServer(
                            name: name, transport: transport, enabled: true,
                            url: transport == "http" ? url : nil,
                            headers: headers.isEmpty ? nil : headers,
                            command: transport == "stdio" ? cmd.first : nil,
                            args: transport == "stdio" && cmd.count > 1 ? Array(cmd.dropFirst()) : nil
                        ))
                        dismiss()
                    }
                    .disabled(name.isEmpty)
                }
            }
            .onAppear {
                name = server.name
                transport = server.transport
                url = server.url ?? ""
                command = ([server.command].compactMap { $0 } + (server.args ?? [])).joined(separator: " ")
                headersText = (server.headers ?? [:]).map { "\($0): \($1)" }.joined(separator: "\n")
            }
        }
    }
}
