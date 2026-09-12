import Foundation

extension AppModel {

    // MARK: Channel list

    func refreshChannels() async {
        if let c = await perform({ try await api.listChannels() }) {
            channels = c
            notifyOfResolvedAgentReplies(in: c)
        }
        if familyMembers.isEmpty {
            familyMembers = (await perform { try await api.listFamilyMembers() }) ?? []
        }
    }

    /// Diffs each poll's `lastMessage` against what was last notified about,
    /// per channel — so this repeating 8s poll (MainShell) doesn't re-notify
    /// for the same reply every time it comes back around. Seeded (not
    /// notified) on the very first call so existing history at app start
    /// doesn't fire a wall of notifications. Mirrors `refreshChannels()` in
    /// desktop's main.ts and `startChannelListPolling()` in AppViewModel.kt.
    private func notifyOfResolvedAgentReplies(in list: [Channel]) {
        for c in list {
            guard let lm = c.lastMessage, lm.senderId == AGENT_SENDER_ID, !lm.pending else { continue }
            let prev = lastNotifiedAgentReply[c.id]
            lastNotifiedAgentReply[c.id] = lm.createdAt
            guard channelNotifySeeded, prev != lm.createdAt else { continue }
            let alreadyOpen = isAppForeground && activeChannel?.id == c.id
            guard notifyOnReply, !alreadyOpen else { continue }
            ReplyNotifications.hasPermission { granted in
                if granted { ReplyNotifications.postChannelReply(channelId: c.id, channelTitle: c.title, body: lm.body) }
            }
        }
        channelNotifySeeded = true
    }

    func startConversation(memberIds: [String], name: String?, then open: @escaping (String) -> Void) {
        Task {
            let kind = memberIds.count > 1 || name != nil ? "group" : "dm"
            if let c = await perform({ try await api.createChannel(kind: kind, memberIds: memberIds, name: name) }) {
                await refreshChannels()
                open(c.id)
            }
        }
    }

    // MARK: Active conversation

    func openChannel(_ id: String) {
        activeChannel = channels.first { $0.id == id }
        channelMessages = []
        Task {
            activeChannel = await perform { try await api.getChannel(id) }
            channelMessages = (await perform { try await api.listMessages(id) }) ?? []
            if let last = channelMessages.last {
                await api.markChannelRead(id, ts: last.createdAt)
            }
            await refreshChannels()
        }
    }

    func closeChannel() {
        activeChannel = nil
        channelMessages = []
    }

    /// One poll tick — call from `ConversationView.task(id:)` on a 2.5s loop.
    func pollConversation(_ id: String) async {
        let after = channelMessages.last?.createdAt
        guard let fresh = await perform({ try await api.listMessages(id, after: after) }) else { return }
        var merged = channelMessages
        for m in fresh {
            if let idx = merged.firstIndex(where: { $0.id == m.id }) {
                merged[idx] = m
            } else {
                merged.append(m)
            }
        }
        // also refresh any still-pending agent messages (their id doesn't change)
        merged.sort { $0.createdAt < $1.createdAt }
        channelMessages = merged
        if let last = merged.last {
            await api.markChannelRead(id, ts: last.createdAt)
        }
    }

    func sendChannelMessage(_ body: String, mentionAgent: Bool, images: [String] = []) {
        guard let id = activeChannel?.id else { return }
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        channelSending = true
        Task {
            if let m = await perform({ try await api.postMessage(id, body: trimmed, mentionAgent: mentionAgent, images: images) }) {
                if !channelMessages.contains(where: { $0.id == m.id }) { channelMessages.append(m) }
            }
            channelSending = false
        }
    }

    func deleteChannel(_ id: String, then done: @escaping () -> Void) {
        Task {
            _ = await perform { try await api.deleteChannel(id) }
            await refreshChannels()
            done()
        }
    }

    func transcribeChannelVoice(_ wav: Data, into completion: @escaping (String) -> Void) {
        Task {
            channelTranscribing = true
            if let r = await perform({ try await api.transcribe(wav) }) { completion(r.text) }
            channelTranscribing = false
        }
    }
    func sendChannelVoice(_ wav: Data) {
        Task {
            channelTranscribing = true
            if let r = await perform({ try await api.transcribe(wav) }), !r.text.isEmpty {
                channelTranscribing = false
                sendChannelMessage(r.text, mentionAgent: false)
            } else {
                channelTranscribing = false
            }
        }
    }

    // MARK: Board

    func refreshNotes() async {
        if let n = await perform({ try await api.listNotes(scope: noteScope) }) { notes = n }
    }
    func setNoteScope(_ scope: String) {
        noteScope = scope
        Task { await refreshNotes() }
    }
    func addBlankNote(x: Double, y: Double, then created: @escaping (StickyNote) -> Void) {
        Task {
            if let n = await perform({ try await api.createNote(scope: noteScope, text: "", color: nil, x: x, y: y) }) {
                await refreshNotes()
                created(n)
            }
        }
    }
    /// Pins a "Draw" or "Photo" note — chosen from the board's "+" menu,
    /// mirroring desktop's #note-add-draw / #note-add-photo. `kind` is
    /// "drawing" or "photo"; a drawing carries no caption text.
    func addImageNote(kind: String, image: String, x: Double, y: Double) {
        Task {
            _ = await perform {
                try await api.createNote(scope: noteScope, kind: kind, text: "", image: image, color: nil, x: x, y: y)
            }
            await refreshNotes()
        }
    }
    func editNote(_ id: String, text: String?, color: String?) {
        Task { _ = await perform { try await api.updateNote(id, text: text, color: color) }; await refreshNotes() }
    }
    func moveNote(_ id: String, x: Double, y: Double) {
        // optimistic; no refresh (would flicker mid-drag)
        if let idx = notes.firstIndex(where: { $0.id == id }) {
            notes[idx].x = x
            notes[idx].y = y
        }
        Task { _ = try? await api.updateNote(id, x: x, y: y) }
    }
    func deleteNote(_ id: String) {
        Task { _ = await perform { try await api.deleteNote(id) }; await refreshNotes() }
    }
}
