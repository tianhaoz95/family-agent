import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

private let SEARCH_MODES: [(String, String)] = [
    ("hybrid", "Smart"), ("keyword", "Exact"), ("fuzzy", "Fuzzy"), ("semantic", "Meaning"),
]

private struct DocRow: Identifiable {
    let id: String
    let filename: String
    let category: String?
    let summary: String?
    let extractionStatus: String
    let snippet: String?
}

struct DocumentsView: View {
    @Environment(AppModel.self) private var model
    @State private var showImporter = false
    @State private var photoItem: PhotosPickerItem?
    @State private var pasteExpanded = false
    @State private var pasteFilename = ""
    @State private var pasteText = ""
    @State private var renaming: Document?

    private var searchActive: Bool { !model.documentSearchQuery.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Documents",
                           subtitle: "Upload a PDF or photo, or scan a document with the camera.") {
                VStack(alignment: .leading, spacing: 12) {
                    searchField
                    if searchActive {
                        BrandSegmented(options: SEARCH_MODES,
                                       selection: Binding(get: { model.documentSearchMode },
                                                          set: { model.setDocumentSearch(query: model.documentSearchQuery, mode: $0) }))
                        if let note = searchNote {
                            Text(note).appLabelSmall().foregroundStyle(Theme.textMuted)
                        }
                    }

                    HStack(spacing: 8) {
                        Button { showImporter = true } label: {
                            Label("Upload", systemImage: "arrow.up.doc").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.ghost)
                        PhotosPicker(selection: $photoItem, matching: .images) {
                            Label("Scan", systemImage: "camera")
                                .font(.inter(14, .semibold)).foregroundStyle(Theme.accent)
                                .frame(maxWidth: .infinity).padding(.vertical, 9)
                                .background(Theme.accentSoft, in: Capsule())
                                .overlay(Capsule().strokeBorder(Theme.accent.opacity(0.12), lineWidth: 1))
                        }
                    }
                    if let s = model.documentUploadStatus {
                        Text(s).appLabelSmall().foregroundStyle(Theme.textMuted)
                    }

                    DisclosureGroup(isExpanded: $pasteExpanded) {
                        VStack(spacing: 8) {
                            TextField("Filename, e.g. electric-bill.txt", text: $pasteFilename)
                                .textFieldStyle(.roundedBorder)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                            TextField("Paste the document text here", text: $pasteText, axis: .vertical)
                                .lineLimit(4...8)
                                .textFieldStyle(.roundedBorder)
                            Button("Ingest") {
                                guard !pasteFilename.isEmpty, !pasteText.isEmpty else { return }
                                model.ingestDocument(filename: pasteFilename, text: pasteText)
                                pasteFilename = ""; pasteText = ""; pasteExpanded = false
                            }
                            .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        .padding(.top, 6)
                    } label: {
                        Text("Paste text directly").font(.inter(14, .medium)).foregroundStyle(Theme.accent)
                    }

                    Spacer().frame(height: 2)
                    documentList
                }
            }
        }
        .task { await model.refreshDocuments() }
        .task {
            while !Task.isCancelled {
                if model.documents.contains(where: { $0.extractionStatus == "pending" }) {
                    await model.refreshDocuments()
                }
                try? await Task.sleep(for: .seconds(3))
            }
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            guard case let .success(urls) = result, let url = urls.first else { return }
            let ok = url.startAccessingSecurityScopedResource()
            defer { if ok { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return }
            model.uploadDocument(filename: url.lastPathComponent, bytes: data,
                                 mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType)
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    model.uploadDocument(filename: "scan-\(Int(Date().timeIntervalSince1970)).jpg",
                                         bytes: data, mime: "image/jpeg")
                }
                photoItem = nil
            }
        }
        .sheet(item: $renaming) { RenameDocumentSheet(doc: $0) }
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").font(.system(size: 15)).foregroundStyle(Theme.textMuted)
            TextField("Search — by name, content, or meaning", text: Binding(
                get: { model.documentSearchQuery },
                set: { model.setDocumentSearch(query: $0, mode: model.documentSearchMode) }
            ))
            if searchActive {
                Button {
                    model.setDocumentSearch(query: "", mode: model.documentSearchMode)
                } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.textFaint) }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.R.md))
        .overlay(RoundedRectangle(cornerRadius: Theme.R.md).stroke(Theme.border, lineWidth: 1))
    }

    private var searchNote: String? {
        if model.documentSearchMode == "semantic" && !model.semanticSearchEnabled {
            return "No embedding model on the server — showing keyword + fuzzy results."
        }
        if model.documentSearching { return "Searching…" }
        if let r = model.documentSearchResults {
            return "\(r.count) \(r.count == 1 ? "match" : "matches")"
        }
        return nil
    }

    private var rows: [DocRow] {
        if searchActive {
            return (model.documentSearchResults ?? []).map {
                DocRow(id: $0.id, filename: $0.filename, category: $0.category, summary: $0.summary,
                       extractionStatus: $0.extractionStatus, snippet: $0.snippet.isEmpty ? nil : $0.snippet)
            }
        }
        return model.documents.map {
            DocRow(id: $0.id, filename: $0.filename, category: $0.extracted?.category,
                   summary: $0.extracted?.summary, extractionStatus: $0.extractionStatus, snippet: nil)
        }
    }

    @ViewBuilder
    private var documentList: some View {
        if searchActive && model.documentSearchResults == nil {
            EmptyView()   // first search in flight — the "Searching…" note covers it
        } else if searchActive && rows.isEmpty {
            EmptyState(text: "No documents match \u{201C}\(model.documentSearchQuery)\u{201D}.", systemImage: "magnifyingglass")
        } else if !searchActive && rows.isEmpty {
            EmptyState(text: "No documents yet. Upload or scan one to get started.", systemImage: "folder")
        } else {
            ForEach(rows) { row in
                DocumentCard(row: row, query: model.documentSearchQuery,
                             onPreview: { model.openDocumentDetail(row.id) },
                             onRename: { renaming = model.documents.first { $0.id == row.id }
                                 ?? Document(id: row.id, filename: row.filename, rawText: "", createdAt: "") },
                             onDelete: { model.deleteDocument(row.id) },
                             onRetry: { model.retryExtraction(row.id) })
            }
        }
    }
}

