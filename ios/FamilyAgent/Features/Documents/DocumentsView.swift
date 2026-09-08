import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct DocumentsView: View {
    @Environment(AppModel.self) private var model
    @State private var showImporter = false
    @State private var photoItem: PhotosPickerItem?
    @State private var pasteText = ""
    @State private var showPaste = false
    @State private var renaming: Document?

    private let modes: [(String, String)] = [("hybrid", "Smart"), ("keyword", "Exact"), ("fuzzy", "Fuzzy"), ("semantic", "Meaning")]

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Documents", subtitle: "Everything the family has filed away.") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Button { showImporter = true } label: { Label("Upload", systemImage: "arrow.up.doc") }
                            .buttonStyle(.borderedProminent)
                        PhotosPicker(selection: $photoItem, matching: .images) {
                            Label("Scan", systemImage: "camera")
                        }
                        .buttonStyle(.bordered)
                        Button { showPaste = true } label: { Image(systemName: "text.badge.plus") }
                            .buttonStyle(.bordered)
                    }
                    if let s = model.documentUploadStatus {
                        Text(s).appLabelSmall().foregroundStyle(Theme.textMuted)
                    }

                    TextField("Search documents", text: Binding(
                        get: { model.documentSearchQuery },
                        set: { model.setDocumentSearch(query: $0, mode: model.documentSearchMode) }
                    ))
                    .textFieldStyle(.roundedBorder)

                    Picker("", selection: Binding(
                        get: { model.documentSearchMode },
                        set: { model.setDocumentSearch(query: model.documentSearchQuery, mode: $0) }
                    )) {
                        ForEach(modes, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    .pickerStyle(.segmented)

                    if model.documentSearchMode == "semantic" && !model.semanticSearchEnabled {
                        Text("No embedding model on the server — falling back to keyword + fuzzy.")
                            .appLabelSmall().foregroundStyle(Theme.warn)
                    }

                    if let hits = model.documentSearchResults {
                        if model.documentSearching {
                            ProgressView()
                        } else if hits.isEmpty {
                            Text("No matches.").appBodySmall().foregroundStyle(Theme.textMuted)
                        } else {
                            Text("\(hits.count) match\(hits.count == 1 ? "" : "es")").appLabelSmall().foregroundStyle(Theme.textMuted)
                            ForEach(hits) { hit in
                                AppCard(onTap: { model.openDocumentDetail(hit.id) }) {
                                    Text(hit.filename).appTitleSmall()
                                    if !hit.snippet.isEmpty {
                                        Text(hit.snippet).appBodySmall().foregroundStyle(Theme.textBody).lineLimit(2)
                                    }
                                }
                            }
                        }
                    } else if model.documents.isEmpty {
                        EmptyState(text: "Nothing filed yet.", systemImage: "doc.text")
                    } else {
                        ForEach(model.documents) { doc in
                            DocumentCard(doc: doc,
                                         onOpen: { model.openDocumentDetail(doc.id) },
                                         onRename: { renaming = doc },
                                         onRetry: { model.retryExtraction(doc.id) },
                                         onDelete: { model.deleteDocument(doc.id) })
                        }
                    }
                }
            }
        }
        .task { await model.refreshDocuments() }
        .task {
            while !Task.isCancelled {
                if model.documents.contains(where: { $0.extractionStatus == "pending" }) {
                    try? await Task.sleep(for: .seconds(3))
                    await model.refreshDocuments()
                } else {
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            guard case let .success(urls) = result, let url = urls.first else { return }
            let ok = url.startAccessingSecurityScopedResource()
            defer { if ok { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
            model.uploadDocument(filename: url.lastPathComponent, bytes: data, mime: mime)
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self) {
                    model.uploadDocument(filename: "scan-\(Int(Date().timeIntervalSince1970)).jpg", bytes: data, mime: "image/jpeg")
                }
                photoItem = nil
            }
        }
        .alert("Paste text", isPresented: $showPaste) {
            TextField("Document text", text: $pasteText)
            Button("Add") {
                model.ingestDocument(filename: "note-\(Int(Date().timeIntervalSince1970)).txt", text: pasteText)
                pasteText = ""
            }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(item: $renaming) { doc in
            RenameDocumentSheet(doc: doc)
        }
    }
}

struct DocumentCard: View {
    @Environment(AppModel.self) private var model
    let doc: Document
    let onOpen: () -> Void
    let onRename: () -> Void
    let onRetry: () -> Void
    let onDelete: () -> Void

    var body: some View {
        AppCard {
            HStack {
                Text(doc.filename).appTitleSmall()
                Spacer()
                if let cat = doc.extracted?.category {
                    Chip(text: cat, color: Theme.marigold)
                }
            }
            if doc.extractionStatus == "pending" {
                Label("Extracting…", systemImage: "hourglass").appLabelSmall().foregroundStyle(Theme.warn)
            } else if doc.extractionStatus == "failed" {
                HStack {
                    Text("Extraction failed").appLabelSmall().foregroundStyle(Theme.danger)
                    Button("Retry", action: onRetry).font(.inter(12))
                }
            } else if let sum = doc.extracted?.summary, !sum.isEmpty {
                Text(sum).appBodySmall().foregroundStyle(Theme.textBody).lineLimit(2)
            }
            HStack {
                Button("Open", action: onOpen).font(.inter(13))
                Button("Rename", action: onRename).font(.inter(13))
                Spacer()
                Button("Delete", role: .destructive, action: onDelete).font(.inter(13))
            }
            .padding(.top, 4)
        }
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
                TextField("Filename", text: $name)
                    .onChange(of: name) { _, _ in byAgent = false }
                Button {
                    suggesting = true
                    Task {
                        if let s = await model.suggestDocumentName(doc.id) {
                            name = s; byAgent = true
                        }
                        suggesting = false
                    }
                } label: {
                    if suggesting { ProgressView() } else { Label("Suggest with agent", systemImage: "sparkles") }
                }
                .disabled(suggesting)
            }
            .navigationTitle("Rename").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        model.renameDocument(doc.id, filename: name, byAgent: byAgent)
                        dismiss()
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { name = doc.filename }
        }
    }
}
