import SwiftUI

enum Destination: String, CaseIterable, Identifiable, Hashable {
    case chat, messages, events, board, documents, tools, routines, skills, connections, vault, activity, settings
    var id: String { rawValue }

    var label: String {
        switch self {
        case .chat: "Chat"; case .messages: "Messages"; case .events: "Events"
        case .board: "Board"; case .documents: "Documents"; case .tools: "Tools"
        case .routines: "Routines"; case .skills: "Skills"; case .connections: "Connections"
        case .vault: "Vault"; case .activity: "Activity"; case .settings: "Settings"
        }
    }
    var systemImage: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .messages: "text.bubble"
        case .events: "checkmark.circle"
        case .board: "square.grid.2x2"
        case .documents: "doc.text"
        case .tools: "wrench.and.screwdriver"
        case .routines: "clock.arrow.circlepath"
        case .skills: "graduationcap"
        case .connections: "point.3.connected.trianglepath.dotted"
        case .vault: "lock"
        case .activity: "clock"
        case .settings: "gearshape"
        }
    }
}

struct MainShell: View {
    @Environment(AppModel.self) private var model
    @State private var selection: Destination? = .chat
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic

    private var visibleDestinations: [Destination] {
        Destination.allCases.filter { d in
            switch d {
            case .routines: return model.routinesEnabled
            case .skills: return model.skillsMode != "off"
            case .connections: return model.mcpMode != "off" && model.isAdmin
            case .vault: return model.vaultMode == "on"
            default: return true
            }
        }
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: $selection) {
                ForEach(visibleDestinations) { d in
                    NavigationLink(value: d) {
                        Label(d.label, systemImage: d.systemImage)
                            .badge(d == .messages ? model.totalUnread : 0)
                    }
                    .listRowBackground(selection == d ? Theme.accentSoft : Color.clear)
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .navigationTitle("Family Agent")
            .tint(Theme.accent)
        } detail: {
            NavigationStack {
                destinationView(selection ?? .chat)
                    .navigationBarTitleDisplayMode(.inline)
            }
        }
        .navigationSplitViewStyle(.balanced)
        .task { await model.refreshStatus() }
        .task {
            // channel-list poll (unread badge + previews)
            while !Task.isCancelled {
                await model.refreshChannels()
                try? await Task.sleep(for: .seconds(8))
            }
        }
        .overlay(alignment: .bottom) {
            if let err = model.lastError {
                Text(err)
                    .appBodySmall()
                    .padding(10)
                    .background(Theme.dangerSoft, in: Capsule())
                    .foregroundStyle(Theme.dangerInk)
                    .padding(.bottom, 24)
                    .task {
                        try? await Task.sleep(for: .seconds(4))
                        model.lastError = nil
                    }
            }
        }
    }

    @ViewBuilder
    private func destinationView(_ d: Destination) -> some View {
        switch d {
        case .chat:        ChatView()
        case .messages:    MessagesView()
        case .events:      TasksView()
        case .board:       BoardView()
        case .documents:   DocumentsView()
        case .tools:       ToolsView()
        case .routines:    RoutinesView()
        case .skills:      SkillsView()
        case .connections: ConnectionsView()
        case .vault:       VaultView()
        case .activity:    ActivityView()
        case .settings:    SettingsView()
        }
    }
}
