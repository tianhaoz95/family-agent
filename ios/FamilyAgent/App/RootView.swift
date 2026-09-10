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
        .fullScreenCover(item: Binding(get: { model.viewingArtifactId.map(IdentifiedString.init) },
                                       set: { model.viewingArtifactId = $0?.value })) { wrapped in
            ArtifactViewerView(artifactId: wrapped.value)
        }
    }
}

private struct IdentifiedURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
    init(_ url: URL) { self.url = url }
}

private struct IdentifiedString: Identifiable {
    let value: String
    var id: String { value }
    init(_ value: String) { self.value = value }
}
