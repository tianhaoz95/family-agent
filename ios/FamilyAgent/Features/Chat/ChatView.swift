import SwiftUI
import PhotosUI

/// Keep in sync with `SLASH_COMMANDS` in `android/.../ui/ChatScreen.kt` and
/// `FORCED_AGENT_KEYWORDS` in agent-core.
let SLASH_COMMANDS: [(String, String)] = [
    ("build", "Build a new tool, or improve an existing one"),
    ("task", "Add, list, or complete a to-do (alias: /event)"),
    ("find", "Search the family's documents (alias: /search)"),
    ("note", "Read or add a sticky note"),
    ("schedule", "Create or manage a scheduled routine (alias: /remind)"),
    ("web", "Search the web and read a page (alias: /lookup)"),
    ("run", "Process a file with command-line tools (alias: /shell)"),
    ("calc", "Compute an exact answer — maths, dates, totals (alias: /compute)"),
    ("skill", "Use one of the family's taught skills"),
    ("connect", "Use a connected external service (alias: /mcp)"),
    ("vault", "Look up a password or 2FA code (alias: /password)"),
]

struct ChatView: View {
    @Environment(AppModel.self) private var model
    @State private var input = ""
    @State private var attached: [String] = []
    @State private var photoItem: PhotosPickerItem?
    @State private var showHistory = false
    @State private var showSlashHelp = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.chatMessages.isEmpty && !model.chatSending {
                            EmptyState(
                                text: "Start a conversation. Try \u{201C}Remind me to renew the car registration by Nov 1\u{201D}, or attach a photo.",
                                systemImage: "bubble.left.and.bubble.right"
                            )
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
                // Drag the transcript down to dismiss the keyboard (iPhone has no
                // hardware dismiss); a "Done" key above the keyboard also works.
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.chatMessages.count) { _, _ in
                    withAnimation { proxy.scrollTo(model.chatMessages.last?.id, anchor: .bottom) }
                }
                .onChange(of: model.chatSending) { _, sending in
                    if sending { withAnimation { proxy.scrollTo("typing", anchor: .bottom) } }
                }
            }

            if !attached.isEmpty {
                ImageTray(images: $attached).padding(.horizontal, 16).padding(.bottom, 4)
            }
            if let matches = slashMatches {
                slashAutocomplete(matches)
            }
            composer
        }
        .background(Color.clear)
        .task {
            await model.refreshTools()
            #if DEBUG
            if let p = ProcessInfo.processInfo.environment["FA_CHAT_PROMPT"], model.chatMessages.isEmpty {
                model.sendChat(p)
            }
            #endif
        }
        .sheet(isPresented: $showHistory) { ChatSessionsView { showHistory = false } }
        .sheet(isPresented: $showSlashHelp) { SlashHelpSheet(tools: model.tools) }
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

    // MARK: header (no app bar — Android parity)

    private var header: some View {
        HStack(spacing: 14) {
            // .appHeadline(), not .appTitle() — matches ScreenScaffold's title
            // size on every other tab (Events, Messages, etc.); this was the
            // one hand-rolled header that drifted to a smaller style.
            Text("Chat").appHeadline().foregroundStyle(Theme.text)
            Spacer()
            headerIcon("square.and.pencil") { model.startNewChatSession() }
            headerIcon("clock.arrow.circlepath") { showHistory = true }
            headerIcon("questionmark") { showSlashHelp = true }
        }
        .padding(.horizontal, 20)
        .padding(.leading, 46)
        .padding(.top, 12)
        .padding(.bottom, 6)
    }

    private func headerIcon(_ name: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.accentInk)
                .frame(width: 34, height: 34)
                // Neutral paper chips, not tinted discs — three blue circles in a
                // row were the loudest thing on the screen.
                .background(Theme.surface, in: Circle())
                .overlay(Circle().strokeBorder(Theme.border, lineWidth: 1))
                .elevation(Theme.E.sm)
        }
        .buttonStyle(PressScaleStyle(scale: 0.92))
    }

    // MARK: "/" autocomplete — while "/" + a partial name is typed (no space yet)

    private var slashQuery: String? {
        guard input.hasPrefix("/"), !input.dropFirst().contains(" ") else { return nil }
        return String(input.dropFirst())
    }
    private var slashMatches: [(String, String)]? {
        guard let q = slashQuery else { return nil }
        let toolEntries = model.tools
            .filter { $0.kind == "server" && $0.status == "ready" }
            .map { ($0.name, $0.description) }
        return (SLASH_COMMANDS + toolEntries).filter { $0.0.range(of: q, options: .caseInsensitive) != nil }
    }

    @ViewBuilder
    private func slashAutocomplete(_ matches: [(String, String)]) -> some View {
        AppCard {
            if matches.isEmpty {
                Text("No matching commands or tools.").appBody().foregroundStyle(Theme.textMuted)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(matches.prefix(8), id: \.0) { name, desc in
                        Button { input = "/\(name) " } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(name).font(.inter(14, .bold)).foregroundStyle(Theme.text)
                                Text(desc).appBodySmall().foregroundStyle(Theme.textMuted).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    // MARK: composer

    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespaces).isEmpty || !attached.isEmpty
    }

    private var composer: some View {
        ComposerBar {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Image(systemName: "photo").font(.system(size: 18))
                    .foregroundStyle(Theme.accentInk)
                    .frame(width: 34, height: 34)
            }
            .disabled(attached.count >= 4)
            .opacity(attached.count >= 4 ? 0.35 : 1)

            if model.voiceEnabled && model.micOnLeft { mic }

            TextField("Ask anything, or type /", text: $input, axis: .vertical)
                .font(.inter(15))
                .lineLimit(1...4)
                .padding(.vertical, 7)
                .padding(.leading, 4)
                .tint(Theme.accent)
                .focused($composerFocused)
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button { composerFocused = false } label: {
                            Image(systemName: "keyboard.chevron.compact.down")
                                .font(.system(size: 16, weight: .semibold))
                        }
                        .tint(Theme.accentInk)
                    }
                }

            if model.voiceEnabled && !model.micOnLeft { mic }

            SendButton(sending: model.chatSending, enabled: canSend) { send() }
        }
    }

    @ViewBuilder private var mic: some View {
        HoldToTalkMic(enabled: !model.chatSending, transcribing: model.chatTranscribing,
                      onDictate: { model.transcribeVoice($0) { t in
                          input = input.isEmpty ? t : "\(input.trimmingCharacters(in: .whitespaces)) \(t)"
                      } },
                      onVoiceSend: { model.sendChatVoice($0) })
    }

    private func send() {
        guard !model.chatSending, canSend else { return }
        model.sendChat(input.trimmingCharacters(in: .whitespacesAndNewlines), images: attached)
        input = ""
        attached = []
    }
}

