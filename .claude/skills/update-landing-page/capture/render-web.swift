// Render a URL or local HTML file to a PNG, headless, via WKWebView.
//
//   swift render-web.swift <url|path> <out.png> [flags]
//
//     --width N          viewport width  (default 1280)
//     --height N         viewport height (default 900)
//     --settle N         seconds to wait after load before capturing (default 4)
//     --token T          inject T as localStorage["familyAgent.token"], then reload
//     --click SELECTOR   click a CSS selector once loaded, then wait --settle again
//     --no-freeze        keep CSS transitions/animations live (see below)
//
// Why this exists: `screencapture` needs the Screen Recording permission, which
// is not granted here, so neither the site nor the desktop app can be captured
// the usual way. WKWebView renders its own content and needs no permission.
//
// The --no-freeze flag: an OFFSCREEN WKWebView never ticks CSS transitions. The
// desktop app animates each view in from opacity:0 / translateY(14px), so
// without freezing, every screenshot comes back with a correctly-sized, fully
// populated, completely invisible content area. By default this tool injects a
// stylesheet that disables transitions and forces `.view.is-active` to its
// settled state. Pass --no-freeze only if you are capturing something with no
// entry animation and want the real cascade.

import Cocoa
import WebKit

func arg(_ name: String, _ fallback: String? = nil) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return fallback }
    return a[i + 1]
}
func flag(_ name: String) -> Bool { CommandLine.arguments.contains(name) }

let a = CommandLine.arguments
guard a.count >= 3 else {
    FileHandle.standardError.write("usage: render-web.swift <url|path> <out.png> [flags]\n".data(using: .utf8)!)
    exit(2)
}
let target = a[1]
let out = URL(fileURLWithPath: a[2])
let width = Double(arg("--width") ?? "1280") ?? 1280
let height = Double(arg("--height") ?? "900") ?? 900
let settle = Double(arg("--settle") ?? "4") ?? 4
let token = arg("--token")
let click = arg("--click")
let freeze = !flag("--no-freeze")

let FREEZE_CSS = """
var s=document.createElement('style');
s.textContent='*{transition:none !important;animation:none !important}'
  + '.view.is-active{opacity:1 !important;transform:none !important}';
document.head.appendChild(s); true
"""

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

final class Delegate: NSObject, WKNavigationDelegate {
    var injectedToken = false

    func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
        // Seed auth first, then reload so the app boots signed in.
        if let token, !injectedToken {
            injectedToken = true
            w.evaluateJavaScript("localStorage.setItem('familyAgent.token','\(token)'); true") { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { w.reload() }
            }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + settle) {
            // Injecting a global `*` rule forces a full restyle. Snapshotting in
            // the same turn catches the document mid-repaint and images come back
            // blank, so always give the repaint a beat to finish.
            if freeze { w.evaluateJavaScript(FREEZE_CSS, completionHandler: nil) }
            guard let click else {
                return DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.snap(w) }
            }
            w.evaluateJavaScript("document.querySelector('\(click)').click(); true") { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + settle) {
                    // Re-apply: rendering a new view restarts its entry transition.
                    if freeze { w.evaluateJavaScript(FREEZE_CSS, completionHandler: nil) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.snap(w) }
                }
            }
        }
    }

    func snap(_ w: WKWebView) {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = CGRect(x: 0, y: 0, width: w.bounds.width, height: w.bounds.height)
        w.takeSnapshot(with: cfg) { image, err in
            guard let image,
                  let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                FileHandle.standardError.write(
                    "snapshot failed: \(err?.localizedDescription ?? "unknown")\n".data(using: .utf8)!)
                exit(1)
            }
            try? png.write(to: out)
            print(out.path)
            exit(0)
        }
    }

    func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { fail(e) }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { fail(e) }
    func fail(_ e: Error) {
        FileHandle.standardError.write("load failed: \(e.localizedDescription)\n".data(using: .utf8)!)
        exit(1)
    }
}

let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height))
let delegate = Delegate()
webView.navigationDelegate = delegate
let window = NSWindow(contentRect: webView.frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = webView

if target.hasPrefix("http://") || target.hasPrefix("https://") {
    webView.load(URLRequest(url: URL(string: target)!))
} else {
    let file = URL(fileURLWithPath: target)
    webView.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
}

// Don't hang forever if the page never finishes loading.
DispatchQueue.main.asyncAfter(deadline: .now() + settle + 60) {
    FileHandle.standardError.write("timed out\n".data(using: .utf8)!)
    exit(1)
}
app.run()
