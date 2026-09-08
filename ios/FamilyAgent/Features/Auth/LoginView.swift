import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var model
    let serverURL: String
    let serverName: String
    let error: String?

    @State private var username = ""
    @State private var password = ""
    @State private var displayName = ""

    private var isSetup: Bool { error == "SETUP" }
    private var canSubmit: Bool {
        !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
            && (!isSetup || !displayName.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    var body: some View {
        ScrollView {
            ScreenScaffold(
                title: serverName.isEmpty ? (isSetup ? "Set up your home" : "Sign in") : serverName,
                subtitle: isSetup
                    ? "Create the first account. You'll be the admin."
                    : "Sign in to your account. Everyone's things stay separate."
            ) {
                VStack(alignment: .leading, spacing: 12) {
                    TextField("Username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textFieldStyle(.app)

                    if isSetup {
                        TextField("Your name", text: $displayName)
                            .textFieldStyle(.app)
                    }

                    SecureField("Password", text: $password)
                        .textContentType(isSetup ? .newPassword : .password)
                        .textFieldStyle(.app)

                    if let error, error != "SETUP" {
                        Text(error).font(.inter(14)).foregroundStyle(Theme.danger)
                    }

                    Button {
                        if isSetup {
                            model.bootstrap(serverName: serverName, username: username,
                                            displayName: displayName, password: password)
                        } else {
                            model.login(username: username, password: password)
                        }
                    } label: {
                        Text(isSetup ? "Create account" : "Sign in").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.primary)
                    .disabled(!canSubmit)

                    Button("Choose a different server") { model.backToServerPick() }
                        .font(.inter(14, .medium))
                }
            }
        }
    }
}
