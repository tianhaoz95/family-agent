import SwiftUI

struct ChatSessionsView: View {
    @Environment(AppModel.self) private var model
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.chatSessions) { s in
                    Button {
                        model.openChatSession(s.id)
                        onClose()
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(s.title).appTitleSmall()
                            if let last = s.lastMessage {
                                Text(last).appLabelSmall().foregroundStyle(Theme.textMuted).lineLimit(1)
                            }
                            Text(friendlyTimestamp(s.updatedAt)).appLabelSmall().foregroundStyle(Theme.textFaint)
                        }
                    }
                    .buttonStyle(.plain)
                }
                .onDelete { idx in
                    for i in idx { model.deleteChatSession(model.chatSessions[i].id) }
                }
            }
            .navigationTitle("Chat history").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done", action: onClose) } }
            .task { await model.refreshChatSessions() }
            .overlay {
                if model.chatSessions.isEmpty {
                    EmptyState(text: "No saved conversations yet.", systemImage: "clock.arrow.circlepath")
                }
            }
        }
    }
}
