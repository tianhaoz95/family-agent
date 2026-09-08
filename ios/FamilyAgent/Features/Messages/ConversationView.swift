import SwiftUI
import PhotosUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    let channelId: String
    let onBack: () -> Void

    @State private var input = ""
    @State private var mentionPill = false
    @State private var showDelete = false
    @State private var attached: [String] = []
    @State private var photoItem: PhotosPickerItem?

    private let mentionNames: Set<String> = ["agent", "ai", "assistant"]

    var body: some View {
        VStack(spacing: 0) {
            // Custom header (Android has no app bar): back + title + delete + divider.
            HStack(spacing: 4) {
                Button { model.closeChannel(); onBack() } label: {
                    Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold))
                }
                Text((model.activeChannel?.title).flatMap { $0.isEmpty ? nil : $0 } ?? "Conversation")
                    .appTitle().foregroundStyle(Theme.text)
                    .lineLimit(1)
                Spacer()
                Button { showDelete = true } label: {
                    Image(systemName: "trash").font(.system(size: 16))
                }
            }
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 8)
            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
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
                    }
                    .padding(16)
                }
                .onChange(of: model.channelMessages.count) { _, _ in
                    withAnimation { proxy.scrollTo(model.channelMessages.last?.id, anchor: .bottom) }
                }
            }

            if !attached.isEmpty {
                ImageTray(images: $attached).padding(.horizontal, 16).padding(.bottom, 4)
            }
            if atQuery != nil {
                atAutocomplete
            }
            composer
        }
        .toolbar(.hidden, for: .navigationBar)
        .task(id: channelId) {
            model.openChannel(channelId)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2.5))
                await model.pollConversation(channelId)
            }
        }
        .onDisappear { model.closeChannel() }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let uri = ImageAttach.scaledJpegDataURI(data), attached.count < 4 {
                    attached.append(uri)
                }
                photoItem = nil
            }
        }
        .alert("Delete conversation?", isPresented: $showDelete) {
            Button("Delete", role: .destructive) { model.deleteChannel(channelId) { onBack() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its messages are removed for everyone in it. This can't be undone.")
        }
    }

    // MARK: "@" autocomplete

    private var atQuery: String? {
        guard !mentionPill, input.hasPrefix("@"), !input.dropFirst().contains(" ") else { return nil }
        let q = String(input.dropFirst())
        return "agent".range(of: q, options: .caseInsensitive) != nil ? q : nil
    }

    private var atAutocomplete: some View {
        AppCard {
            Button {
                mentionPill = true
                input = ""
            } label: {
                VStack(alignment: .leading, spacing: 1) {
                    Text("@agent").font(.inter(14, .bold)).foregroundStyle(Theme.text)
                    Text("Bring in the assistant").appBodySmall().foregroundStyle(Theme.textMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16).padding(.bottom, 6)
    }

    // MARK: composer

    @ViewBuilder
    private var composer: some View {
        HStack(alignment: .center, spacing: 4) {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Image(systemName: "photo").font(.system(size: 19))
                    .foregroundStyle(Theme.accent).frame(width: 34, height: 34)
            }
            .disabled(attached.count >= 4)

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
            }

            TextField(mentionPill ? "Message the assistant" : "Message, or @agent", text: $input, axis: .vertical)
                .font(.inter(15))
                .lineLimit(1...4)
                .padding(.vertical, 7)
                .padding(.leading, mentionPill ? 0 : 4)
                .onChange(of: input) { _, v in
                    // Lift "@agent <text>" out of the field into a pill, even mid-typing.
                    guard !mentionPill, v.hasPrefix("@") else { return }
                    if let sp = v.firstIndex(where: { $0 == " " || $0 == "\t" }) {
                        let mention = v[v.index(after: v.startIndex)..<sp].lowercased()
                        if mentionNames.contains(mention) {
                            mentionPill = true
                            input = String(v[v.index(after: sp)...])
                        }
                    }
                }

            if model.voiceEnabled {
                HoldToTalkMic(enabled: !model.channelSending, transcribing: model.channelTranscribing,
                              onDictate: { model.transcribeChannelVoice($0) { t in
                                  input = input.isEmpty ? t : "\(input.trimmingCharacters(in: .whitespaces)) \(t)"
                              } },
                              onVoiceSend: { model.sendChannelVoice($0) })
            }

            Button { send() } label: {
                Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(canSend ? Theme.accent : Theme.textFaint, in: Circle())
            }
            .disabled(!canSend)
        }
        .padding(.leading, 8).padding(.trailing, 6).padding(.vertical, 4)
        .glass(.floating, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 12).padding(.bottom, 8)
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespaces).isEmpty || !attached.isEmpty || mentionPill
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        let wire = mentionPill ? "@agent \(text)".trimmingCharacters(in: .whitespaces) : text
        model.sendChannelMessage(wire, mentionAgent: mentionPill, images: attached)
        input = ""
        mentionPill = false
        attached = []
    }

    private func name(for id: String) -> String {
        if id == AGENT_SENDER_ID { return "Assistant" }
        if id == model.currentUser?.id { return "You" }
        return model.familyMembers.first { $0.id == id }?.displayName
            ?? model.activeChannel?.members.first { $0.id == id }?.displayName
            ?? "Someone"
    }
}
