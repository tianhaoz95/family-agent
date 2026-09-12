import SwiftUI

/// Admin-only account management — mirrors desktop's #view-family (add a
/// member, reset a password, remove an account). Gated on `model.isAdmin`
/// in MainShell's drawer, same shape as the other admin-only destinations.
struct FamilyView: View {
    @Environment(AppModel.self) private var model
    @State private var showAdd = false
    @State private var confirmDelete: User?

    var body: some View {
        ScreenScaffold(
            title: "Family",
            subtitle: "Accounts on this home server. Each one keeps its own tasks, documents, and history."
        ) {
            VStack(alignment: .leading, spacing: 12) {
                Button("Add a family member") { showAdd = true }
                    .buttonStyle(.primary)

                if let s = model.familyAccountsStatus {
                    Text(s).appLabelSmall().foregroundStyle(Theme.textMuted)
                }

                if model.familyAccounts.isEmpty {
                    EmptyState(text: "Loading accounts…", systemImage: "person.2")
                } else {
                    ForEach(model.familyAccounts) { user in
                        FamilyMemberCard(
                            user: user,
                            isSelf: user.id == model.currentUser?.id,
                            onResetPassword: { pw in
                                model.resetFamilyMemberPassword(user.id, displayName: user.displayName, password: pw)
                            },
                            onRemove: { confirmDelete = user }
                        )
                    }
                }
            }
        }
        .task { await model.refreshFamilyAccounts() }
        .sheet(isPresented: $showAdd) {
            AddFamilyMemberSheet { username, displayName, password, role in
                model.addFamilyMember(username: username, displayName: displayName, password: password, role: role)
            }
        }
        .alert(
            "Remove \(confirmDelete?.displayName ?? "")?",
            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })
        ) {
            Button("Remove", role: .destructive) {
                if let u = confirmDelete { model.removeFamilyMember(u.id, displayName: u.displayName) }
                confirmDelete = nil
            }
            Button("Cancel", role: .cancel) { confirmDelete = nil }
        } message: {
            Text("Their events, documents, and history are deleted. This can\u{2019}t be undone.")
        }
    }
}

private func initials(_ name: String) -> String {
    let parts = name.split(separator: " ", omittingEmptySubsequences: true)
    if parts.isEmpty { return "?" }
    if parts.count == 1 { return String(parts[0].prefix(2)).uppercased() }
    return "\(parts[0].prefix(1))\(parts[parts.count - 1].prefix(1))".uppercased()
}

private struct FamilyMemberCard: View {
    let user: User
    let isSelf: Bool
    let onResetPassword: (String) -> Void
    let onRemove: () -> Void

    @State private var showResetPrompt = false
    @State private var newPassword = ""

    var body: some View {
        AppCard {
            HStack(spacing: 12) {
                Circle()
                    .fill(Theme.accentSoft)
                    .frame(width: 40, height: 40)
                    .overlay(
                        Text(initials(user.displayName)).font(.inter(14, .semibold)).foregroundStyle(Theme.accentInk)
                    )
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(user.displayName).appTitleSmall()
                        if isSelf { Chip(text: "You", color: Theme.textMuted) }
                        Chip(text: user.role == "admin" ? "Admin" : "Member",
                             color: user.role == "admin" ? Theme.accent : Theme.textMuted)
                    }
                    Text("@\(user.username)").appLabelSmall().foregroundStyle(Theme.textMuted)
                }
                Spacer()
                if !isSelf {
                    Menu {
                        Button("Reset password") { showResetPrompt = true }
                        Button("Remove", role: .destructive) { onRemove() }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 18))
                            .foregroundStyle(Theme.textMuted)
                    }
                }
            }
        }
        .alert("New password for \(user.displayName)", isPresented: $showResetPrompt) {
            SecureField("6+ characters", text: $newPassword)
            Button("Reset") {
                if newPassword.count >= 6 { onResetPassword(newPassword) }
                newPassword = ""
            }
            Button("Cancel", role: .cancel) { newPassword = "" }
        } message: {
            Text("They\u{2019}ll need this the next time they sign in.")
        }
    }
}

private struct AddFamilyMemberSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onAdd: (_ username: String, _ displayName: String, _ password: String, _ role: String) -> Void

    @State private var displayName = ""
    @State private var username = ""
    @State private var password = ""
    @State private var role = "member"
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $displayName)
                TextField("Username", text: $username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField("Temporary password (6+ chars)", text: $password)
                Picker("Role", selection: $role) {
                    Text("Member").tag("member")
                    Text("Admin").tag("admin")
                }
                if let error {
                    Text(error).font(.inter(13)).foregroundStyle(Theme.danger)
                }
            }
            .navigationTitle("Add family member")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        let name = displayName.trimmingCharacters(in: .whitespaces)
                        let uname = username.trimmingCharacters(in: .whitespaces)
                        guard !name.isEmpty, !uname.isEmpty, password.count >= 6 else {
                            error = "Name, username, and a 6+ character password are all required."
                            return
                        }
                        onAdd(uname, name, password, role)
                        dismiss()
                    }
                }
            }
        }
    }
}
