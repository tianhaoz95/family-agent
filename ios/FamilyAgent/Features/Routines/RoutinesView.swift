import SwiftUI

let ROUTINE_AGENT_OPTIONS: [(String, String)] = [
    ("planner", "The assistant (anything)"),
    ("task", "Events only"),
    ("document", "Documents only"),
    ("notes", "The board only"),
    ("tools", "The family tools only"),
]

struct RoutinesView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: RoutineEditSeed?
    @State private var confirmDelete: Routine?

    var body: some View {
        ScreenScaffold(title: "Routines", subtitle: "A saved instruction the assistant runs on a schedule \u{2014} a morning briefing, a bill reminder, a weekly review.") {
            VStack(alignment: .leading, spacing: 12) {
                Button("New routine") { editing = RoutineEditSeed(routine: nil) }
                    .buttonStyle(.primary)

                if let s = model.routineStatus {
                    Text(s).appLabelSmall().foregroundStyle(Theme.textMuted)
                }

                if model.routines.isEmpty {
                    EmptyState(text: "No routines yet. Add one, or ask in Chat \u{2014} \"every morning summarise my day\".", systemImage: "clock.arrow.circlepath")
                } else {
                    ForEach(model.routines) { r in
                        RoutineCard(routine: r,
                                    runs: model.routineRuns[r.id],
                                    onToggle: { model.setRoutineEnabled(r.id, !r.enabled) },
                                    onRun: { model.runRoutineNow(r.id) },
                                    onEdit: { editing = RoutineEditSeed(routine: r) },
                                    onDelete: { confirmDelete = r },
                                    onLoadRuns: { model.loadRoutineRuns(r.id) })
                    }
                }
            }
        }
        .task { await model.refreshRoutines() }
        .sheet(item: $editing) { seed in
            RoutineSheet(seed: seed, channels: model.channels) { id, input in
                model.saveRoutine(id: id, input)
            }
        }
        .alert("Delete routine?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button("Delete", role: .destructive) {
                if let r = confirmDelete { model.deleteRoutine(r.id) }
                confirmDelete = nil
            }
            Button("Cancel", role: .cancel) { confirmDelete = nil }
        } message: {
            Text("\u{201C}\(confirmDelete?.name ?? "")\u{201D} and its run history will be removed.")
        }
    }
}

struct RoutineEditSeed: Identifiable {
    let routine: Routine?
    var id: String { routine?.id ?? "new" }
}

struct RoutineCard: View {
    let routine: Routine
    let runs: [RoutineRun]?
    let onToggle: () -> Void
    let onRun: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onLoadRuns: () -> Void
    @State private var showRuns = false

    private var agentLabel: String {
        ROUTINE_AGENT_OPTIONS.first { $0.0 == routine.action.agent }?.1 ?? routine.action.agent
    }
    private var nextLine: String {
        if !routine.enabled { return "Paused" }
        if let n = routine.nextRunAt { return "Next: \(shortWhen(n))" }
        return "Next: —"
    }
    private var lastLine: String? {
        guard let last = routine.lastRunAt else { return nil }
        let verb = routine.lastStatus == "ok" ? "ran" : (routine.lastStatus ?? "ran")
        return "Last \(verb) \(shortWhen(last))"
    }

    var body: some View {
        AppCard {
            HStack(spacing: 10) {
                Toggle("", isOn: Binding(get: { routine.enabled }, set: { _ in onToggle() })).labelsHidden()
                Text(routine.name).appTitle().lineLimit(1)
                Spacer()
            }
            Spacer().frame(height: 6)
            Text("\(routine.triggerText) · \(agentLabel)")
                .appBodySmall().foregroundStyle(Theme.textMuted)
            Spacer().frame(height: 4)
            Text(routine.action.instruction).appBody()

            Spacer().frame(height: 8)
            HStack(spacing: 14) {
                Text(nextLine).appLabelSmall().foregroundStyle(Theme.textMuted)
                if let lastLine {
                    Text(lastLine).appLabelSmall()
                        .foregroundStyle(routine.lastStatus == "error" ? Theme.danger : Theme.textMuted)
                }
            }

            Spacer().frame(height: 10)
            HStack {
                Button("Run now", action: onRun).buttonStyle(.ghost)
                Button("Edit", action: onEdit).font(.inter(13))
                Button("Delete", role: .destructive, action: onDelete).font(.inter(13))
            }
            Button(showRuns ? "Hide runs" : "Recent runs") {
                showRuns.toggle()
                if showRuns { onLoadRuns() }
            }
            .font(.inter(13, .medium))

            if showRuns {
                if runs == nil {
                    Text("Loading…").appBodySmall().foregroundStyle(Theme.textMuted)
                } else if runs?.isEmpty == true {
                    Text("No runs yet.").appBodySmall().foregroundStyle(Theme.textMuted)
                } else {
                    ForEach(runs ?? []) { run in
                        let mark = run.status == "ok" ? "✓" : (run.status == "error" ? "⚠" : (run.status == "running" ? "…" : "–"))
                        let body = run.status == "error" ? (run.error ?? "failed")
                            : (run.status == "running" ? "running…" : (run.output?.prefix(400).description.isEmpty == false ? String(run.output!.prefix(400)) : "(no output)"))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(mark) \(shortWhen(run.finishedAt ?? run.startedAt))")
                                .appLabelSmall().foregroundStyle(Theme.textMuted)
                            Text(body).appBodySmall()
                        }
                        .padding(.top, 6)
                    }
                }
            }
        }
    }
}