private struct DocumentCard: View {
    let row: DocRow
    let query: String
    let onPreview: () -> Void
    let onRename: () -> Void
    let onDelete: () -> Void
    let onRetry: () -> Void

    var body: some View {
        AppCard(onTap: onPreview) {
            HStack(spacing: 8) {
                Text(row.filename).appTitleSmall().lineLimit(1)
                Spacer()
                if let cat = row.category { Chip(text: cat) }
                Button(action: onRename) {
                    Image(systemName: "pencil").font(.system(size: 15)).foregroundStyle(Theme.textMuted)
                }.buttonStyle(.plain)
                Button(action: onDelete) {
                    Image(systemName: "trash").font(.system(size: 15)).foregroundStyle(Theme.textMuted)
                }.buttonStyle(.plain)
            }
            Spacer().frame(height: 6)
            if let sum = row.summary {
                Text(sum).appBodySmall().foregroundStyle(Theme.textMuted)
            } else if row.extractionStatus == "failed" {
                HStack(spacing: 8) {
                    Text("Couldn't read this document.").appBodySmall().foregroundStyle(Theme.danger)
                    Button("Retry", action: onRetry).font(.inter(12))
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini)
                    Text("Extracting…").appBodySmall().foregroundStyle(Theme.textMuted)
                }
            }
            if let snippet = row.snippet {
                Spacer().frame(height: 6)
                Text(highlight(snippet, query))
                    .appBodySmall().foregroundStyle(Theme.textMuted)
                    .lineLimit(3)
            }
        }
    }

    /// Bold 3+ char query tokens wherever they appear (mirrors Android `highlightTerms`).
    private func highlight(_ text: String, _ query: String) -> AttributedString {
        var out = AttributedString(text)
        let terms = Set(query.lowercased()
            .split { !$0.isLetter && !$0.isNumber }
            .map(String.init)
            .filter { $0.count >= 3 })
        guard !terms.isEmpty else { return out }
        let lower = text.lowercased()
        for term in terms {
            var search = lower.startIndex
            while let r = lower.range(of: term, range: search..<lower.endIndex) {
                let lo = lower.distance(from: lower.startIndex, to: r.lowerBound)
                let hi = lower.distance(from: lower.startIndex, to: r.upperBound)
                let a = out.characters.index(out.startIndex, offsetBy: lo)
                let b = out.characters.index(out.startIndex, offsetBy: hi)
                out[a..<b].font = .inter(13, .bold)
                search = r.upperBound
            }
        }
        return out
    }
}

struct RenameDocumentSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let doc: Document
    @State private var name = ""
    @State private var suggesting = false
    @State private var byAgent = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                    .onChange(of: name) { _, _ in byAgent = false }
                Button {
                    suggesting = true
                    Task {
                        if let s = await model.suggestDocumentName(doc.id) { name = s; byAgent = true }
                        suggesting = false
                    }
                } label: {
                    if suggesting {
                        HStack { ProgressView().controlSize(.small); Text("Thinking…") }
                    } else {
                        Label("Suggest with agent", systemImage: "sparkles")
                    }
                }
                .disabled(suggesting)
                if byAgent {
                    Text("Agent suggestion — edit it or tap Save to confirm.")
                        .appLabelSmall().foregroundStyle(Theme.textMuted)
                }
            }
            .navigationTitle("Rename document").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        model.renameDocument(doc.id, filename: name.trimmingCharacters(in: .whitespaces), byAgent: byAgent)
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || name.trimmingCharacters(in: .whitespaces) == doc.filename)
                }
            }
            .onAppear { name = doc.filename }
        }
    }
}
