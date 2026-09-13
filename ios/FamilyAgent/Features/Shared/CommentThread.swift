import SwiftUI

/// A comment card: the anchored quote, the root message, every reply in the
/// thread so far, and a reply composer — typing "@agent" in it brings the
/// assistant into the discussion (repeatably; every reply, including a
/// prior @agent one, is context for the next). Shared between the artifact
/// viewer and the wiki page editor's comment sheets — see
/// docs/DECISIONS.md → "Threaded comments".
struct CommentThreadCard: View {
    let quote: String?
    let commentBody: String
    let authorLabel: String
    let replies: [CommentReply]
    let status: String
    var onReply: (String) async -> Void
    var onResolve: () async -> Void
    var onReopen: () async -> Void
    var onDelete: () async -> Void
    var onQuoteTap: (() -> Void)? = nil

    @State private var draft = ""
    @State private var sending = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let quote, !quote.isEmpty {
                Text("\u{201c}\(quote.prefix(140))\u{201d}")
                    .font(.inter(12))
                    .foregroundStyle(Theme.textMuted)
                    .padding(.leading, 6)
                    .overlay(alignment: .leading) { Rectangle().fill(Color.orange.opacity(0.6)).frame(width: 2) }
                    .contentShape(Rectangle())
                    .onTapGesture { onQuoteTap?() }
            }
            (Text("\(authorLabel): ").font(.inter(13, .semibold)) + Text(commentBody).font(.inter(13)))

            if !replies.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(replies) { r in
                        (Text("\(r.authorName): ")
                            .font(.inter(12, .semibold))
                            .foregroundStyle(r.author == "agent" ? Theme.accentInk : Theme.text)
                            + Text(r.body).font(.inter(12)).foregroundStyle(Theme.text))
                    }
                }
                .padding(.leading, 8)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 2) }
            }

            HStack(spacing: 16) {
                if status == "resolved" {
                    Button("Reopen") { Task { await onReopen() } }
                } else {
                    Button("Resolve") { Task { await onResolve() } }
                }
                Button("Delete", role: .destructive) { Task { await onDelete() } }
            }
            .font(.inter(12))

            HStack(spacing: 8) {
                TextField("Reply, or type @agent\u{2026}", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .disabled(sending)
                    .onSubmit { send() }
                Button("Send") { send() }
                    .buttonStyle(.soft)
                    .disabled(sending || draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .opacity(status == "resolved" ? 0.75 : 1)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty, !sending else { return }
        sending = true
        Task {
            await onReply(draft)
            draft = ""
            sending = false
        }
    }
}
