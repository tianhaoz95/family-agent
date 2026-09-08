import SwiftUI

struct RoutinesView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: RoutineEditSeed?

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Routines", subtitle: "Saved instructions the assistant runs on a schedule.") {
                VStack(alignment: .leading, spacing: 12) {
                    Button {
                        editing = RoutineEditSeed(routine: nil)
                    } label: { Label("New routine", systemImage: "plus") }
                    .buttonStyle(.borderedProminent)

                    if let s = model.routineStatus {
                        Text(s).appLabelSmall().foregroundStyle(Theme.textMuted)
                    }

                    if model.routines.isEmpty {
                        EmptyState(text: "No routines yet.", systemImage: "clock.arrow.circlepath")
                    } else {
                        ForEach(model.routines) { r in
                            RoutineCard(routine: r,
                                        runs: model.routineRuns[r.id] ?? [],
                                        onToggle: { model.setRoutineEnabled(r.id, $0) },
                                        onRun: { model.runRoutineNow(r.id) },
                                        onEdit: { editing = RoutineEditSeed(routine: r) },
                                        onDelete: { model.deleteRoutine(r.id) },
                                        onLoadRuns: { model.loadRoutineRuns(r.id) })
                        }
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
    }
}

struct RoutineEditSeed: Identifiable {
    let routine: Routine?
    var id: String { routine?.id ?? "new" }
}

struct RoutineCard: View {
    let routine: Routine
    let runs: [RoutineRun]
    let onToggle: (Bool) -> Void
    let onRun: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onLoadRuns: () -> Void
    @State private var expanded = false

    var body: some View {
        AppCard {
            HStack {
                Text(routine.name).appTitleSmall()
                Spacer()
                Toggle("", isOn: Binding(get: { routine.enabled }, set: { onToggle($0) })).labelsHidden()
            }
            Text(routine.triggerText).appBodySmall().foregroundStyle(Theme.textBody)
            if let next = routine.nextRunAt {
                Text("Next: \(friendlyTimestamp(next))").appLabelSmall().foregroundStyle(Theme.textMuted)
            }
            HStack {
                Button("Run now", action: onRun).font(.inter(13))
                Button("Edit", action: onEdit).font(.inter(13))
                Button(expanded ? "Hide runs" : "Runs") {
                    expanded.toggle()
                    if expanded { onLoadRuns() }
                }.font(.inter(13))
                Spacer()
                Button("Delete", role: .destructive, action: onDelete).font(.inter(13))
            }
            .padding(.top, 4)
            if expanded {
                ForEach(runs) { run in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Chip(text: run.status, color: run.status == "ok" ? Theme.ok : Theme.danger)
                            Text(friendlyTimestamp(run.startedAt)).appLabelSmall().foregroundStyle(Theme.textMuted)
                        }
                        if let out = run.output, !out.isEmpty {
                            Text(out).appLabelSmall().lineLimit(4)
                        }
                        if let err = run.error {
                            Text(err).appLabelSmall().foregroundStyle(Theme.danger)
                        }
                    }
                    .padding(.top, 4)
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
    @State private var everyMinutes = 60
    @State private var onceAt = Date()
    @State private var cronExpr = "0 9 * * *"
    @State private var deliverChannel: String = ""

    private let agents = ["planner", "task", "document", "notes", "tools", "research", "connect"]
    private let kinds: [(String, String)] = [("daily", "Every day"), ("weekly", "Every week"), ("monthly", "Every month"), ("every", "Every N min"), ("once", "Once"), ("cron", "cron")]

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                Section("Do") {
                    Picker("Agent", selection: $agent) {
                        ForEach(agents, id: \.self) { Text($0.capitalized).tag($0) }
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
                    case "every":
                        Stepper("Every \(everyMinutes) min", value: $everyMinutes, in: 5...1440, step: 5)
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
        case "every":   return RoutineTriggerInput(everyMinutes: everyMinutes)
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
            kind = "every"; everyMinutes = r.trigger.minutes ?? 60
        case "once":
            kind = "once"
            if let at = r.trigger.at, let d = ISO8601DateFormatter().date(from: at) { onceAt = d }
        default:
            kind = "cron"; cronExpr = r.trigger.expr ?? "0 9 * * *"
        }
    }
}
