import Foundation

extension AppModel {

    // MARK: 1:1 assistant chat

    func startNewChatSession() {
        chatMessages = []
        activeChatSessionID = nil
        chatLiveSteps = []
        stopSpeech()
    }

    func openChatSession(_ id: String) {
        Task {
            guard let msgs = await perform({ try await api.chatSessionMessages(id) }) else { return }
            activeChatSessionID = id
            chatMessages = msgs.map { m in
                ChatMessage(role: m.role, text: m.body, images: m.images,
                            references: m.refs, steps: m.steps, cards: m.cards)
            }
            // The session's own last word is a user message with no reply
            // after it — a turn may still be running server-side (this
            // device was killed or lost its connection mid-turn; the /chat
            // route persists the user's message before it even calls the
            // model, so the reply can land long after the request that
            // started it is gone). Show the pending state and wait for it.
            if msgs.last?.role == "user" {
                watchForPendingReply(sessionId: id)
            }
        }
    }

    /// Chat opens on the most recently used conversation instead of a blank
    /// new one — called once right after sign-in (fresh login or a restored
    /// session). `listChatSessions` is newest-first, so the first one is it.
    func openMostRecentChatSession() async {
        await refreshChatSessions()
        if let id = chatSessions.first?.id { openChatSession(id) }
    }

    /// Re-poll a session's own message list until the pending reply resolves
    /// (or a generous timeout passes), rather than losing the "still
    /// working" state whenever this app instance wasn't the one waiting for
    /// it. No live tool-call steps here — the turnId that would carry those
    /// died with whatever launched the original request.
    private func watchForPendingReply(sessionId: String) {
        guard !chatSending else { return } // this instance is already actively sending it
        chatSending = true
        chatLiveSteps = []
        Task {
            defer { if activeChatSessionID == sessionId { chatSending = false } }
            let deadline = Date().addingTimeInterval(210) // worst-case turn (~110s) plus margin
            while Date() < deadline {
                try? await Task.sleep(for: .seconds(3))
                guard activeChatSessionID == sessionId else { return } // navigated elsewhere
                guard let msgs = await perform({ try await api.chatSessionMessages(sessionId) }) else { continue }
                if msgs.last?.role != "user" {
                    chatMessages = msgs.map { m in
                        ChatMessage(role: m.role, text: m.body, images: m.images,
                                    references: m.refs, steps: m.steps, cards: m.cards)
                    }
                    return
                }
            }
            // Gave up waiting — leave the transcript as-is rather than guess
            // whether it errored out or is just unusually slow.
            if activeChatSessionID == sessionId {
                chatMessages.append(ChatMessage(role: "error", text: "No reply came back for that message. You can try sending it again."))
            }
        }
    }

    func sendChat(_ text: String, images: [String] = [], speakReply: Bool = false) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !chatSending else { return }
        chatMessages.append(ChatMessage(role: "user", text: trimmed, images: images))
        chatSending = true
        chatLiveSteps = []
        let turnId = UUID().uuidString

        Task {
            // live step polling for the duration of the turn
            let poller = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(1))
                    guard let self else { return }
                    if let s = try? await self.api.turnSteps(turnId) {
                        await MainActor.run { self.chatLiveSteps = s.steps }
                        if s.done { return }
                    }
                }
            }
            defer { poller.cancel() }

            do {
                let resp = try await api.chat(trimmed, images: images,
                                              sessionId: activeChatSessionID, turnId: turnId)
                activeChatSessionID = resp.sessionId
                chatMessages.append(ChatMessage(role: "assistant", text: resp.reply,
                                                references: resp.references, steps: resp.steps, cards: resp.cards))
                if speakReply || autoRead {
                    speak(resp.reply)
                }
                await refreshChatSessions()
            } catch APIError.unauthorized {
                settings.clearSession()
                auth = .needLogin(serverURL: serverURL, serverName: settings.session?.serverName ?? "", error: "Your session expired.")
            } catch {
                chatMessages.append(ChatMessage(role: "error", text: error.localizedDescription))
            }
            chatSending = false
            chatLiveSteps = []
        }
    }

    // MARK: Detail sheet openers

    func showStepsDetail(_ steps: [ToolStep]) { detail = .steps(steps) }
    func showCardSource(_ card: Card) { detail = .cardSource(title: card.title, fragment: card.fragment.isEmpty ? card.html : card.fragment) }
    func openReferenceDetail(_ ref: ChatReference) {
        switch ref.type {
        case "task", "event": openTaskDetail(ref.id)
        case "document": openDocumentDetail(ref.id)
        case "artifact": openArtifact(ref.id)
        case "link":
            if let url = URL(string: ref.id) { externalURL = url }
        default: break
        }
    }

    // MARK: Speech

    func speak(_ text: String) {
        audio.onState = { [weak self] loading, playing in
            self?.speakLoadingText = loading
            self?.speakingText = playing
        }
        Task { await audio.toggle(text) { [api] t in try await api.speak(t) } }
    }
    func stopSpeech() { audio.stop() }

    // MARK: Voice

    func transcribeVoice(_ wav: Data, into completion: @escaping (String) -> Void) {
        Task {
            chatTranscribing = true
            if let r = await perform({ try await api.transcribe(wav) }) { completion(r.text) }
            chatTranscribing = false
        }
    }
    func sendChatVoice(_ wav: Data) {
        Task {
            chatTranscribing = true
            if let r = await perform({ try await api.transcribe(wav) }), !r.text.isEmpty {
                chatTranscribing = false
                sendChat(r.text, speakReply: true)
            } else {
                chatTranscribing = false
            }
        }
    }
}

