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
        HStack(alignment: .center, spacing: 4) {
            if mentionPill {
                Button { mentionPill = false } label: {
                    HStack(spacing: 3) {
                        Text("@agent").font(.inter(12.5, .semibold))
                        Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                    }
                    .foregroundStyle(Theme.accent)
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .background(Theme.accentSoft, in: Capsule())
                }
                .buttonStyle(.plain)
                .padding(.leading, 6)
            }
            TextField(mentionPill ? "Ask the assistant" : "Message", text: $input, axis: .vertical)
                .font(.inter(15))
                .lineLimit(1...4)
                .padding(.vertical, 7)
                .padding(.leading, mentionPill ? 0 : 10)
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
                Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(input.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.textFaint : Theme.accent, in: Circle())
            }
            .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.trailing, 6)
        .padding(.vertical, 4)
        .glass(.floating, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 12).padding(.bottom, 8)
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
