import SwiftUI

struct DiscoveryView: View {
    @Environment(AppModel.self) private var model
    @State private var servers: [DiscoveredServer] = []
    @State private var manual = ServerDiscovery.manualEntryDefault
    @State private var showManual = false
    @State private var scanning = true

    private let discovery = ServerDiscovery()

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Find your home",
                           subtitle: "Choose the Family Agent server running on your home laptop.") {
                VStack(alignment: .leading, spacing: 12) {
                    if servers.isEmpty {
                        AppCard {
                            if scanning {
                                HStack(spacing: 12) {
                                    ProgressView()
                                    Text("Looking for your home server…").appBody()
                                }
                            } else {
                                Text("No server found automatically. If the home laptop is on and running Family Agent, enter its address below — your Wi-Fi may be blocking discovery.")
                                    .appBody().foregroundStyle(Theme.textBody)
                            }
                        }
                    } else {
                        ForEach(servers) { server in
                            AppCard(onTap: { model.pickServer(server.url) }) {
                                Text(server.name).appTitle()
                                Text(server.url).appBodySmall().foregroundStyle(Theme.textMuted)
                            }
                        }
                    }

                    let manualOpen = showManual || (!scanning && servers.isEmpty)
                    Button(manualOpen ? "Hide manual entry" : "Enter an address manually") {
                        showManual.toggle()
                    }
                    .font(.inter(14, .medium))

                    if manualOpen {
                        TextField("Server address", text: $manual)
                            .textFieldStyle(.app)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                        Button {
                            model.pickServer(manual)
                        } label: {
                            Text("Connect").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.primary)
                        .disabled(manual.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .task {
            for await found in discovery.discover() {
                servers = found
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(6))
            scanning = false
        }
    }
}
