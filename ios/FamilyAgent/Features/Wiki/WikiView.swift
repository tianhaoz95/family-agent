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

/// Edit/preview a single page. Loads its own fresh copy on appear (the list
/// row's `WikiPage` may be stale) — same "list is light, one item is fetched
/// fresh" shape the gallery viewer uses.
struct WikiPageEditorView: View {
    let pageId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var body_ = ""
    @State private var canUndo = false
    @State private var mode: Mode = .edit
    @State private var status = ""
    @State private var showDeleteConfirm = false
    @State private var loaded = false

    enum Mode { case edit, preview }

    var body: some View {
        ScreenScaffold(title: "Page", subtitle: "", hasMenuButton: false) {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Page title", text: $title)
                    .font(.inter(18, .bold))
                    .textFieldStyle(.plain)

                Picker("", selection: $mode) {
                    Text("Edit").tag(Mode.edit)
                    Text("Preview").tag(Mode.preview)
                }
                .pickerStyle(.segmented)

                if mode == .edit {
                    TextEditor(text: $body_)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 300)
                        .padding(8)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                } else {
                    ScrollView {
                        AgentMarkdown(text: body_)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(minHeight: 300)
                    .padding(8)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                }

                if !status.isEmpty {
                    Text(status).appBodySmall().foregroundStyle(Theme.textMuted)
                }

                HStack(spacing: 10) {
                    if canUndo {
                        Button("Undo last edit") {
                            model.revertWikiPage(pageId) { page in
                                guard let page else { return }
                                title = page.title; body_ = page.body; canUndo = page.prevBody != nil
                                status = "Reverted to the previous version."
                            }
                        }
                        .buttonStyle(.soft)
                    }
                    Button("Delete", role: .destructive) { showDeleteConfirm = true }
                        .buttonStyle(.soft)
                    Spacer()
                    Button("Save") {
                        status = "Saving\u{2026}"
                        model.saveWikiPage(pageId, title: title, body: body_) { page in
                            guard let page else { status = "Couldn't save."; return }
                            canUndo = page.prevBody != nil
                            status = "Saved \u{2014} last edited by \(page.updatedByName)."
                        }
                    }
                    .buttonStyle(.primary)
                }
            }
            .padding(.horizontal, 16)
        }
        .alert("Delete this page?", isPresented: $showDeleteConfirm) {
            Button("Delete", role: .destructive) { model.deleteWikiPage(pageId) { dismiss() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This can't be undone.")
        }
        .task {
            guard !loaded else { return }
            loaded = true
            if let page = await model.perform({ try await model.api.getWikiPage(pageId) }) {
                title = page.title; body_ = page.body; canUndo = page.prevBody != nil
            }
        }
    }
}
