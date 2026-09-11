import SwiftUI
import WebKit

/// Full-screen viewer for one artifact. Loads `GET /artifacts/:id` and renders
/// the wrapped document in a sealed `WKWebView` — opaque origin (`baseURL: nil`),
/// every network load blocked, navigation denied after the first load.
///
/// Highlight-and-comment: selecting text in the page shows an in-page "Comment"
/// button; tapping it hands the quote to the app, which opens the comments sheet
/// with a composer. The sheet lists comments and can ask the assistant to
/// address them (it edits the artifact or replies).
struct ArtifactViewerView: View {
    let artifactId: String
    var presentedAsSheet: Bool = true

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var artifact: Artifact?
    @State private var comments: [ArtifactComment] = []
    @State private var error: String?
    @State private var showSource = false
    @State private var showComments = false
    @State private var pendingAnchor: NewArtifactCommentRequest?
    @State private var working = false

    @State private var bridge = ArtifactWebBridge()

    private var openCount: Int { comments.filter { $0.status == "open" }.count }

    var body: some View {
        NavigationStack {
            Group {
                if let artifact {
                    SealedFullWebView(html: artifact.document, bridge: bridge)
                        .ignoresSafeArea(edges: .bottom)
                } else if let error {
                    ContentUnavailableView {
                        Label("Couldn't load this artifact", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Try Again") { Task { await load() } }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(artifact?.title ?? "Artifact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if presentedAsSheet {
                    ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showComments = true } label: {
                        Label("\(comments.count)", systemImage: openCount > 0 ? "bubble.left.and.exclamationmark.bubble.right" : "bubble.left.and.bubble.right")
                    }
                    .disabled(artifact == nil)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showSource = true } label: { Label("View source", systemImage: "chevron.left.forwardslash.chevron.right") }
                        if artifact?.canRevert == true {
                            Button { Task { await revert() } } label: { Label("Undo last edit", systemImage: "arrow.uturn.backward") }
                        }
                        if let a = artifact {
                            Button(role: .destructive) { model.deleteArtifact(a.id); dismiss() } label: { Label("Delete", systemImage: "trash") }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .disabled(artifact == nil)
                }
            }
            .overlay(alignment: .top) {
                if working {
                    Text("The assistant is working through the comments…")
                        .font(.inter(13)).padding(10)
                        .background(Theme.accentSoft, in: Capsule())
                        .foregroundStyle(Theme.accentInk)
                        .padding(.top, 6)
                }
            }
            .sheet(isPresented: $showSource) {
                if let a = artifact {
                    NavigationStack {
                        ScrollView { Text(a.html).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).padding() }
                            .navigationTitle("Source").navigationBarTitleDisplayMode(.inline)
                            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { showSource = false } } }
                    }
                }
            }
            .sheet(isPresented: $showComments) {
                ArtifactCommentsSheet(
                    comments: comments,
                    canRevert: artifact?.canRevert == true,
                    working: working,
                    pendingAnchor: $pendingAnchor,
                    onAdd: { req in await addComment(req) },
                    onAskAI: { ids in await resolve(ids) },
                    onDelete: { cid in await deleteComment(cid) },
                    onReopen: { cid in await reopen(cid) },
                    onRevert: { await revert() }
                )
                .presentationDetents([.medium, .large])
            }
        }
        .task(id: artifactId) { await load() }
        .onChange(of: comments) { pushComments() }
        .onAppear {
            bridge.onSelection = { req in
                pendingAnchor = req
                showComments = true
            }
            bridge.onReady = { pushComments() }
        }
    }

    private func pushComments() {
        bridge.setComments(comments)
    }

    private func load() async {
        error = nil; artifact = nil
        switch await model.loadArtifact(artifactId) {
        case .success(let r):
            artifact = r.artifact
            comments = r.comments
        case .notFound:
            error = "This artifact has been deleted."
        case .failed(let message):
            error = message
        }
    }

    private func addComment(_ req: NewArtifactCommentRequest) async {
        guard let c = await model.perform({ try await model.api.addArtifactComment(artifactId, req) }) else { return }
        comments.append(c)
        pendingAnchor = nil
        Task { await model.refreshArtifacts() }
    }
    private func deleteComment(_ cid: String) async {
        _ = await model.perform { try await model.api.deleteArtifactComment(artifactId, cid) }
        comments.removeAll { $0.id == cid }
        Task { await model.refreshArtifacts() }
    }
    private func reopen(_ cid: String) async {
        if let c = await model.perform({ try await model.api.reopenArtifactComment(artifactId, cid) }),
           let i = comments.firstIndex(where: { $0.id == cid }) {
            comments[i] = c
        }
    }
    private func resolve(_ ids: [String]?) async {
        working = true
        defer { working = false }
        if let r = await model.perform({ try await model.api.resolveArtifactComments(artifactId, commentIds: ids) }) {
            artifact = r.artifact
            comments = r.comments
            Task { await model.refreshArtifacts() }
        }
    }
    private func revert() async {
        if let r = await model.perform({ try await model.api.revertArtifact(artifactId) }) {
            artifact = r.artifact
            comments = r.comments
            Task { await model.refreshArtifacts() }
        }
    }
}

