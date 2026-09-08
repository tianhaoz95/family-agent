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
                    let mine = UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20)
                    let theirs = UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 6, bottomTrailingRadius: 20, topTrailingRadius: 20)
                    if message.pending {
                        Text("Assistant is typing…").appBody().foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.accentSoft).clipShape(theirs)
                    } else if isMe {
                        Text(message.body).appBody().foregroundStyle(.white)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.accent).clipShape(mine)
                    } else if isAgent {
                        AgentMarkdown(text: message.body)
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.accentSoft).clipShape(theirs)
                    } else {
                        Text(message.body).appBody()
                            .padding(.horizontal, 14).padding(.vertical, 10)
                            .background(Theme.surfaceSunk).clipShape(theirs)
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
