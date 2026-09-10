import SwiftUI
import WebKit

/// Full-screen viewer for one artifact. Loads `GET /artifacts/:id` and renders
/// the wrapped document in a sealed `WKWebView` — opaque origin (`baseURL: nil`),
/// every network load blocked, navigation denied after the first load. Same
/// isolation as `CardView`'s `SealedWebView`, just full-size and scrollable.
struct ArtifactViewerView: View {
    let artifactId: String
    /// true when shown from a reply's chip (fullScreenCover — needs its own
    /// dismiss); false when pushed onto the Artifacts list's NavigationStack.
    var presentedAsSheet: Bool = true

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var artifact: Artifact?
    @State private var error: String?
    @State private var showSource = false

    var body: some View {
        NavigationStack {
            Group {
                if let artifact {
                    SealedFullWebView(html: artifact.document)
                        .ignoresSafeArea(edges: .bottom)
                } else if let error {
                    ContentUnavailableView("Couldn't load this artifact", systemImage: "exclamationmark.triangle", description: Text(error))
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(artifact?.title ?? "Artifact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if presentedAsSheet {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { showSource = true } label: { Label("View source", systemImage: "chevron.left.forwardslash.chevron.right") }
                        if let a = artifact {
                            Button(role: .destructive) {
                                model.deleteArtifact(a.id)
                                dismiss()
                            } label: { Label("Delete", systemImage: "trash") }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .disabled(artifact == nil)
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
        }
        .task(id: artifactId) {
            error = nil
            artifact = nil
            if let a = await model.loadArtifact(artifactId) { artifact = a }
            else { error = "This artifact may have been deleted." }
        }
    }
}

/// A sealed, scrollable full-page `WKWebView`. All network blocked, opaque
/// origin, navigation denied after the initial in-memory load.
private struct SealedFullWebView: UIViewRepresentable {
    let html: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()

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
        web.loadHTMLString(html, baseURL: nil)   // opaque origin
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private var loaded = false
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
        @MainActor
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            decisionHandler(loaded ? .cancel : .allow)
        }
    }
}
