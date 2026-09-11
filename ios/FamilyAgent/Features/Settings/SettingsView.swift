import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var serverURLDraft = ""
    @State private var showAdvanced = false
    @State private var showUpdateConfirm = false

    var body: some View {
        ScreenScaffold(title: "Settings",
                       subtitle: "Your account and this device\u{2019}s connection.") {
            VStack(alignment: .leading, spacing: 0) {
                AppCard {
                    HStack(spacing: 10) {
                        StatusDot(color: connectionColor)
                        Text(connectionLabel).appBody()
                        Spacer(minLength: 0)
                    }
                }

                if model.ttsEnabled || model.voiceEnabled {
                    section("Voice")
                    if model.ttsEnabled {
                        Toggle(isOn: Binding(get: { model.autoRead }, set: { model.autoRead = $0 })) {
                            Text("Read replies aloud automatically").appBody()
                        }
                        .padding(.vertical, 4)
                    }
                    if model.voiceEnabled {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Microphone button side").appBody()
                            Picker("Microphone button side",
                                   selection: Binding(get: { model.micOnLeft ? "left" : "right" },
                                                      set: { model.micOnLeft = $0 == "left" })) {
                                Text("Left of the text field").tag("left")
                                Text("Right (next to Send)").tag("right")
                            }
                            .pickerStyle(.segmented)
                            Text("Put it wherever your thumb lands — handy if you're left-handed.")
                                .appLabelSmall().foregroundStyle(Theme.textMuted)
                        }
                        .padding(.vertical, 4)
                    }
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

                    Toggle(isOn: Binding(get: { s.vaultEnabled }, set: { model.setVaultEnabled($0) })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Password vault").appBody()
                            Text(vaultHint(s)).appLabelSmall().foregroundStyle(Theme.textMuted)
                        }
                    }
                    .disabled(!s.isAdmin || s.envLocked.vaultEnabled)
                    .padding(.vertical, 4)

                    section("Internet access")
                    InternetAccessSection(settings: s)

                    if s.isAdmin {
                        section("Host machine")
                        AppCard {
                            Text("Update & restart the host").appTitleSmall()
                            Spacer().frame(height: 4)
                            Text("Checks the laptop running Family Agent for a new version, installs it, and restarts \u{2014} everyone reconnects in a few seconds. Only works while that machine is on.")
                                .appBodySmall().foregroundStyle(Theme.textMuted)
                            Spacer().frame(height: 10)
                            Button("Update & restart") { showUpdateConfirm = true }
                                .buttonStyle(.soft)
                                .disabled(model.desktopUpdatePolling)
                            if let status = model.desktopUpdateStatus {
                                Spacer().frame(height: 8)
                                Text(desktopUpdateStatusText(status))
                                    .appLabelSmall()
                                    .foregroundStyle(status.state == "error" ? Theme.danger : Theme.textMuted)
                            }
                        }
                    }
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
                    .buttonStyle(.soft)
                if showAdvanced {
                    section("Server address")
                    TextField("http://192.168.1.2:4173", text: $serverURLDraft)
                        .textFieldStyle(.app)
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
        .task {
            await model.refreshServerSettings()
            serverURLDraft = model.serverURL
        }
        .alert("Update & restart the host?", isPresented: $showUpdateConfirm) {
            Button("Update & restart", role: .destructive) { model.triggerDesktopUpdate() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This restarts the Family Agent server on the host laptop. Everyone using it \u{2014} on this phone or any other \u{2014} will reconnect in a few seconds.")
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

    private func desktopUpdateStatusText(_ s: DesktopUpdateStatus) -> String {
        switch s.state {
        case "requested": return "Waiting for the host to pick this up\u{2026}"
        case "checking": return "Checking for an update\u{2026}"
        case "no-update": return "Already up to date."
        case "downloading": return s.percent.map { "Downloading\u{2026} \(Int($0))%" } ?? "Downloading\u{2026}"
        case "installing": return "Installing\u{2026}"
        case "restarting": return "Restarting \u{2014} should be back in a few seconds."
        case "error": return s.message.map { "Failed: \($0)" } ?? "Update failed."
        default: return ""
        }
    }

    private func cardsHint(_ s: ServerSettings) -> String {
        if s.envLocked.cardsEnabled { return "Pinned by the server (FAMILY_AGENT_CARDS)." }
        if !s.isAdmin { return "Only an admin can change this." }
        return "Charts, checklists, diagrams the assistant writes and runs in a sealed sandbox. Off = text only."
    }

    private func vaultHint(_ s: ServerSettings) -> String {
        if s.envLocked.vaultEnabled { return "Pinned by the server (FAMILY_AGENT_VAULT)." }
        if !s.isAdmin { return "Only an admin can change this." }
        return "An encrypted store for the family's passwords and 2FA codes. Off by default."
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

/// Provider picker + conditional URL / API-key field for the research agent's
/// internet access. Mirrors the desktop Settings "Internet access" section.
private struct InternetAccessSection: View {
    @Environment(AppModel.self) private var model
    let settings: ServerSettings

    private static let providers: [(String, String)] = [
        ("none", "Off"),
        ("ddg", "On — DuckDuckGo (no key)"),
        ("searxng", "On — SearXNG (self-hosted)"),
        ("tavily", "On — Tavily (API key)"),
        ("brave", "On — Brave Search (API key)"),
    ]

    @State private var provider = "none"
    @State private var url = ""
    @State private var apiKey = ""
    @State private var status: String?

    private var editable: Bool { settings.isAdmin && !settings.envLocked.webSearchProvider }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Lets the assistant search the web and read pages (the /web command and the "
                 + "research helper). Every request is SSRF-guarded, logged in Activity, and never "
                 + "followed through a redirect. Off = only what\u{2019}s on this machine.")
                .appLabelSmall().foregroundStyle(Theme.textMuted)

            Picker("Provider", selection: $provider) {
                ForEach(Self.providers, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.menu)
            .disabled(!editable)

            if provider == "searxng" {
                TextField("SearXNG URL — http://localhost:8888", text: $url)
                    .textFieldStyle(.app)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .disabled(!editable)
            }
            if provider == "tavily" || provider == "brave" {
                SecureField(settings.webSearchApiKeySet ? "A key is saved — type to replace" : "Paste the provider API key",
                            text: $apiKey)
                    .textFieldStyle(.app)
                    .disabled(!editable)
            }

            Button("Save") {
                status = "Saving…"
                model.setWebAccess(
                    provider: provider,
                    url: provider == "searxng" ? url.trimmingCharacters(in: .whitespaces) : nil,
                    apiKey: (provider == "tavily" || provider == "brave") && !apiKey.isEmpty
                        ? apiKey.trimmingCharacters(in: .whitespaces) : nil)
                status = provider == "none" ? "Off — no internet access." : "On — searching with \(provider)."
            }
            .buttonStyle(.primary)
            .disabled(!editable)

            Text(status ?? hint)
                .appLabelSmall().foregroundStyle(Theme.textMuted)
        }
        .onAppear {
            provider = settings.webSearchProvider
            url = settings.webSearchUrl
        }
    }

    private var hint: String {
        if settings.envLocked.webSearchProvider { return "Pinned by a FAMILY_AGENT_WEB_SEARCH_* env var on the server." }
        if !settings.isAdmin { return "Only an admin can change this." }
        return settings.webEnabled
            ? "On — searching with \(settings.webSearchProvider)."
            : "Off — the assistant has no internet access."
    }
}