struct RoutineSheet: View {
    @Environment(\.dismiss) private var dismiss
    let seed: RoutineEditSeed
    let channels: [Channel]
    let onSave: (String?, RoutineInput) -> Void

    @State private var name = ""
    @State private var instruction = ""
    @State private var agent = "planner"
    @State private var kind = "daily"          // daily | weekly | monthly | every | once | cron
    @State private var timeOfDay = Date()
    @State private var weekday = 2
    @State private var monthDay = 1
    @State private var everyHours = 6
    @State private var onceAt = Date()
    @State private var cronExpr = "0 9 * * *"
    @State private var deliverChannel: String = ""

    private let kinds: [(String, String)] = [
        ("daily", "Every day"), ("weekly", "Every week"), ("monthly", "Every month"),
        ("everyHours", "Every few hours"), ("once", "Once"), ("cron", "Advanced (cron)"),
    ]

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                Section("Do") {
                    Picker("Run", selection: $agent) {
                        ForEach(ROUTINE_AGENT_OPTIONS, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    TextField("Instruction", text: $instruction, axis: .vertical).lineLimit(2...5)
                }
                Section("When") {
                    Picker("Schedule", selection: $kind) {
                        ForEach(kinds, id: \.0) { Text($0.1).tag($0.0) }
                    }
                    switch kind {
                    case "daily":
                        DatePicker("At", selection: $timeOfDay, displayedComponents: .hourAndMinute)
                    case "weekly":
                        Picker("On", selection: $weekday) {
                            ForEach(1..<8) { Text(weekdayName($0)).tag($0) }
                        }
                        DatePicker("At", selection: $timeOfDay, displayedComponents: .hourAndMinute)
                    case "monthly":
                        Stepper("Day \(monthDay)", value: $monthDay, in: 1...28)
                        DatePicker("At", selection: $timeOfDay, displayedComponents: .hourAndMinute)
                    case "everyHours":
                        Stepper("Every \(everyHours) hour\(everyHours == 1 ? "" : "s")", value: $everyHours, in: 1...24)
                    case "once":
                        DatePicker("At", selection: $onceAt)
                    default:
                        TextField("cron (5 fields)", text: $cronExpr).font(.system(.body, design: .monospaced))
                    }
                }
                Section("Also post to") {
                    Picker("Channel", selection: $deliverChannel) {
                        Text("Nowhere").tag("")
                        ForEach(channels) { Text($0.title).tag($0.id) }
                    }
                }
            }
            .navigationTitle(seed.routine == nil ? "New routine" : seed.routine!.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(seed.routine?.id, RoutineInput(
                            name: name,
                            trigger: buildTrigger(),
                            action: RoutineAction(agent: agent, instruction: instruction),
                            deliverChannelId: deliverChannel.isEmpty ? nil : deliverChannel
                        ))
                        dismiss()
                    }
                    .disabled(name.isEmpty || instruction.isEmpty)
                }
            }
            .onAppear(perform: decompose)
        }
    }

    private func weekdayName(_ i: Int) -> String {
        ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i]
    }

    private func buildTrigger() -> RoutineTriggerInput {
        let hhmm = DateFormatter.hhmm.string(from: timeOfDay)
        switch kind {
        case "daily":   return RoutineTriggerInput(dailyAt: hhmm)
        case "weekly":  return RoutineTriggerInput(weeklyOn: weekdayName(weekday).lowercased(), weeklyAt: hhmm)
        case "monthly": return RoutineTriggerInput(monthlyDay: monthDay, monthlyAt: hhmm)
        case "everyHours": return RoutineTriggerInput(everyMinutes: everyHours * 60)
        case "once":
            let f = ISO8601DateFormatter()
            return RoutineTriggerInput(onceAt: f.string(from: onceAt))
        default:        return RoutineTriggerInput(cron: cronExpr)
        }
    }

    private func decompose() {
        guard let r = seed.routine else { return }
        name = r.name
        instruction = r.action.instruction
        agent = r.action.agent
        deliverChannel = r.deliverChannelId ?? ""
        switch r.trigger.kind {
        case "every":
            kind = "everyHours"; everyHours = max(1, (r.trigger.minutes ?? 360) / 60)
        case "once":
            kind = "once"
            if let at = r.trigger.at, let d = ISO8601DateFormatter().date(from: at) { onceAt = d }
        default:
            kind = "cron"; cronExpr = r.trigger.expr ?? "0 9 * * *"
        }
    }
}
