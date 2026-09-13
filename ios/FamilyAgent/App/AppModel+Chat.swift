import Foundation

extension AppModel {

    // MARK: 1:1 assistant chat

    func startNewChatSession() {
        chatMessages = []
        activeChatSessionID = nil
        // A fresh key for this blank composer — distinct from whatever key a
        // *previous* blank composer's still-in-flight first message is using
        // (see sendChat), so this screen never inherits that one's "…".
        chatDraftKey = UUID().uuidString
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
    /// died with whatever launched the original request. Keeps polling even
    /// if the user navigates to a different session in the meantime — the
    /// point is to know *this* session is still pending so reopening it
    /// later shows the right state — only the transcript update below is
    /// gated on it still being the one on screen.
    private func watchForPendingReply(sessionId: String) {
        guard !chatPendingKeys.contains(sessionId) else { return } // already tracked
        chatPendingKeys.insert(sessionId)
        Task {
            defer {
                chatPendingKeys.remove(sessionId)
                chatLiveStepsByKey[sessionId] = nil
            }
            let deadline = Date().addingTimeInterval(210) // worst-case turn (~110s) plus margin
            while Date() < deadline {
                try? await Task.sleep(for: .seconds(3))
                guard let msgs = await perform({ try await api.chatSessionMessages(sessionId) }) else { continue }
                if msgs.last?.role != "user" {
                    if activeChatSessionID == sessionId {
                        chatMessages = msgs.map { m in
                            ChatMessage(role: m.role, text: m.body, images: m.images,
                                        references: m.refs, steps: m.steps, cards: m.cards)
                        }
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

    /// Best-effort: this device's location for a chat turn, or nil if the
    /// setting is off or permission isn't granted. Never throws, never
    /// blocks sending on failure — LocationProvider already degrades to nil
    /// for every failure mode.
    func currentChatLocation() async -> ChatLocation? {
        guard useLocation else { return nil }
        guard let loc = await LocationProvider.shared.currentLocation() else { return nil }
        return ChatLocation(
            latitude: loc.coordinate.latitude,
            longitude: loc.coordinate.longitude,
            accuracyMeters: loc.horizontalAccuracy >= 0 ? loc.horizontalAccuracy : nil,
            ageSeconds: -loc.timestamp.timeIntervalSinceNow
        )
    }

    func sendChat(_ text: String, images: [String] = [], speakReply: Bool = false) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // The key identifying *this* conversation for as long as this send
        // takes — its real session id, or `chatDraftKey` if it doesn't have
        // one yet (a brand-new chat's first message). Captured now, before
        // anything async: if the user switches to a different conversation
        // (or starts another brand-new one) before this reply lands, that
        // switch gets its own key, and this send's completion below only
        // touches the screen if `key` is still what's active.
        let key = activeChatKey
        guard !trimmed.isEmpty, !chatPendingKeys.contains(key) else { return }
        let startedFromSessionID = activeChatSessionID // nil for a brand-new chat
        chatMessages.append(ChatMessage(role: "user", text: trimmed, images: images))
        chatPendingKeys.insert(key)
        chatLiveStepsByKey[key] = []
        let turnId = UUID().uuidString

        // A plain `Task` here gets essentially no CPU time once the user
        // backgrounds the app mid-turn — BackgroundExecution.extend buys a
        // little (iOS-capped) extra time so a typical turn can still finish
        // and post its "reply is ready" notification instead of silently
        // going quiet until the app is reopened. See Notifications.swift.
        BackgroundExecution.extend("chat-turn") { [self] in
            // live step polling for the duration of the turn
            let poller = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(1))
                    guard let self else { return }
                    if let s = try? await self.api.turnSteps(turnId) {
                        await MainActor.run { self.chatLiveStepsByKey[key] = s.steps }
                        if s.done { return }
                    }
                }
            }
            defer { poller.cancel() }

            do {
                // Private Chat only — never attached to a family Messages
                // send (see agent-core's get_current_location).
                let location = await currentChatLocation()
                let resp = try await api.chat(trimmed, images: images,
                                              sessionId: startedFromSessionID, turnId: turnId,
                                              location: location)
                chatPendingKeys.remove(key)
                chatLiveStepsByKey[key] = nil
                let stillOnScreen = activeChatKey == key
                if stillOnScreen {
                    if startedFromSessionID == nil { activeChatSessionID = resp.sessionId }
                    chatMessages.append(ChatMessage(role: "assistant", text: resp.reply,
                                                    references: resp.references, steps: resp.steps, cards: resp.cards))
                    if speakReply || autoRead {
                        speak(resp.reply)
                    }
                }
                // Skip the notification if the user is right here watching
                // this exact conversation arrive — not just Chat in general,
                // since another one of their sessions may have finished
                // while a different one is on screen.
                if notifyOnReply, !(isAppForeground && isChatScreenActive && stillOnScreen) {
                    let sessionId = resp.sessionId
                    ReplyNotifications.hasPermission { granted in
                        if granted { ReplyNotifications.postChatReply(sessionId: sessionId, body: resp.reply) }
                    }
                }
                await refreshChatSessions()
            } catch APIError.unauthorized {
                chatPendingKeys.remove(key)
                chatLiveStepsByKey[key] = nil
                settings.clearSession()
                auth = .needLogin(serverURL: serverURL, serverName: settings.session?.serverName ?? "", error: "Your session expired.")
            } catch {
                chatPendingKeys.remove(key)
                chatLiveStepsByKey[key] = nil
                if activeChatKey == key {
                    chatMessages.append(ChatMessage(role: "error", text: error.localizedDescription))
                }
            }
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

