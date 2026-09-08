import SwiftUI
import WebKit

/// A generated HTML card in a sealed `WKWebView`. Mirrors the Android
/// `CardWebView`: opaque origin (`baseURL: nil`), all network blocked (a
/// `WKContentRuleList` + a navigation-policy deny), a single height bridge.
struct CardView: View {
    let card: Card
    let onViewSource: () -> Void
    @State private var height: CGFloat = 80
    @State private var expanded = false

    private var cap: CGFloat { expanded ? 900 : 520 }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text("✨").font(.system(size: 12))
                Text(card.title).appLabel().foregroundStyle(Theme.text).lineLimit(1)
                Spacer()
                Button("Code", action: onViewSource)
                    .font(.inter(11, .medium)).foregroundStyle(Theme.textMuted)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(maxWidth: .infinity)
            .background(Theme.surfaceSunk)

            SealedWebView(html: card.html) { measured in
                height = measured
            }
            .frame(height: min(max(height, 60), cap))

            if height > cap - 4 || expanded {
                Button(expanded ? "Show less" : "Show all") { withAnimation { expanded.toggle() } }
                    .font(.inter(12, .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
        }
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.border, lineWidth: 1))
    }
}

private struct SealedWebView: UIViewRepresentable {
    let html: String
    let onHeight: (CGFloat) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onHeight: onHeight) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        let ucc = WKUserContentController()
        ucc.add(context.coordinator, name: "card")
        cfg.userContentController = ucc

        // Block every network load at the engine level (mirrors Android's
        // shouldInterceptRequest returning an empty response).
        let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default()?.compileContentRuleList(
            forIdentifier: "card-block-all", encodedContentRuleList: rules
        ) { list, _ in
            if let list { cfg.userContentController.add(list) }
        }

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.scrollView.isScrollEnabled = false
        web.isOpaque = false
        web.backgroundColor = .clear
        web.loadHTMLString(html, baseURL: nil)   // opaque origin
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let onHeight: (CGFloat) -> Void
        private var loaded = false
        init(onHeight: @escaping (CGFloat) -> Void) { self.onHeight = onHeight }

        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "card", let n = message.body as? NSNumber {
                onHeight(CGFloat(truncating: n))
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            webView.evaluateJavaScript(
                "window.webkit.messageHandlers.card.postMessage(document.body.scrollHeight);"
            )
        }
        @MainActor
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            // Allow only the initial in-memory load.
            decisionHandler(loaded ? .cancel : .allow)
        }
    }
}
