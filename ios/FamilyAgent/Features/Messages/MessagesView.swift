import SwiftUI

struct MessagesView: View {
    @Environment(AppModel.self) private var model
    @State private var showNew = false
    @State private var route: String?

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Messages", subtitle: "Talk to the family, or @agent for the assistant.") {
                VStack(alignment: .leading, spacing: 10) {
                    Button { showNew = true } label: { Label("New conversation", systemImage: "square.and.pencil") }
                        .buttonStyle(.borderedProminent)

                    if model.channels.isEmpty {
                        EmptyState(text: "No conversations yet.", systemImage: "text.bubble")
                    } else {
                        ForEach(model.channels) { ch in
                            AppCard(onTap: { route = ch.id }) {
                                HStack {
                                    Text(ch.title).appTitleSmall()
                                    Spacer()
                                    if ch.unreadCount > 0 {
                                        Text("\(ch.unreadCount)")
                                            .appLabelSmall().foregroundStyle(.white)
                                            .padding(.horizontal, 6).padding(.vertical, 2)
                                            .background(Theme.accent, in: Capsule())
                                    }
                                }
                                if let last = ch.lastMessage {
                                    Text((last.senderId == AGENT_SENDER_ID ? "Assistant: " : "") + last.body)
                                        .appLabelSmall().foregroundStyle(Theme.textMuted).lineLimit(1)
                                }
                            }
                        }
                    }
                }
            }
        }
        .task { await model.refreshChannels() }
        .navigationDestination(item: $route) { id in
            ConversationView(channelId: id) { route = nil }
        }
        .sheet(isPresented: $showNew) {
            NewConversationForm { memberIds, name in
                showNew = false
                model.startConversation(memberIds: memberIds, name: name) { route = $0 }
            }
        }
    }
}

struct NewConversationForm: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let onCreate: ([String], String?) -> Void

    @State private var selected: Set<String> = []
    @State private var groupName = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("People") {
                    ForEach(model.familyMembers.filter { $0.id != model.currentUser?.id }) { m in
                        Button {
                            if selected.contains(m.id) { selected.remove(m.id) } else { selected.insert(m.id) }
                        } label: {
                            HStack {
                                Text(m.displayName)
                                Spacer()
                                if selected.contains(m.id) { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                if selected.count > 1 {
                    Section("Group name") { TextField("Optional", text: $groupName) }
                }
            }
            .navigationTitle("New conversation").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") {
                        onCreate(Array(selected), groupName.isEmpty ? nil : groupName)
                    }
                    .disabled(selected.isEmpty)
                }
            }
        }
    }
}
