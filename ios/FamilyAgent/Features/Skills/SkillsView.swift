import SwiftUI

struct SkillsView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: Skill?
    @State private var creatingNew = false
    @State private var confirmDelete: Skill?

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Skills", subtitle: "Named playbooks you teach the assistant \u{2014} step-by-step instructions it follows for a recurring family task.") {
                VStack(alignment: .leading, spacing: 12) {
                    if model.isAdmin {
                        Button("New skill") {
                            editing = Skill(name: "", markdownBody: "")
                            creatingNew = true
                        }
                        .buttonStyle(.primary)
                    }
                    if let s = model.skillStatus {
                        Text(s).appLabelSmall().foregroundStyle(Theme.textMuted)
                    }
                    if model.skills.isEmpty {
                        EmptyState(text: model.isAdmin ? "No skills yet. Add one to teach the assistant a repeatable task." : "No skills yet.",
                                   systemImage: "graduationcap")
                    } else {
                        ForEach(model.skills) { skill in
                            AppCard {
                                HStack(spacing: 10) {
                                    if model.isAdmin {
                                        Toggle("", isOn: Binding(
                                            get: { skill.enabled },
                                            set: { model.setSkillEnabled(skill.name, $0) }
                                        )).labelsHidden()
                                    }
                                    Text(skill.name).appTitle().lineLimit(1)
                                    Spacer()
                                    if !model.isAdmin, !skill.enabled { Chip(text: "Off", color: Theme.textMuted) }
                                }
                                if !skill.description.isEmpty {
                                    Spacer().frame(height: 6)
                                    Text(skill.description).appBody()
                                }
                                if let w = skill.whenToUse, !w.isEmpty {
                                    Spacer().frame(height: 4)
                                    Text("Use when: \(w)").appBodySmall().foregroundStyle(Theme.textMuted)
                                }
                                if !skill.scripts.isEmpty {
                                    Spacer().frame(height: 4)
                                    Text("Scripts: \(skill.scripts.joined(separator: ", "))"
                                         + (model.skillScriptsRunnable ? "" : " (script runner unavailable on this server)"))
                                        .appLabelSmall().foregroundStyle(Theme.textMuted)
                                }
                                if model.isAdmin {
                                    Spacer().frame(height: 8)
                                    HStack {
                                        Button("Edit") {
                                            Task {
                                                let body = await model.loadSkillBody(skill.name) ?? ""
                                                editing = Skill(name: skill.name, description: skill.description,
                                                                whenToUse: skill.whenToUse, enabled: skill.enabled,
                                                                markdownBody: body)
                                                creatingNew = false
                                            }
                                        }
                                        .font(.inter(13))
                                        Spacer()
                                        Button("Delete", role: .destructive) { confirmDelete = skill }
                                            .font(.inter(13))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .task { await model.refreshSkills() }
        .sheet(item: $editing) { skill in
            SkillEditor(skill: skill, isNew: creatingNew)
        }
        .alert("Delete skill?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button("Delete", role: .destructive) {
                if let s = confirmDelete { model.deleteSkill(s.name) }
                confirmDelete = nil
            }
            Button("Cancel", role: .cancel) { confirmDelete = nil }
        } message: {
            Text("\u{201C}\(confirmDelete?.name ?? "")\u{201D} will be removed.")
        }
    }
}

/// A `Skill` carrying the markdown body for editing.
private extension Skill {
    init(name: String, description: String = "", whenToUse: String? = nil, enabled: Bool = true, markdownBody: String) {
        self.init(name: name, description: description, whenToUse: whenToUse, enabled: enabled,
                  scripts: [], updatedAt: "", body: markdownBody)
    }
}

private struct SkillEditor: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let skill: Skill
    let isNew: Bool

    @State private var name = ""
    @State private var description = ""
    @State private var markdownText = ""
    @State private var drafting = false

    var body: some View {
        NavigationStack {
            Form {
                if isNew {
                    TextField("name-in-kebab-case", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: name) { _, v in
                            name = v.lowercased().replacingOccurrences(of: " ", with: "-")
                                .filter { $0.isLetter || $0.isNumber || $0 == "-" }
                        }
                }
                TextField("Short description", text: $description, axis: .vertical)
                if isNew {
                    Button {
                        drafting = true
                        Task {
                            if let md = await model.draftSkill(name, description) { markdownText = md }
                            drafting = false
                        }
                    } label: {
                        if drafting { ProgressView() } else { Label("Draft with AI", systemImage: "sparkles") }
                    }
                    .disabled(name.isEmpty || description.isEmpty || drafting)
                }
                Section("SKILL.md") {
                    TextEditor(text: $markdownText)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(minHeight: 240)
                }
            }
            .navigationTitle(isNew ? "New skill" : skill.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        model.saveSkill(SaveSkillRequest(
                            name: isNew ? name : skill.name,
                            description: description.isEmpty ? nil : description,
                            markdown: markdownText
                        ))
                        dismiss()
                    }
                    .disabled((isNew && name.isEmpty) || markdownText.isEmpty)
                }
            }
            .onAppear {
                name = skill.name
                description = skill.description
                markdownText = skill.body ?? ""
            }
        }
    }
}
