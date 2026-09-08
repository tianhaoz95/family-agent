import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        ZStack {
            Atmosphere()
            switch model.auth {
            case .unknown:
                Color.clear
            case .pickServer:
                DiscoveryView()
            case .needLogin(let url, let name, let error):
                LoginView(serverURL: url, serverName: name, error: error)
            case .authed:
                MainShell()
            }
        }
        .background(Theme.canvas)
        .tint(Theme.accent)
        .sheet(item: $model.detail) { DetailSheet(content: $0) }
        .sheet(item: Binding(get: { model.externalURL.map(IdentifiedURL.init) },
                             set: { model.externalURL = $0?.url })) { wrapped in
            SafariView(url: wrapped.url)
        }
    }
}

private struct IdentifiedURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
    init(_ url: URL) { self.url = url }
}
