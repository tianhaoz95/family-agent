import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var serverURLDraft = ""
    @State private var showAdvanced = false

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Settings",
                           subtitle: "Your account and this device\u{2019}s connection.") {
                VStack(alignment: .leading, spacing: 0) {
                    AppCard {
                        HStack(spacing: 10) {
                            StatusDot(color: connectionColor)
                            Text(connectionLabel).appBody()
                        }
                    }

                    if model.ttsEnabled {
                        section("Voice")
                        Toggle(isOn: Binding(get: { model.autoRead }, set: { model.autoRead = $0 })) {
                            Text("Read replies aloud automatically").appBody()
                        }
                        .padding(.vertical, 4)
                    }

                    if let s = model.serverSettings {
                        section("Assistant")
                        Toggle(isOn: Binding(get: { s.cardsEnabled }, set: { model.setCardsEnabled($0) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Show visual cards").appBody()
                                Text(cardsHint(s)).appLabelSmall().foregroundStyle(Theme.textMuted)
                            }
                        }
                        .disabled(!s.isAdmin || s.envLocked.cardsEnabled)
                        .padding(.vertical, 4)
                    }

                    section("Signed in as")
                    HStack(spacing: 8) {
                        Text(model.currentUser?.displayName ?? "").appBody()
                        if let role = model.currentUser?.role, !role.isEmpty { Chip(text: role) }
                    }
                    Spacer().frame(height: 12)
                    Button { model.signOut() } label: { Text("Sign out") }
                        .buttonStyle(.ghost)

                    Spacer().frame(height: 24)
                    Button(showAdvanced ? "Hide advanced" : "Advanced") { showAdvanced.toggle() }
                        .font(.inter(14, .medium))
                    if showAdvanced {
                        section("Server address")
                        TextField("http://192.168.1.2:4173", text: $serverURLDraft)
                            .textFieldStyle(.roundedBorder)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Spacer().frame(height: 10)
                        Button("Save & reconnect") {
                            model.setServerURL(serverURLDraft.isEmpty ? model.serverURL : serverURLDraft)
                        }
                        .buttonStyle(.primary)
                        .disabled(serverURLDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .task {
            await model.refreshServerSettings()
            serverURLDraft = model.serverURL
        }
    }

    @ViewBuilder
    private func section(_ label: String) -> some View {
        Spacer().frame(height: 18)
        Text(label.uppercased())
            .font(.inter(11.5, .bold)).tracking(0.3)
            .foregroundStyle(Theme.textMuted)
        Spacer().frame(height: 8)
    }

    private func cardsHint(_ s: ServerSettings) -> String {
        if s.envLocked.cardsEnabled { return "Pinned by the server (FAMILY_AGENT_CARDS)." }
        if !s.isAdmin { return "Only an admin can change this." }
        return "Charts, checklists, diagrams the assistant writes and runs in a sealed sandbox. Off = text only."
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
        case .unreachable(let msg): "Unreachable: \(msg)"
        }
    }
}
