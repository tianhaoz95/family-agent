import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var serverURLDraft = ""
    @State private var showAdvanced = false

    var body: some View {
        @Bindable var model = model
        ScrollView {
            ScreenScaffold(title: "Settings", subtitle: "This device, and machine-wide options.") {
                VStack(alignment: .leading, spacing: 14) {
                    AppCard {
                        HStack(spacing: 10) {
                            StatusDot(color: connectionColor)
                            Text(connectionLabel).appBodySmall().foregroundStyle(Theme.textMuted)
                        }
                    }

                    AppCard {
                        Text("Your account").appTitleSmall()
                        Text(model.currentUser?.displayName ?? "—").appBody()
                        if let role = model.currentUser?.role {
                            Chip(text: role, color: role == "admin" ? Theme.accent : Theme.skyWash)
                        }
                        Button(role: .destructive) { model.signOut() } label: {
                            Text("Sign out")
                        }
                        .padding(.top, 4)
                    }

                    if model.ttsEnabled {
                        AppCard {
                            Toggle("Read replies aloud automatically", isOn: Binding(
                                get: { model.autoRead },
                                set: { model.autoRead = $0 }
                            ))
                            .font(.inter(14))
                        }
                    }

                    if let s = model.serverSettings {
                        AppCard {
                            Toggle("Show visual cards in chat", isOn: Binding(
                                get: { s.cardsEnabled },
                                set: { model.setCardsEnabled($0) }
                            ))
                            .font(.inter(14))
                            .disabled(!s.isAdmin || s.envLocked.cardsEnabled)
                            if !s.isAdmin {
                                Text("Only an admin can change this.").appLabelSmall().foregroundStyle(Theme.textMuted)
                            } else if s.envLocked.cardsEnabled {
                                Text("Pinned by the server's environment.").appLabelSmall().foregroundStyle(Theme.textMuted)
                            }
                        }
                    }

                    DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Server address").appLabelSmall().foregroundStyle(Theme.textMuted)
                            TextField(model.serverURL, text: $serverURLDraft)
                                .textFieldStyle(.roundedBorder)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            Button("Change server") {
                                model.setServerURL(serverURLDraft.isEmpty ? model.serverURL : serverURLDraft)
                            }
                            .disabled(serverURLDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                        .padding(.top, 6)
                    }
                    .font(.inter(14, .medium))
                }
            }
        }
        .task {
            await model.refreshServerSettings()
            serverURLDraft = model.serverURL
        }
    }

    private var connectionColor: Color {
        switch model.connection {
        case .connecting: Theme.warn
        case .connected: Theme.ok
        case .unreachable: Theme.danger
        }
    }
    private var connectionLabel: String {
        switch model.connection {
        case .connecting: "Connecting…"
        case .connected(let m): "Connected · local · \(m)"
        case .unreachable: "Offline — check the address"
        }
    }
}
