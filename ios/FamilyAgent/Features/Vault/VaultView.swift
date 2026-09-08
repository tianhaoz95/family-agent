import SwiftUI

struct VaultView: View {
    @Environment(AppModel.self) private var model
    @State private var password = ""
    @State private var recoveryCode = ""
    @State private var showEditor: VaultEditSeed?
    @State private var showAccessLog = false

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Vault", subtitle: "Passwords and 2FA codes, encrypted on the server.") {
                VStack(alignment: .leading, spacing: 12) {
                    if let code = model.vaultRecoveryCode {
                        AppCard(accent: Theme.marigold) {
                            Text("Save your recovery code").appTitleSmall()
                            Text(code).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                            Text("You'll need this if you ever reset your password. It won't be shown again.")
                                .appLabelSmall().foregroundStyle(Theme.textMuted)
                            Button("I've saved it") { model.dismissVaultRecoveryCode() }
                        }
                    }

                    if let msg = model.vaultStatusMsg {
                        Text(msg).appLabelSmall().foregroundStyle(Theme.textMuted)
                    }

                    if let status = model.vaultStatusValue {
                        if !status.exists {
                            AppCard {
                                Text("Set up your vault").appTitleSmall()
                                SecureField("Confirm your account password", text: $password)
                                    .textFieldStyle(.roundedBorder)
                                Button("Set up") { model.vaultSetup(password); password = "" }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(password.isEmpty)
                            }
                        } else if !status.unlocked {
                            AppCard {
                                Text("Unlock").appTitleSmall()
                                SecureField("Your account password", text: $password)
                                    .textFieldStyle(.roundedBorder)
                                Button("Unlock") { model.vaultUnlock(password); password = "" }
                                    .buttonStyle(.borderedProminent)
                                    .disabled(password.isEmpty)
                                DisclosureGroup("Use a recovery code instead") {
                                    SecureField("Recovery code", text: $recoveryCode)
                                        .textFieldStyle(.roundedBorder)
                                    SecureField("New password", text: $password)
                                        .textFieldStyle(.roundedBorder)
                                    Button("Recover") {
                                        model.vaultRecover(code: recoveryCode, password: password)
                                        recoveryCode = ""; password = ""
                                    }
                                }
                                .font(.inter(13, .medium))
                            }
                        } else {
                            HStack {
                                Button { showEditor = VaultEditSeed(entry: nil) } label: { Label("Add", systemImage: "plus") }
                                    .buttonStyle(.borderedProminent)
                                Button("Lock") { model.vaultLock() }
                                if model.isAdmin {
                                    Button("Share with family") { model.vaultFamilySync() }
                                }
                                Spacer()
                                Button { showAccessLog = true; model.loadVaultAccessLog() } label: {
                                    Image(systemName: "list.bullet.rectangle")
                                }
                            }

                            if model.vaultEntries.isEmpty {
                                EmptyState(text: "No entries yet.", systemImage: "lock")
                            } else {
                                ForEach(model.vaultEntries) { entry in
                                    AppCard(onTap: { model.openVaultEntry(entry.id) }) {
                                        HStack {
                                            Text(entry.title).appTitleSmall()
                                            Spacer()
                                            if entry.hasTotp { Image(systemName: "clock").foregroundStyle(Theme.textMuted) }
                                            if entry.scope == "shared" { Chip(text: "Shared", color: Theme.skyWash) }
                                        }
                                        if let u = entry.username { Text(u).appBodySmall().foregroundStyle(Theme.textMuted) }
                                    }
                                }
                            }
                        }
                    } else {
                        ProgressView()
                    }
                }
            }
        }
        .task { await model.refreshVault() }
        .sheet(item: Binding(get: { model.vaultDetail.map(VaultDetailSeed.init) },
                             set: { if $0 == nil { model.closeVaultEntry() } })) { seed in
            VaultDetailSheet(detail: seed.detail,
                             onEdit: { showEditor = VaultEditSeed(entry: seed.detail) },
                             onDelete: { model.deleteVaultEntry(seed.detail.id) },
                             getTotp: { await model.vaultCurrentTotp(seed.detail.id) })
        }
        .sheet(item: $showEditor) { seed in
            VaultEditorSheet(seed: seed)
        }
        .sheet(isPresented: $showAccessLog) {
            NavigationStack {
                List(model.vaultAccessLog) { e in
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(e.actor) \(e.action) — \(e.entryTitle)").appBodySmall()
                        Text(friendlyTimestamp(e.at)).appLabelSmall().foregroundStyle(Theme.textMuted)
                    }
                }
                .navigationTitle("Access log").navigationBarTitleDisplayMode(.inline)
            }
        }
    }
}