/// The "?" bottom sheet explaining the "/" commands — mirrors Android's `SlashHelpSheet`.
struct SlashHelpSheet: View {
    let tools: [Tool]
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Slash commands").font(.inter(20, .bold))
                Spacer().frame(height: 8)
                Text("Start a message with \u{201C}/\u{201D} to skip the assistant's own routing and send that turn straight to one specialist — useful when it doesn't otherwise pick the right one.")
                    .appBodySmall().foregroundStyle(Theme.textMuted)
                Spacer().frame(height: 16)
                Text("COMMANDS").font(.inter(12, .bold)).foregroundStyle(Theme.textMuted)
                Spacer().frame(height: 6)
                ForEach(SLASH_COMMANDS, id: \.0) { row("/\($0.0)", $0.1) }
                Spacer().frame(height: 16)
                Text("OR ONE OF THE FAMILY'S TOOLS, BY NAME").font(.inter(12, .bold)).foregroundStyle(Theme.textMuted)
                Spacer().frame(height: 6)
                let ready = tools.filter { $0.kind == "server" && $0.status == "ready" }
                if ready.isEmpty {
                    Text("The family hasn't built any tools yet — see the Tools tab.")
                        .appBody().foregroundStyle(Theme.textMuted)
                } else {
                    ForEach(ready) { row("/\($0.name)", $0.description) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder
    private func row(_ command: String, _ description: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(command).font(.inter(14, .bold)).foregroundStyle(Theme.text)
            Text(description).appBodySmall().foregroundStyle(Theme.textMuted)
        }
        .padding(.vertical, 4)
    }
}
