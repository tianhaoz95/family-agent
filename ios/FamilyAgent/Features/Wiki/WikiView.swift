import SwiftUI

/// The family wiki's page list — every page is shared, no private/shared
/// toggle (see docs/DECISIONS.md → "Family wiki"). Tapping a page pushes the
/// editor; "+" creates a new one and opens straight into it.
struct WikiView: View {
    @Environment(AppModel.self) private var model
    @State private var pushed: WikiPage?
    @State private var showNewPageAlert = false
    @State private var newTitle = ""

    var body: some View {
        ScreenScaffold(title: "Wiki", subtitle: "A shared notebook for the family \u{2014} anyone can read and edit any page.") {
            VStack(alignment: .leading, spacing: 10) {
                Button { showNewPageAlert = true } label: {
                    Label("New page", systemImage: "plus")
                }
                .buttonStyle(.soft)

                if model.wikiPages.isEmpty {
                    EmptyState(text: "No pages yet. Start the family notebook with one.", systemImage: "book")
                } else {
                    ForEach(model.wikiPages) { p in
                        Button { pushed = p } label: {
                            AppCard {
                                HStack(spacing: 8) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(p.title).appTitleSmall().lineLimit(2)
                                        Text("Edited by \(p.updatedByName)")
                                            .appLabelSmall().foregroundStyle(Theme.textMuted)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(Theme.textFaint)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button(role: .destructive) { model.deleteWikiPage(p.id) {} } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }
        }
        .navigationDestination(item: $pushed) { page in WikiPageEditorView(pageId: page.id) }
        .alert("New page", isPresented: $showNewPageAlert) {
            TextField("Title", text: $newTitle)
            Button("Cancel", role: .cancel) { newTitle = "" }
            Button("Create") {
                let t = newTitle
                newTitle = ""
                guard !t.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                model.createWikiPage(title: t) { page in pushed = page }
            }
        }
        .task { await model.refreshWikiPages() }
        .refreshable { await model.refreshWikiPages() }
    }
}

/// One page, edited as rich text — a family member formats with the
/// toolbar (Bold, headings, lists) rather than typing Markdown syntax; the
/// page is still stored (and read by every other client) as plain Markdown,
/// converted at load/save via `MarkdownRichText`. See docs/DECISIONS.md →
/// "Family wiki". Loads its own fresh copy on appear (the list row's
/// `WikiPage` may be stale) — same "list is light, one item is fetched
/// fresh" shape the gallery viewer uses.
///
/// Pushed (never a sheet), so — exactly like `ArtifactViewerView` — it
/// relies on `NavigationStack`'s own back chevron rather than a custom
/// button, and sets `model.wikiPageOpen` so `MainShell` hides its floating
/// menu button while that chevron is showing in the same top-left corner.
struct WikiPageEditorView: View {
    let pageId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var bodyAttributed = NSAttributedString(string: "")
    @State private var canUndo = false
    @State private var status = ""
    @State private var showDeleteConfirm = false
    @State private var loaded = false
    @State private var richController = RichTextController()
    @State private var comments: [WikiComment] = []
    @State private var showComments = false
    @State private var pendingCommentAnchor: NewWikiCommentRequest?
    private var openCommentCount: Int { comments.filter { $0.status == "open" }.count }

    // ---- autosave ----
    // No Save button — every edit to the title or body debounces into a save
    // a beat after the user pauses, the same pattern as other auto-saving
    // fields elsewhere in the app (e.g. Settings' retention rows). `nil`
    // means "nothing loaded yet" (skip); once loaded, this is always the
    // (title, body) pair the server actually has, so a programmatic content
    // change that already matches it — right after a revert, or right after
    // a save completes — doesn't trigger a redundant, no-op PATCH.
    @State private var lastSavedTitle: String?
    @State private var lastSavedMarkdown: String?
    @State private var saving = false
    @State private var savePending = false
    @State private var saveTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TextField("Page title", text: $title)
                .font(.inter(18, .bold))
                .textFieldStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)

            RichTextToolbar(controller: richController)
            Divider()

            RichTextEditor(attributedText: $bodyAttributed, controller: richController)
                .padding(.horizontal, 10)

            HStack(spacing: 10) {
                if canUndo {
                    Button("Undo last edit") {
                        model.revertWikiPage(pageId) { page in
                            guard let page else { return }
                            title = page.title; bodyAttributed = MarkdownRichText.toAttributed(page.body); canUndo = page.prevBody != nil
                            lastSavedTitle = page.title; lastSavedMarkdown = page.body
                            status = "Reverted to the previous version."
                        }
                    }
                    .buttonStyle(.soft)
                }
                if !status.isEmpty {
                    Text(status).appBodySmall().foregroundStyle(Theme.textMuted)
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .onChange(of: title) { _, _ in scheduleWikiSave() }
        .onChange(of: bodyAttributed) { _, _ in scheduleWikiSave() }
        .navigationTitle(title.isEmpty ? "Page" : title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    let anchor = richController.currentSelectionQuote()
                    pendingCommentAnchor = anchor.map { NewWikiCommentRequest(body: "", quote: $0.quote, prefix: $0.prefix, suffix: $0.suffix) }
                    showComments = true
                } label: {
                    Label("\(comments.count)", systemImage: openCommentCount > 0 ? "bubble.left.and.exclamationmark.bubble.right" : "bubble.left.and.bubble.right")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(role: .destructive) { showDeleteConfirm = true } label: {
                        Label("Delete", systemImage: "trash")
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .alert("Delete this page?", isPresented: $showDeleteConfirm) {
            Button("Delete", role: .destructive) { model.deleteWikiPage(pageId) { dismiss() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This can't be undone.")
        }
        .sheet(isPresented: $showComments) {
            WikiCommentsSheet(
                comments: comments,
                pendingAnchor: $pendingCommentAnchor,
                onAdd: { req in await addComment(req) },
                onDelete: { cid in await deleteComment(cid) },
                onResolve: { cid in await resolveComment(cid) },
                onReopen: { cid in await reopenComment(cid) },
                onReply: { cid, body in await replyToComment(cid, body) }
            )
            .presentationDetents([.medium, .large])
        }
        .onAppear { model.wikiPageOpen = true }
        .onDisappear { model.wikiPageOpen = false }
        .task {
            guard !loaded else { return }
            loaded = true
            if let page = await model.perform({ try await model.api.getWikiPage(pageId) }) {
                title = page.title; bodyAttributed = MarkdownRichText.toAttributed(page.body); canUndo = page.prevBody != nil
                lastSavedTitle = page.title; lastSavedMarkdown = page.body
            }
            await model.ensureFamilyMembersLoaded()
            await refreshComments()
        }
    }

    private func scheduleWikiSave() {
        // Not loaded yet — the initial assignment above would otherwise
        // schedule a spurious, idempotent save.
        guard lastSavedTitle != nil else { return }
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(0.8))
            guard !Task.isCancelled else { return }
            let markdown = MarkdownRichText.toMarkdown(bodyAttributed)
            if title == lastSavedTitle && markdown == lastSavedMarkdown { return }
            performWikiSave()
        }
    }

    private func performWikiSave() {
        if saving {
            // A newer edit arrived while a save was already in flight — this
            // same call would otherwise overwrite it with a stale body.
            // Re-run once the in-flight one lands.
            savePending = true
            return
        }
        saving = true
        status = "Saving\u{2026}"
        let t = title
        let markdown = MarkdownRichText.toMarkdown(bodyAttributed)
        model.saveWikiPage(pageId, title: t, body: markdown) { page in
            saving = false
            if let page {
                canUndo = page.prevBody != nil
                lastSavedTitle = t
                lastSavedMarkdown = markdown
                status = "Saved \u{2014} last edited by \(page.updatedByName)."
            } else {
                status = "Couldn't save."
            }
            if savePending {
                savePending = false
                performWikiSave()
            }
        }
    }

    private func refreshComments() async {
        comments = (await model.perform { try await model.api.wikiComments(pageId) }) ?? comments
    }
    private func addComment(_ req: NewWikiCommentRequest) async {
        guard let c = await model.perform({ try await model.api.addWikiComment(pageId, req) }) else { return }
        comments.append(c)
        pendingCommentAnchor = nil
    }
    private func deleteComment(_ cid: String) async {
        _ = await model.perform { try await model.api.deleteWikiComment(pageId, cid) }
        comments.removeAll { $0.id == cid }
    }
    private func resolveComment(_ cid: String) async {
        if let c = await model.perform({ try await model.api.resolveWikiComment(pageId, cid) }),
           let i = comments.firstIndex(where: { $0.id == cid }) {
            comments[i] = c
        }
    }
    private func reopenComment(_ cid: String) async {
        if let c = await model.perform({ try await model.api.reopenWikiComment(pageId, cid) }),
           let i = comments.firstIndex(where: { $0.id == cid }) {
            comments[i] = c
        }
    }
    /// A reply — mentioning @agent brings the assistant into the thread,
    /// possibly with a revised page body, which lands back here too.
    private func replyToComment(_ cid: String, _ body: String) async {
        guard let r = await model.perform({ try await model.api.replyToWikiComment(pageId, cid, body: body) }) else { return }
        if let i = comments.firstIndex(where: { $0.id == cid }) { comments[i] = r.comment }
        bodyAttributed = MarkdownRichText.toAttributed(r.page.body)
        canUndo = r.page.prevBody != nil
        lastSavedTitle = title
        lastSavedMarkdown = r.page.body
    }
}

// MARK: - Comments sheet

private struct WikiCommentsSheet: View {
    let comments: [WikiComment]
    @Binding var pendingAnchor: NewWikiCommentRequest?
    let onAdd: (NewWikiCommentRequest) async -> Void
    let onDelete: (String) async -> Void
    let onResolve: (String) async -> Void
    let onReopen: (String) async -> Void
    let onReply: (String, String) async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    var body: some View {
        NavigationStack {
            List {
                if let anchor = pendingAnchor {
                    Section("New comment") {
                        if let q = anchor.quote, !q.isEmpty {
                            Text("\u{201c}\(q.prefix(140))\u{201d}").font(.inter(12)).foregroundStyle(Theme.textMuted)
                        }
                        TextField("What should change here? (or a question)", text: $draft, axis: .vertical)
                            .lineLimit(2...5)
                        HStack {
                            Button("Cancel") { pendingAnchor = nil; draft = "" }
                            Spacer()
                            Button("Comment") {
                                let req = NewWikiCommentRequest(body: draft, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix)
                                Task { await onAdd(req); draft = "" }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                } else {
                    Section {
                        Button {
                            pendingAnchor = NewWikiCommentRequest(body: "")
                        } label: {
                            Label("Comment on the whole page", systemImage: "plus.bubble")
                        }
                    }
                }

                Section(comments.isEmpty ? "" : "Comments") {
                    if comments.isEmpty {
                        Text("Select text in the page, then tap the comment button — or comment on the whole page above.")
                            .font(.inter(13)).foregroundStyle(Theme.textMuted)
                    }
                    ForEach(comments) { c in
                        CommentThreadCard(
                            quote: c.quote,
                            commentBody: c.body,
                            authorLabel: c.userName,
                            replies: c.replies,
                            status: c.status,
                            onReply: { body in await onReply(c.id, body) },
                            onResolve: { await onResolve(c.id) },
                            onReopen: { await onReopen(c.id) },
                            onDelete: { await onDelete(c.id) }
                        )
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("Comments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
    }
}
