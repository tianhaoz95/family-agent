import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    let channelId: String
    let onBack: () -> Void

    @State private var input = ""
    @State private var mentionPill = false
    @State private var showDelete = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(model.channelMessages) { m in
                            MessageBubble(message: m,
                                          isMe: m.senderId == model.currentUser?.id,
                                          senderName: name(for: m.senderId),
                                          ttsEnabled: model.ttsEnabled,
                                          speakingText: model.speakingText,
                                          loadingText: model.speakLoadingText,
                                          onSpeak: model.speak,
                                          onStepsTap: { model.showStepsDetail($0) },
                                          onCardSource: { model.showCardSource($0) })
                            .id(m.id)
                        }
                        if model.channelSending { TypingDots() }
                    }
                    .padding(16)
                }
                .onChange(of: model.channelMessages.count) { _, _ in
                    withAnimation { proxy.scrollTo(model.channelMessages.last?.id, anchor: .bottom) }
                }
            }
            composer
        }
        .scrollContentBackground(.hidden)
        .navigationTitle(model.activeChannel?.title ?? "Conversation")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { model.closeChannel(); onBack() } label: { Image(systemName: "chevron.left") }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Delete conversation", role: .destructive) { showDelete = true }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .task(id: channelId) {
            model.openChannel(channelId)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2.5))
                await model.pollConversation(channelId)
            }
        }
        .onDisappear { model.closeChannel() }
        .alert("Delete this conversation for everyone?", isPresented: $showDelete) {
            Button("Delete", role: .destructive) {
                model.deleteChannel(channelId) { onBack() }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var composer: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                if mentionPill {
                    HStack(spacing: 3) {
                        Text("@agent").font(.inter(12, .semibold)).foregroundStyle(Theme.accent)
                        Button { mentionPill = false } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 12)) }
                            .foregroundStyle(Theme.accent.opacity(0.6))
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Theme.accentSoft, in: Capsule())
                }
                TextField(mentionPill ? "Ask the assistant" : "Message", text: $input, axis: .vertical)
                    .lineLimit(1...4)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(Theme.border, lineWidth: 1))
                    .onChange(of: input) { _, v in
                        if !mentionPill, ["@agent ", "@ai ", "@assistant "].contains(where: { v.lowercased() == $0 }) {
                            mentionPill = true
                            input = ""
                        }
                    }
                if model.voiceEnabled {
                    HoldToTalkMic(enabled: !model.channelSending, transcribing: model.channelTranscribing,
                                  onDictate: { model.transcribeChannelVoice($0) { input += $0 } },
                                  onVoiceSend: { model.sendChannelVoice($0) })
                }
                Button { send() } label: {
                    Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 34, height: 34).background(Theme.accent, in: Circle())
                }
                .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(12)
        .glass(.floating, in: RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous))
        .padding(.horizontal, 10).padding(.bottom, 8)
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let wire = mentionPill ? "@agent \(text)" : text
        model.sendChannelMessage(wire, mentionAgent: mentionPill)
        input = ""
        mentionPill = false
    }

    private func name(for id: String) -> String {
        if id == AGENT_SENDER_ID { return "Assistant" }
        return model.familyMembers.first { $0.id == id }?.displayName
            ?? model.activeChannel?.members.first { $0.id == id }?.displayName
            ?? "Someone"
    }
}
