import SwiftUI
import WebKit

/// Runs a generated tool inside the app (mirrors Android `ToolWebViewScreen`).
/// The tool page is served from the local tools server with a strict CSP, so
/// this can keep JS + persistent storage on.
struct ToolWebView: View {
    let url: URL
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            ToolWK(url: url)
                .ignoresSafeArea(edges: .bottom)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { onClose() } label: { Image(systemName: "xmark") }
                    }
                }
        }
    }
}

private struct ToolWK: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()   // persistent localStorage for the tool
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.load(URLRequest(url: url))
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) {}
}