// MARK: - Comments sheet

private struct ArtifactCommentsSheet: View {
    let comments: [ArtifactComment]
    let canRevert: Bool
    let working: Bool
    @Binding var pendingAnchor: NewArtifactCommentRequest?
    let onAdd: (NewArtifactCommentRequest) async -> Void
    let onAskAI: ([String]?) async -> Void
    let onDelete: (String) async -> Void
    let onReopen: (String) async -> Void
    let onRevert: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    private var open: [ArtifactComment] { comments.filter { $0.status == "open" } }

    var body: some View {
        NavigationStack {
            List {
                if let anchor = pendingAnchor {
                    Section("New comment") {
                        if let q = anchor.quote, !q.isEmpty {
                            Text("“\(q.prefix(140))”").font(.inter(12)).foregroundStyle(Theme.textMuted)
                        }
                        TextField("What should change here? (or a question)", text: $draft, axis: .vertical)
                            .lineLimit(2...5)
                        HStack {
                            Button("Cancel") { pendingAnchor = nil; draft = "" }
                            Spacer()
                            Button("Comment") {
                                let req = NewArtifactCommentRequest(body: draft, quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix)
                                Task { await onAdd(req); draft = "" }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                }

                if !open.isEmpty {
                    Section {
                        Button {
                            Task { await onAskAI(nil) }
                        } label: {
                            Label("Ask the assistant to address \(open.count)", systemImage: "sparkles")
                        }
                        .disabled(working)
                    }
                }

                Section(comments.isEmpty ? "" : "Comments") {
                    if comments.isEmpty {
                        Text("Select text in the page to leave a comment.")
                            .font(.inter(13)).foregroundStyle(Theme.textMuted)
                    }
                    ForEach(comments) { c in
                        VStack(alignment: .leading, spacing: 5) {
                            if let q = c.quote, !q.isEmpty {
                                Text("“\(q.prefix(120))”")
                                    .font(.inter(12)).foregroundStyle(Theme.textMuted)
                                    .padding(.leading, 6)
                                    .overlay(alignment: .leading) { Rectangle().fill(Color.orange.opacity(0.6)).frame(width: 2) }
                            }
                            Text(c.body).font(.inter(14))
                            if c.status == "resolved" {
                                Text((c.resolvedBy == "agent" ? "Assistant: " : "") + (c.resolution ?? "Resolved."))
                                    .font(.inter(12)).foregroundStyle(Theme.textMuted)
                                Button("Reopen") { Task { await onReopen(c.id) } }.font(.inter(12))
                            } else {
                                HStack(spacing: 16) {
                                    Button("Ask AI") { Task { await onAskAI([c.id]) } }.disabled(working)
                                    Button("Delete", role: .destructive) { Task { await onDelete(c.id) } }
                                }
                                .font(.inter(12))
                            }
                        }
                        .opacity(c.status == "resolved" ? 0.7 : 1)
                    }
                }
            }
            .navigationTitle("Comments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if canRevert { Button("Undo edit") { Task { await onRevert() } } }
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
    }
}

// MARK: - The sealed web view + a bridge for comments

@Observable
final class ArtifactWebBridge {
    weak var webView: WKWebView?
    var onSelection: ((NewArtifactCommentRequest) -> Void)?
    var onReady: (() -> Void)?

    func setComments(_ comments: [ArtifactComment]) {
        let anchors = comments.map { ["id": $0.id, "quote": $0.quote ?? "", "prefix": $0.prefix ?? "", "suffix": $0.suffix ?? "", "status": $0.status] }
        guard let data = try? JSONSerialization.data(withJSONObject: anchors),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.__artifactApi && window.__artifactApi.setComments(\(json));", completionHandler: nil)
    }
}

private struct SealedFullWebView: UIViewRepresentable {
    let html: String
    let bridge: ArtifactWebBridge

    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.userContentController.add(context.coordinator, name: "artifact")

        let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default()?.compileContentRuleList(
            forIdentifier: "artifact-block-all", encodedContentRuleList: rules
        ) { list, _ in
            if let list { cfg.userContentController.add(list) }
        }

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.isOpaque = true
        web.backgroundColor = .systemBackground
        web.scrollView.contentInsetAdjustmentBehavior = .always
        web.loadHTMLString(html, baseURL: nil)
        bridge.webView = web
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let bridge: ArtifactWebBridge
        private var loaded = false
        init(bridge: ArtifactWebBridge) { self.bridge = bridge }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            bridge.onReady?()
        }
        @MainActor
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            decisionHandler(loaded ? .cancel : .allow)
        }
        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "artifact",
                  let s = message.body as? String,
                  let d = s.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let type = obj["type"] as? String else { return }
            if type == "artifact:selection", let quote = obj["quote"] as? String {
                bridge.onSelection?(NewArtifactCommentRequest(
                    body: "", quote: quote,
                    prefix: obj["prefix"] as? String, suffix: obj["suffix"] as? String))
            }
        }
    }
}
