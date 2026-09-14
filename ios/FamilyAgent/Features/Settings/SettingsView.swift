import SwiftUI
import WatchConnectivity

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var serverURLDraft = ""
    @State private var showAdvanced = false
    @State private var showUpdateConfirm = false
    @State private var showRestartConfirm = false
    @State private var notifyBlockedHint = false
    @State private var locationBlockedHint = false

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

                section("Notifications")
                Toggle(isOn: Binding(
                    get: { model.notifyOnReply },
                    set: { want in
                        guard want else {
                            notifyBlockedHint = false
                            model.notifyOnReply = false
                            return
                        }
                        ReplyNotifications.hasPermission { granted in
                            Task { @MainActor in
                                if granted {
                                    notifyBlockedHint = false
                                    model.notifyOnReply = true
                                } else {
                                    ReplyNotifications.requestPermission { granted2 in
                                        Task { @MainActor in
                                            notifyBlockedHint = !granted2
                                            model.notifyOnReply = granted2
                                        }
                                    }
                                }
                            }
                        }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Notify when a reply is ready").appBody()
                        Text(notifyBlockedHint
                            ? "Notifications are blocked — allow them for Family Agent in Settings."
                            : "A system notification when the assistant finishes replying in Chat, or an @agent reply in a family channel, while you're not looking at it.")
                            .appLabelSmall().foregroundStyle(notifyBlockedHint ? Theme.dangerInk : Theme.textMuted)
                    }
                }
                .padding(.vertical, 4)

                section("Location")
                Toggle(isOn: Binding(
                    get: { model.useLocation },
                    set: { want in
                        guard want else {
                            locationBlockedHint = false
                            model.useLocation = false
                            return
                        }
                        Task { @MainActor in
                            let loc = await LocationProvider.shared.currentLocation()
                            locationBlockedHint = loc == nil
                            model.useLocation = loc != nil
                        }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Let the assistant use my location").appBody()
                        Text(locationBlockedHint
                            ? "Couldn't get a location — allow it for Family Agent in Settings."
                            : "For \u{201C}near me\u{201D} questions only \u{2014} not a stored home address, and never shared in a family conversation.")
                            .appLabelSmall().foregroundStyle(locationBlockedHint ? Theme.dangerInk : Theme.textMuted)
                    }
                }
                .padding(.vertical, 4)

                section("Watch companion")
                WatchCompanionSection()

                if let s = model.serverSettings {
                    section("History & activity")
                    Text("How much of your own chat history and activity log this server keeps. This is personal to your account \u{2014} it doesn\u{2019}t affect anyone else\u{2019}s.")
                        .appLabelSmall().foregroundStyle(Theme.textMuted)
                    Spacer().frame(height: 10)
                    RetentionRow(
                        label: "Chat sessions", unitWord: "sessions",
                        mode: s.chatRetentionMode, value: s.chatRetentionValue,
                        onSave: { mode, value, onDone, onError in
                            model.setChatRetention(mode: mode, value: value, onDone: onDone, onError: onError)
                        }
                    )
                    Spacer().frame(height: 14)
                    RetentionRow(
                        label: "Activity log", unitWord: "entries",
                        mode: s.activityRetentionMode, value: s.activityRetentionValue,
                        onSave: { mode, value, onDone, onError in
                            model.setActivityRetention(mode: mode, value: value, onDone: onDone, onError: onError)
                        }
                    )

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
                            Spacer().frame(height: 10)
                            Text("If the app seems stuck \u{2014} a reply that never finishes, a frozen screen — restarting it (with no update needed) can unstick it.")
                                .appBodySmall().foregroundStyle(Theme.textMuted)
                            Spacer().frame(height: 10)
                            Button("Restart the host") { showRestartConfirm = true }
                                .buttonStyle(.soft)
                                .disabled(model.desktopUpdatePolling)
                            if let status = model.desktopUpdateStatus {
                                Spacer().frame(height: 8)
                                Text(desktopUpdateStatusText(status))
                                    .appLabelSmall()
                                    .foregroundStyle(status.state == "error" ? Theme.danger : Theme.textMuted)
                            }
                        }

                        Spacer().frame(height: 10)
                        Toggle(isOn: Binding(get: { s.autoUpdateEnabled }, set: { model.setAutoUpdateEnabled($0) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Install updates automatically").appBody()
                                Text(autoUpdateHint(s)).appLabelSmall().foregroundStyle(Theme.textMuted)
                            }
                        }
                        .disabled(!s.isAdmin || s.envLocked.autoUpdateEnabled)
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
        .alert("Restart the host?", isPresented: $showRestartConfirm) {
            Button("Restart", role: .destructive) { model.triggerDesktopRestart() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This restarts the Family Agent server on the host laptop \u{2014} no update, just a fresh start. Use this if it seems stuck. Everyone using it will reconnect in a few seconds.")
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

    private func autoUpdateHint(_ s: ServerSettings) -> String {
        if s.envLocked.autoUpdateEnabled { return "Pinned by the server (FAMILY_AGENT_AUTO_UPDATE)." }
        if !s.isAdmin { return "Only an admin can change this." }
        return "When on, the host laptop checks periodically and installs a new version on its own \u{2014} no confirmation prompt."
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

/// Settings → "Watch companion". Status is read straight from `WCSession`
/// (`isPaired`/`isWatchAppInstalled`/`isReachable`) rather than plumbed
/// through `AppModel` — this is purely "is an Apple Watch paired and nearby
/// right now", a fact only this screen cares about. `isPaired` is real
/// pairing (unlike Android's Bluetooth-connected-node check, which can't
/// tell "paired" from "just nearby") but still doesn't require the watch
/// app to be open, or even installed, for `isPaired` alone to be true — see
/// the toggle's own description for what the connection can actually do.
private struct WatchCompanionSection: View {
    @Environment(AppModel.self) private var model
    @State private var isPaired = false
    @State private var isInstalled = false
    @State private var isReachable = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                StatusDot(color: statusColor)
                Text(statusLabel).appBody()
                Spacer(minLength: 0)
            }
            Spacer().frame(height: 12)
            Toggle(isOn: Binding(get: { model.watchRelayEnabled }, set: { model.watchRelayEnabled = $0 })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Allow watch access").appBody()
                    Text("Lets a paired Apple Watch open your chat sessions and send messages, relayed through this phone \u{2014} the watch never talks to the server directly. Off = the watch app shows a turned-off message instead.")
                        .appLabelSmall().foregroundStyle(Theme.textMuted)
                }
            }
        }
        .task { refresh() }
    }

    private func refresh() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        isPaired = s.isPaired
        isInstalled = s.isWatchAppInstalled
        isReachable = s.isReachable
    }

    private var statusColor: Color {
        if isReachable { return Theme.ok }
        if isPaired && isInstalled { return Theme.warn }
        return Theme.textMuted
    }
    private var statusLabel: String {
        if isReachable { return "Connected \u{00B7} Apple Watch" }
        if isPaired && isInstalled { return "Paired \u{00B7} not reachable right now" }
        if isPaired { return "Paired \u{00B7} app not installed on the watch" }
        return "No Apple Watch paired"
    }
}

/// One "keep how much" row — used for both chat sessions and the activity
/// log (Settings → "History & activity"), self-service for any signed-in
/// user (not admin-gated, unlike most of the settings around it). Mirrors
/// the desktop Settings page's retention rows and agent-core's
/// `RetentionMode` ("off" | "count" | "days").
private struct RetentionRow: View {
    let label: String
    let unitWord: String
    let mode: String
    let value: Int?
    /// (mode, value, onDone, onError) — the row shows "Saving…" until one of
    /// the two fires, rather than a label nothing ever clears.
    let onSave: (String, Int?, @escaping () -> Void, @escaping (String) -> Void) -> Void

    private static let modes: [(String, String)] = [
        ("off", "Keep everything"),
        ("count", "Keep the last N"),
        ("days", "Keep the last N days"),
    ]

    @State private var draftMode = "off"
    @State private var draftValue = ""
    @State private var status: String?
    // Skips the .onChange handler below firing from .onAppear's own initial
    // assignment (loading the saved value into state is not a user edit) —
    // same guard InternetAccessSection uses.
    @State private var hasLoaded = false
    @State private var saveTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).appBody()

            Picker(label, selection: $draftMode) {
                ForEach(Self.modes, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.menu)
            .onChange(of: draftMode) { _, newValue in
                guard hasLoaded else { return }
                let n = Int(draftValue)
                if newValue == "off" {
                    performSave(mode: "off", value: nil)
                } else if let n, n > 0 {
                    // Switching count<->days with a number already typed
                    // saves right away; switching off "off" with nothing
                    // typed yet waits for the field below.
                    performSave(mode: newValue, value: n)
                }
            }

            if draftMode != "off" {
                TextField(draftMode == "count" ? "How many \(unitWord)" : "How many days", text: $draftValue)
                    .textFieldStyle(.app)
                    .keyboardType(.numberPad)
                    .onChange(of: draftValue) { _, newValue in
                        guard hasLoaded else { return }
                        draftValue = newValue.filter(\.isNumber)
                        scheduleSave()
                    }
            }

            Text(status ?? hint)
                .appLabelSmall().foregroundStyle(Theme.textMuted)
        }
        .onAppear {
            draftMode = mode
            draftValue = value.map(String.init) ?? ""
            hasLoaded = true
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(0.7))
            guard !Task.isCancelled else { return }
            guard let n = Int(draftValue), n > 0 else { return }
            performSave(mode: draftMode, value: n)
        }
    }

    /// `status` shows "Saving…" until `onSave`'s completion actually fires —
    /// previously nothing ever cleared it, so a successful save left the
    /// row stuck reading "Saving…" forever (see docs/DECISIONS.md → "Chat/
    /// activity retention limits" → "Follow-up: 'Saving…' never cleared").
    private func performSave(mode: String, value: Int?) {
        status = "Saving\u{2026}"
        onSave(mode, value, {
            status = nil
        }, { message in
            status = "Couldn't save: \(message)"
        })
    }

    private var hint: String {
        switch mode {
        case "count": return value.map { "Keeping the last \($0) \(unitWord)." } ?? "Pick a number above to turn this on."
        case "days": return value.map { "Keeping the last \($0) days." } ?? "Pick a number above to turn this on."
        default: return "Keeping everything \u{2014} no automatic cleanup."
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
    @State private var saveTask: Task<Void, Never>?
    // Guards the .onChange handlers below against firing from .onAppear's
    // own initial assignment (loading the saved provider/URL into state is
    // not a user edit) — without it, opening this screen would fire a
    // spurious, idempotent save and briefly flash "Saving…".
    @State private var hasLoaded = false

    private static let needsCompanionField: Set<String> = ["searxng", "tavily", "brave"]

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
            .onChange(of: provider) { _, newValue in
                guard hasLoaded else { return }
                // A provider that needs no extra info (off / keyless) is a
                // complete choice on its own — save immediately, no separate
                // Save button. One that needs a URL/key isn't complete yet;
                // that field's own edit triggers the save instead, below.
                if !Self.needsCompanionField.contains(newValue) { save() }
            }

            if provider == "searxng" {
                TextField("SearXNG URL — http://localhost:8888", text: $url)
                    .textFieldStyle(.app)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .disabled(!editable)
                    .onSubmit { save() }
                    .onChange(of: url) { _, _ in
                        guard hasLoaded else { return }
                        scheduleSave()
                    }
            }
            if provider == "tavily" || provider == "brave" {
                SecureField(settings.webSearchApiKeySet ? "A key is saved — type to replace" : "Paste the provider API key",
                            text: $apiKey)
                    .textFieldStyle(.app)
                    .disabled(!editable)
                    .onSubmit { save() }
                    .onChange(of: apiKey) { _, _ in
                        guard hasLoaded else { return }
                        scheduleSave()
                    }
            }

            Text(status ?? hint)
                .appLabelSmall().foregroundStyle(Theme.textMuted)
        }
        .onAppear {
            provider = settings.webSearchProvider
            url = settings.webSearchUrl
            hasLoaded = true
        }
    }

    /// Debounced so typing a URL/key doesn't fire a save on every keystroke.
    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .seconds(0.7))
            guard !Task.isCancelled else { return }
            save()
        }
    }

    private func save() {
        guard editable else { return }
        status = "Saving…"
        model.setWebAccess(
            provider: provider,
            url: provider == "searxng" ? url.trimmingCharacters(in: .whitespaces) : nil,
            apiKey: (provider == "tavily" || provider == "brave") && !apiKey.isEmpty
                ? apiKey.trimmingCharacters(in: .whitespaces) : nil)
        status = provider == "none" ? "Off — no internet access." : "On — searching with \(provider)."
    }

    private var hint: String {
        if settings.envLocked.webSearchProvider { return "Pinned by a FAMILY_AGENT_WEB_SEARCH_* env var on the server." }
        if !settings.isAdmin { return "Only an admin can change this." }
        return settings.webEnabled
            ? "On — searching with \(settings.webSearchProvider)."
            : "Off — the assistant has no internet access."
    }
}