struct VaultEditSeed: Identifiable {
    let entry: VaultEntryDetail?
    var id: String { entry?.id ?? "new" }
}
private struct VaultDetailSeed: Identifiable {
    let detail: VaultEntryDetail
    var id: String { detail.id }
    init(_ d: VaultEntryDetail) { detail = d }
}

struct VaultDetailSheet: View {
    @Environment(\.dismiss) private var dismiss
    let detail: VaultEntryDetail
    let onEdit: () -> Void
    let onDelete: () -> Void
    let getTotp: () async -> VaultTotpResponse?

    @State private var revealPassword = false
    @State private var totp: VaultTotpResponse?

    var body: some View {
        NavigationStack {
            Form {
                if let u = detail.username {
                    LabeledContent("Username", value: u)
                }
                if let p = detail.secret.password {
                    HStack {
                        Text(revealPassword ? p : "••••••••")
                            .font(.system(.body, design: .monospaced))
                        Spacer()
                        Button { revealPassword.toggle() } label: {
                            Image(systemName: revealPassword ? "eye.slash" : "eye")
                        }
                        Button { UIPasteboard.general.string = p } label: { Image(systemName: "doc.on.doc") }
                    }
                }
                if detail.hasTotp {
                    HStack {
                        Text(totp?.code ?? "······").font(.system(.title3, design: .monospaced))
                        Spacer()
                        if let t = totp { Text("\(t.expiresInSeconds)s").appLabelSmall().foregroundStyle(Theme.textMuted) }
                    }
                }
                if let notes = detail.secret.notes, !notes.isEmpty {
                    Section("Notes") { Text(notes).appBodySmall() }
                }
            }
            .navigationTitle(detail.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Edit", action: onEdit)
                        Button("Delete", role: .destructive, action: onDelete)
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
            .task {
                guard detail.hasTotp else { return }
                while !Task.isCancelled {
                    totp = await getTotp()
                    try? await Task.sleep(for: .seconds(1))
                }
            }
        }
    }
}

struct VaultEditorSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let seed: VaultEditSeed

    @State private var title = ""
    @State private var username = ""
    @State private var url = ""
    @State private var password = ""
    @State private var totpInput = ""
    @State private var notes = ""
    @State private var shared = false

    private var isNew: Bool { seed.entry == nil }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                TextField("Username", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("URL", text: $url).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Password", text: $password)
                TextField("TOTP secret or otpauth:// URI", text: $totpInput)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Notes", text: $notes, axis: .vertical).lineLimit(2...5)
                if isNew { Toggle("Shared with family", isOn: $shared) }
            }
            .navigationTitle(isNew ? "New entry" : seed.entry!.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if isNew {
                            model.saveVaultEntry(id: nil, create: CreateVaultEntryRequest(
                                scope: shared ? "shared" : "private", title: title,
                                username: username.isEmpty ? nil : username,
                                url: url.isEmpty ? nil : url,
                                password: password.isEmpty ? nil : password,
                                totpInput: totpInput.isEmpty ? nil : totpInput,
                                notes: notes.isEmpty ? nil : notes), update: nil)
                        } else {
                            model.saveVaultEntry(id: seed.entry!.id, create: nil, update: UpdateVaultEntryRequest(
                                title: title, username: username, url: url,
                                password: password.isEmpty ? nil : password,
                                totpInput: totpInput.isEmpty ? nil : totpInput,
                                notes: notes))
                        }
                        dismiss()
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                guard let e = seed.entry else { return }
                title = e.title
                username = e.username ?? ""
                url = e.url ?? ""
                password = e.secret.password ?? ""
                notes = e.secret.notes ?? ""
            }
        }
    }
}
