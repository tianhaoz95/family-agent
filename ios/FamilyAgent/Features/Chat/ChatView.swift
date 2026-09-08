import SwiftUI
import PhotosUI

let FORCED_AGENT_KEYWORDS: [(String, String)] = [
    ("build", "Build a new tool, or improve an existing one"),
    ("task", "Add, list, or complete a to-do"),
    ("find", "Search the family's documents"),
    ("note", "Read or add a sticky note"),
    ("schedule", "Create or manage a scheduled routine"),
    ("web", "Search the web and read a page"),
    ("run", "Process a file with command-line tools"),
    ("calc", "Compute an exact answer"),
    ("skill", "Use one of the family's taught skills"),
    ("connect", "Use a connected external service"),
    ("vault", "Look up a password or 2FA code"),
]

struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var input = ""
    @State private var attached: [String] = []
    @State private var photoItem: PhotosPickerItem?
    @State private var showHistory = false
    @State private var slashChip: String?

    var body: some View {
        VStack(spacing: 0) {
            // No app bar (Android parity) — a slim header row: title on the left
            // (clearing the floating menu button), new-chat / history on the right.
            HStack {
                Text("Chat").appTitle().foregroundStyle(Theme.text)
                Spacer()
                Button { model.startNewChatSession() } label: {
                    Image(systemName: "square.and.pencil").font(.system(size: 17))
                }
                Button { showHistory = true } label: {
                    Image(systemName: "clock.arrow.circlepath").font(.system(size: 17))
                }
            }
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 20)
            .padding(.leading, 44)   // clear the menu button
            .padding(.top, 10)
            .padding(.bottom, 6)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if model.chatMessages.isEmpty {
                            EmptyState(text: "Ask anything, or type / for a command.", systemImage: "bubble.left.and.bubble.right")
                                .padding(.top, 40)
                        }
                        ForEach(model.chatMessages) { msg in
                            ChatBubble(message: msg,
                                       ttsEnabled: model.ttsEnabled,
                                       speakingText: model.speakingText,
                                       loadingText: model.speakLoadingText,
                                       onSpeak: model.speak,
                                       onStepsTap: { model.showStepsDetail($0) },
                                       onCardSource: { model.showCardSource($0) },
                                       onReference: { model.openReferenceDetail($0) })
                            .id(msg.id)
                        }
                        if model.chatSending {
                            if !model.chatLiveSteps.isEmpty {
                                StepsStrip(steps: model.chatLiveSteps, live: true) {
                                    model.showStepsDetail(model.chatLiveSteps)
                                }
                            }
                            TypingDots().id("typing")
                        }
                    }
                    .padding(16)
                }
                .onChange(of: model.chatMessages.count) { _, _ in
                    withAnimation { proxy.scrollTo(model.chatMessages.last?.id, anchor: .bottom) }
                }
                .onChange(of: model.chatSending) { _, sending in
                    if sending { withAnimation { proxy.scrollTo("typing", anchor: .bottom) } }
                }
            }

            composer
        }
        .background(Color.clear)
        .scrollContentBackground(.hidden)
        .task {
            await model.refreshTools()
            #if DEBUG
            if let p = ProcessInfo.processInfo.environment["FA_CHAT_PROMPT"], model.chatMessages.isEmpty {
                model.sendChat(p)
            }
            #endif
        }
        .sheet(isPresented: $showHistory) {
            ChatSessionsView { showHistory = false }
        }
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
    }

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespaces).isEmpty || !attached.isEmpty || slashChip != nil
    }

    @ViewBuilder
    private var composer: some View {
        VStack(spacing: 8) {
            if !slashCandidates.isEmpty && slashChip == nil {
                SlashCommandMenu(candidates: slashCandidates) { cmd in
                    slashChip = cmd
                    input = ""
                }
                .padding(.horizontal, 12)
            }
            if !attached.isEmpty {
                ImageTray(images: $attached).padding(.horizontal, 16)
            }
            HStack(alignment: .center, spacing: 4) {
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Image(systemName: "photo")
                        .font(.system(size: 19))
                        .foregroundStyle(Theme.textMuted)
                        .frame(width: 34, height: 34)
                }

                if let chip = slashChip {
                    Button { slashChip = nil } label: {
                        HStack(spacing: 3) {
                            Text("/\(chip)").font(.inter(12.5, .semibold))
                            Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
                        }
                        .foregroundStyle(Theme.accent)
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(Theme.accentSoft, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }

                TextField(
                    slashChip == nil ? "Ask anything, or type / for a command" : "Message",
                    text: $input, axis: .vertical
                )
                .font(.inter(15))
                .lineLimit(1...4)
                .padding(.vertical, 7)
                .padding(.leading, slashChip == nil ? 4 : 0)
                .onChange(of: input) { _, v in
                    if slashChip == nil, v.hasPrefix("/"), v.hasSuffix(" "),
                       let kw = FORCED_AGENT_KEYWORDS.first(where: { "/\($0.0) " == v })?.0 {
                        slashChip = kw
                        input = ""
                    }
                }

                if model.voiceEnabled {
                    HoldToTalkMic(enabled: !model.chatSending, transcribing: model.chatTranscribing,
                                  onDictate: { model.transcribeVoice($0) { input += $0 } },
                                  onVoiceSend: { model.sendChatVoice($0) })
                }

                Button { send() } label: {
                    Image(systemName: model.chatSending ? "stop.fill" : "arrow.up")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 30)
                        .background(canSend || model.chatSending ? Theme.accent : Theme.textFaint, in: Circle())
                }
                .disabled(!canSend && !model.chatSending)
            }
            .padding(.leading, 8)
            .padding(.trailing, 6)
            .padding(.vertical, 4)
            .glass(.floating, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var slashCandidates: [(String, String)] {
        guard input.hasPrefix("/") else { return [] }
        let q = input.dropFirst().lowercased()
        let kws = FORCED_AGENT_KEYWORDS.filter { $0.0.hasPrefix(q) }
        let toolNames = model.tools
            .filter { $0.kind == "server" && $0.status == "ready" }
            .map { ($0.name, "Use the \($0.name) tool") }
            .filter { q.isEmpty || $0.0.lowercased().hasPrefix(q) }
        return kws + toolNames
    }

    private func send() {
        if model.chatSending { return }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let wire = slashChip.map { "/\($0) \(text)" } ?? text
        model.sendChat(wire, images: attached)
        input = ""
        attached = []
        slashChip = nil
    }
}

struct SlashCommandMenu: View {
    let candidates: [(String, String)]
    let onPick: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(candidates.prefix(6), id: \.0) { cmd in
                Button { onPick(cmd.0) } label: {
                    HStack {
                        Text("/\(cmd.0)").font(.inter(13, .semibold)).foregroundStyle(Theme.accent)
                        Text(cmd.1).appLabelSmall().foregroundStyle(Theme.textMuted).lineLimit(1)
                        Spacer()
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                Divider()
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }
}
