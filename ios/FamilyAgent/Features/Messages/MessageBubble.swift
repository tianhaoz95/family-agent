import SwiftUI

struct MessageBubble: View {
    let message: Message
    let isMe: Bool
    let senderName: String
    let ttsEnabled: Bool
    let speakingText: String?
    let loadingText: String?
    let onSpeak: (String) -> Void
    let onStepsTap: ([ToolStep]) -> Void
    let onCardSource: (Card) -> Void

    private var isAgent: Bool { message.senderId == AGENT_SENDER_ID }

    var body: some View {
        HStack {
            if isMe { Spacer(minLength: 40) }
            VStack(alignment: isMe ? .trailing : .leading, spacing: 4) {
                if !isMe {
                    Text(senderName).appLabelSmall().foregroundStyle(Theme.textMuted)
                }
                if !message.images.isEmpty { ImageStrip(uris: message.images) }
                Group {
                    if message.pending {
                        TypingDots()
                    } else if isMe {
                        Text(message.body).appBody().foregroundStyle(.white)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.accent)
                            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 6, topTrailingRadius: 18))
                    } else if isAgent {
                        AgentMarkdown(text: message.body)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.accentSoft)
                            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 6, bottomTrailingRadius: 18, topTrailingRadius: 18))
                    } else {
                        Text(message.body).appBody()
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.surface)
                            .clipShape(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 6, bottomTrailingRadius: 18, topTrailingRadius: 18))
                            .overlay(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 6, bottomTrailingRadius: 18, topTrailingRadius: 18).stroke(Theme.border, lineWidth: 1))
                    }
                }
                if isAgent, !message.steps.isEmpty {
                    StepsStrip(steps: message.steps, live: false) { onStepsTap(message.steps) }
                }
                ForEach(message.cards) { card in
                    CardView(card: card) { onCardSource(card) }
                }
                if isAgent, !message.pending {
                    HStack(spacing: 12) {
                        CopyButton(text: message.body)
                        if ttsEnabled {
                            SpeakButton(text: message.body, speakingText: speakingText, loadingText: loadingText, onToggle: onSpeak)
                        }
                    }
                }
            }
            if !isMe { Spacer(minLength: 40) }
        }
    }
}
