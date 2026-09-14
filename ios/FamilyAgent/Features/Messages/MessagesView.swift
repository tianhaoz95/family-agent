import SwiftUI

struct MessagesView: View {
    @Environment(AppModel.self) private var model
    @State private var composing = false
    @State private var route: String?
    /// A channel id from a tapped notification — opened once, the first time
    /// this view appears, via `onConsumedInitialRoute` (see MainShell.swift).
    var initialChannelId: String? = nil
    var onConsumedInitialRoute: () -> Void = {}

    var body: some View {
        ScreenScaffold(title: "Messages",
                       subtitle: "Chat with the family. Type @agent to pull in the assistant.") {
            VStack(alignment: .leading, spacing: 12) {
                Button { composing = true } label: { Label("New conversation", systemImage: "plus") }
                    .buttonStyle(.primary)

                if model.channels.isEmpty {
                    EmptyState(text: "No conversations yet. Start one above.", systemImage: "bubble.left.and.bubble.right")
                } else {
                    ForEach(model.channels) { ch in
                        AppCard(onTap: { route = ch.id }) {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(ch.title.isEmpty ? "Conversation" : ch.title).appTitleSmall()
                                    Text(preview(ch))
                                        .appBodySmall().foregroundStyle(Theme.textMuted).lineLimit(1)
                                }
                                Spacer()
                                if ch.unreadCount > 0 {
                                    Text(ch.unreadCount > 99 ? "99+" : "\(ch.unreadCount)")
                                        .font(.inter(11, .bold)).foregroundStyle(.white)
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(Theme.accent, in: Capsule())
                                }
                            }
                        }
                    }
                }
            }
        }
        .task {
            await model.refreshChannels()
            if let id = initialChannelId {
                route = id
                onConsumedInitialRoute()
            }
        }
        .navigationDestination(item: $route) { id in
            ConversationView(channelId: id) { route = nil }
        }
        .sheet(isPresented: $composing) {
            NewConversationSheet(
                members: model.familyMembers.filter { $0.id != model.currentUser?.id },
                onStart: { ids, name in
                    composing = false
                    model.startConversation(memberIds: ids, name: name) { route = $0 }
                }
            )
            .presentationDetents([.medium, .large])
        }
    }

    private func preview(_ ch: Channel) -> String {
        guard let last = ch.lastMessage else { return "No messages yet" }
        return last.pending ? "Assistant is typing…" : last.body
    }
}

/// Presented as a `.sheet` (matching `ChatSessionsView`/`WikiCommentsSheet`'s
/// own pattern) rather than pushed inline into the Messages list — inline
/// used to shove the whole conversation list down the screen and duplicated
/// "Cancel" in two places (a top button and one inside the card) once the
/// list below it had scrolled out of view.
struct NewConversationSheet: View {
    let members: [FamilyMember]
    let onStart: ([String], String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<String> = []
    @State private var groupName = ""

    var body: some View {
        NavigationStack {
            List {
                Section("Pick people") {
                    ForEach(members) { m in
                        Button {
                            if picked.contains(m.id) { picked.remove(m.id) } else { picked.insert(m.id) }
                        } label: {
                            HStack {
                                Text(m.displayName).appBody()
                                Spacer()
                                if picked.contains(m.id) {
                                    Image(systemName: "checkmark").foregroundStyle(Theme.accentInk)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                if picked.count > 1 {
                    Section("Group name") {
                        TextField("Group name", text: $groupName)
                    }
                }
            }
            .navigationTitle("New conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") {
                        onStart(Array(picked), groupName.isEmpty ? nil : groupName)
                    }
                    .disabled(picked.isEmpty || (picked.count > 1 && groupName.isEmpty))
                }
            }
        }
    }
}
