import SwiftUI

struct DiscoveryView: View {
    @Environment(AppModel.self) private var model
    @State private var servers: [DiscoveredServer] = []
    @State private var manual = ServerDiscovery.manualEntryDefault
    @State private var showManual = false
    @State private var scanning = true
    @State private var scanID = UUID()
    @State private var showScanner = false

    private let discovery = ServerDiscovery()

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Find your home",
                           subtitle: "Choose the Family Agent server running on your home laptop.") {
                VStack(alignment: .leading, spacing: 12) {
                    Button {
                        showScanner = true
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder")
                            Text("Scan QR code")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.primary)
                    Text("On the desktop app: Settings → Pair a phone.")
                        .appBodySmall().foregroundStyle(Theme.textMuted)

                    if servers.isEmpty {
                        AppCard {
                            if scanning {
                                HStack(spacing: 12) {
                                    ProgressView()
                                    Text("Looking for your home server…").appBody()
                                }
                            } else {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("No server found automatically.")
                                        .appTitleSmall().foregroundStyle(Theme.text)
                                    Text("Automatic scan only sees the Wi-Fi this phone is on. Connecting from elsewhere — cellular, another network, or over Tailscale / a VPN — is normal: scan the QR code above, or type the address from the desktop's \u{201C}Pair a phone\u{201D} list. On the same Wi-Fi with still nothing, Family Agent may need Local Network access (Settings → Family Agent).")
                                        .appBodySmall().foregroundStyle(Theme.textBody)
                                }
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

                    Button(scanning ? "Scanning…" : "Scan again") {
                        servers = []
                        scanning = true
                        scanID = UUID()
                    }
                    .font(.inter(14, .medium))
                    .disabled(scanning)

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
        .task(id: scanID) {
            scanning = true
            for await found in discovery.discover() {
                servers = found
            }
        }
        .task(id: scanID) {
            try? await Task.sleep(for: .seconds(6))
            scanning = false
        }
        .sheet(isPresented: $showScanner) {
            NavigationStack {
                QRScanSheet { payload in
                    if let url = PairingPayload.serverURL(from: payload) {
                        model.pickServer(url)
                    }
                }
            }
        }
    }
}
