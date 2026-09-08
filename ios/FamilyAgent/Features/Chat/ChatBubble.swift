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
                    FlowLayout(spacing: 5) {
                        ForEach(message.references) { ref in
                            Button { onReference(ref) } label: {
                                Label(ref.label, systemImage: refIcon(ref.type))
                                    .appLabelSmall()
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(Theme.accentSoft, in: Capsule())
                            }.buttonStyle(.plain)
                        }
                    }
                }
                if !isUser && !isError {
                    HStack(spacing: 12) {
                        CopyButton(text: message.text)
                        if ttsEnabled {
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
                HStack(spacing: 4) {
                    if isForced { Image(systemName: "wrench.fill").font(.system(size: 10)) }
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
                AgentMarkdown(text: message.text)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.surface)
                    .clipShape(UnevenRoundedRectangle(topLeadingRadius: 22, bottomLeadingRadius: 6, bottomTrailingRadius: 22, topTrailingRadius: 22))
                    .overlay(
                        UnevenRoundedRectangle(topLeadingRadius: 22, bottomLeadingRadius: 6, bottomTrailingRadius: 22, topTrailingRadius: 22)
                            .stroke(Theme.border, lineWidth: 1)
                    )
            }
        }
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
