import SwiftUI

struct MessagesView: View {
    @Environment(AppModel.self) private var model
    @State private var composing = false
    @State private var route: String?

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Messages",
                           subtitle: "Chat with the family. Type @agent to pull in the assistant.") {
                VStack(alignment: .leading, spacing: 12) {
                    if composing {
                        Button { composing = false } label: { Label("Cancel", systemImage: "xmark") }
                            .buttonStyle(.ghost)
                    } else {
                        Button { composing = true } label: { Label("New conversation", systemImage: "plus") }
                            .buttonStyle(.primary)
                    }

                    if composing {
                        NewConversationForm(
                            members: model.familyMembers.filter { $0.id != model.currentUser?.id },
                            onCancel: { composing = false },
                            onStart: { ids, name in
                                composing = false
                                model.startConversation(memberIds: ids, name: name) { route = $0 }
                            }
                        )
                    }

                    if model.channels.isEmpty {
                        EmptyState(text: "No conversations yet. Start one above.", systemImage: "text.bubble")
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
        }
        .task { await model.refreshChannels() }
        .navigationDestination(item: $route) { id in
            ConversationView(channelId: id) { route = nil }
        }
    }

    private func preview(_ ch: Channel) -> String {
        guard let last = ch.lastMessage else { return "No messages yet" }
        return last.pending ? "Assistant is typing…" : last.body
    }
}

struct NewConversationForm: View {
    let members: [FamilyMember]
    let onCancel: () -> Void
    let onStart: ([String], String?) -> Void

    @State private var picked: Set<String> = []
    @State private var groupName = ""

    var body: some View {
        AppCard {
            Text("Pick people").appTitleSmall()
            Spacer().frame(height: 8)
            ForEach(members) { m in
                Button {
                    if picked.contains(m.id) { picked.remove(m.id) } else { picked.insert(m.id) }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: picked.contains(m.id) ? "checkmark.square.fill" : "square")
                            .font(.system(size: 20))
                            .foregroundStyle(picked.contains(m.id) ? Theme.accent : Theme.textFaint)
                        Text(m.displayName).appBody()
                        Spacer()
                    }
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
            if picked.count > 1 {
                Spacer().frame(height: 8)
                TextField("Group name", text: $groupName).textFieldStyle(.app)
            }
            Spacer().frame(height: 12)
            HStack(spacing: 8) {
                Button("Start") {
                    onStart(Array(picked), groupName.isEmpty ? nil : groupName)
                }
                .buttonStyle(.primary)
                .disabled(picked.isEmpty || (picked.count > 1 && groupName.isEmpty))
                Button("Cancel", action: onCancel).font(.inter(14))
            }
        }
    }
}
