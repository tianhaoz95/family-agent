import SwiftUI

/// Past private assistant chat sessions — reached from Chat's "History" button.
/// Mirrors `android/.../ui/ChatSessionsScreen.kt`.
struct ChatSessionsView: View {
    @Environment(AppModel.self) private var model
    let onClose: () -> Void
    @State private var confirmDelete: ChatSession?

    var body: some View {
        NavigationStack {
            ScreenScaffold(title: "Chat history",
                           subtitle: "Past conversations with the assistant \u{2014} pick one to pick up where it left off.") {
                if model.chatSessions.isEmpty {
                    EmptyState(text: "No conversations yet.", systemImage: "bubble.left.and.bubble.right")
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(model.chatSessions) { s in
                            AppCard(onTap: { model.openChatSession(s.id); onClose() }) {
                                HStack(spacing: 8) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(s.title).appTitleSmall().lineLimit(1)
                                        Text(s.lastMessage ?? "No messages yet")
                                            .appBodySmall().foregroundStyle(Theme.textMuted).lineLimit(1)
                                    }
                                    Spacer()
                                    Button { confirmDelete = s } label: {
                                        Image(systemName: "trash").font(.system(size: 15)).foregroundStyle(Theme.textMuted)
                                    }.buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done", action: onClose) }
            }
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.refreshChatSessions() }
            .alert("Delete this conversation?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
                Button("Delete", role: .destructive) {
                    if let s = confirmDelete { model.deleteChatSession(s.id) }
                    confirmDelete = nil
                }
                Button("Cancel", role: .cancel) { confirmDelete = nil }
            } message: {
                Text("This can't be undone.")
            }
        }
    }
}
