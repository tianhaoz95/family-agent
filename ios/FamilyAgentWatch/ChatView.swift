import SwiftUI

/// A chat session's history + composer — the watch's one screen for the one
/// feature this companion app has. `sessionID == nil` means "a fresh,
/// not-yet-started chat" (mirrors Android's `wearSessionId == null`); the
/// text field is a plain SwiftUI `TextField`, which is already how watchOS
/// itself decides to let the user type (Scribble / dictation / QWERTY /
/// emoji keyboard, picked by the system) — no special input-sheet helper
/// needed here, unlike Wear OS's `RemoteInputIntentHelper`.
struct ChatView: View {
    let sessionID: String?

    @Environment(WatchBridge.self) private var bridge
    @State private var input = ""
    @State private var recorder = VoiceRecorder()
    @State private var isRecording = false
    @State private var micDenied = false

    /// A stale payload — either for a different session, or this composer's
    /// own optimistic send that hasn't round-tripped its new session id back
    /// yet — doesn't belong on screen.
    private var messages: [WatchChatMessage] {
        guard let current = bridge.current else { return [] }
        if let sessionID, let currentID = current.sessionID, currentID != sessionID { return [] }
        return current.messages
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        ForEach(messages) { message in
                            MessageBubble(message: message).id(message.id)
                        }
                        if bridge.current?.sending == true {
                            ProgressView().padding(.vertical, 4)
                        }
                        if let error = bridge.current?.error {
                            Text(error).font(.caption2).foregroundStyle(.red)
                        }
                    }
                    .padding(.horizontal, 4)
                }
                .onChange(of: messages.count) { _, _ in
                    guard let last = messages.last else { return }
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }

            HStack(spacing: 6) {
                TextField("Message", text: $input)
                    .textFieldStyle(.plain)
                Button {
                    toggleRecording()
                } label: {
                    Image(systemName: isRecording ? "mic.fill" : "mic")
                }
                .tint(isRecording ? .red : nil)
                .buttonStyle(.bordered)
                Button {
                    sendTyped()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
        }
        .navigationTitle(sessionID == nil ? "New Chat" : "Chat")
        .task {
            if let sessionID {
                bridge.openSession(sessionID)
            } else {
                bridge.newSession()
            }
        }
        .alert("Microphone access needed", isPresented: $micDenied) {
            Button("OK", role: .cancel) {}
        }
    }

    private func sendTyped() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""
        bridge.sendText(text)
    }

    private func toggleRecording() {
        if isRecording {
            isRecording = false
            let wav = recorder.stop()
            if !wav.isEmpty { bridge.sendVoice(wav) }
            return
        }
        Task {
            let granted = await VoiceRecorder.requestPermission()
            guard granted else { micDenied = true; return }
            do {
                try recorder.start()
                isRecording = true
            } catch {
                isRecording = false
            }
        }
    }
}

private struct MessageBubble: View {
    let message: WatchChatMessage
    private var isUser: Bool { message.role == "user" }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 12) }
            Text(message.body)
                .font(.system(size: 14))
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(isUser ? Color.accentColor : Color.gray.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
                .foregroundStyle(isUser ? .white : .primary)
            if !isUser { Spacer(minLength: 12) }
        }
    }
}
