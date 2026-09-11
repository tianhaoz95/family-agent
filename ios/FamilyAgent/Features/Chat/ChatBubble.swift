import SwiftUI

struct ChatBubble: View {
    let message: ChatMessage
    let ttsEnabled: Bool
    let speakingText: String?
    let loadingText: String?
    let onSpeak: (String) -> Void
    let onStepsTap: ([ToolStep]) -> Void
    let onCardSource: (Card) -> Void
    let onReference: (ChatReference) -> Void

    private var isUser: Bool { message.role == "user" }
    private var isError: Bool { message.role == "error" }
    private var isForced: Bool { message.text.hasPrefix("/") && isUser }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 40) }
            VStack(alignment: isUser ? .trailing : .leading, spacing: 6) {
                if !message.images.isEmpty {
                    ImageStrip(uris: message.images)
                }
                bubble
                if !isUser && !message.steps.isEmpty {
                    StepsStrip(steps: message.steps, live: false) { onStepsTap(message.steps) }
                }
                ForEach(message.cards) { card in
                    CardView(card: card) { onCardSource(card) }
                }
                if !message.references.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(message.references) { ref in
                            Button { onReference(ref) } label: {
                                Label(refLabel(ref), systemImage: refIcon(ref.type))
                                    .font(.inter(12, .medium))
                                    .lineLimit(1)
                                    .padding(.horizontal, 10).padding(.vertical, 5)
                                    .background(Theme.accentSoft, in: Capsule())
                                    .foregroundStyle(Theme.accentInk)
                            }.buttonStyle(.plain)
                        }
                    }
                    .frame(maxWidth: 320, alignment: .leading)
                }
                if !isError && !message.text.isEmpty {
                    HStack(spacing: 12) {
                        CopyButton(text: message.text)
                        if !isUser && ttsEnabled {
                            SpeakButton(text: message.text, speakingText: speakingText,
                                        loadingText: loadingText, onToggle: onSpeak)
                        }
                    }
                }
            }
            if !isUser { Spacer(minLength: 40) }
        }
    }

    @ViewBuilder
    private var bubble: some View {
        Group {
            if isUser {
                HStack(spacing: 5) {
                    if isForced {
                        Image(systemName: "hammer.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(.white.opacity(0.75))
                    }
                    Text(message.text).appBody().foregroundStyle(.white)
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.accent)
                .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, bottomLeadingRadius: 22, bottomTrailingRadius: 6, topTrailingRadius: 22))
            } else if isError {
                Text(message.text).appBody().foregroundStyle(Theme.dangerInk)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.dangerSoft)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            } else {
                // Assistant bubble: sunk warm-gray, no border (matches Android's surfaceVariant).
                AgentMarkdown(text: message.text)
                    .padding(.horizontal, 14).padding(.vertical, 11)
                    .background(Theme.surfaceSunk)
                    .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, bottomLeadingRadius: 6, bottomTrailingRadius: 22, topTrailingRadius: 22))
            }
        }
    }

    private func refLabel(_ ref: ChatReference) -> String {
        guard ref.type == "link" else { return ref.label }
        let s = ref.label
            .replacingOccurrences(of: "https://", with: "")
            .replacingOccurrences(of: "http://", with: "")
            .replacingOccurrences(of: "www.", with: "")
        return String(s.prefix(40))
    }

    private func refIcon(_ type: String) -> String {
        switch type {
        case "document": "doc.text"
        case "task", "event": "checkmark.circle"
        case "link": "link"
        case "tool": "wrench.and.screwdriver"
        default: "arrow.up.right.square"
        }
    }
}

struct ImageStrip: View {
    let uris: [String]
    var body: some View {
        HStack(spacing: 6) {
            ForEach(uris.indices, id: \.self) { i in
                if let ui = ImageAttach.image(fromDataURI: uris[i]) {
                    Image(uiImage: ui).resizable().scaledToFill()
                        .frame(width: 120, height: 120)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }
}
