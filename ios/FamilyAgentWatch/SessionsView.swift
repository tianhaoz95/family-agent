import SwiftUI

struct SessionsView: View {
    @Environment(WatchBridge.self) private var bridge

    var body: some View {
        List {
            NavigationLink {
                ChatView(sessionID: nil)
            } label: {
                Label("New Chat", systemImage: "plus.bubble")
            }

            if !bridge.phoneReachable {
                Text("Phone not reachable")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            ForEach(bridge.sessions) { session in
                NavigationLink {
                    ChatView(sessionID: session.id)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title).font(.headline).lineLimit(1)
                        if let last = session.lastMessage, !last.isEmpty {
                            Text(last).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }
        }
        .navigationTitle("Family Agent")
    }
}
