import SwiftUI

struct TasksView: View {
    @Environment(AppModel.self) private var model
    @State private var showAdd = false
    @State private var reschedule: TaskItem?
    @State private var quickAdd: QuickAddSeed?

    private var views: [(String, String)] {
        [("list", "List"), ("day", "Day"), ("3day", "3 days"), ("week", "Week"), ("month", "Month")]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenScaffold(title: "Events", subtitle: "Everything the family agent is tracking for you.") {
                VStack(spacing: 14) {
                    HStack(spacing: 10) {
                        BrandSegmented(options: views,
                                       selection: Binding(get: { model.taskView }, set: { model.taskView = $0 }))
                        Button {
                            quickAdd = QuickAddSeed(date: model.calAnchor, minutes: nil)
                        } label: {
                            Image(systemName: "plus").font(.system(size: 15, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 34, height: 34)
                                .background(Theme.accent, in: Circle())
                                .elevation(Theme.E.sm)
                        }
                        .buttonStyle(.plain)
                    }

                    if model.taskView != "list" {
                        HStack(spacing: 4) {
                            Button { shift(-1) } label: { Image(systemName: "chevron.left").font(.system(size: 14, weight: .semibold)) }
                            Spacer()
                            Text(rangeLabel).appTitleSmall()
                            Spacer()
                            Button { shift(1) } label: { Image(systemName: "chevron.right").font(.system(size: 14, weight: .semibold)) }
                            Button("Today") { model.calAnchor = CalendarMath.cal.startOfDay(for: .now) }
                        }
                        .foregroundStyle(Theme.accent)
                        .buttonStyle(.soft)
                        .padding(.horizontal, 2)
                    }

                    Group {
                        switch model.taskView {
                        case "month": TaskMonthView(tasks: model.tasks, anchor: model.calAnchor,
                                                    onTapDay: { seed(for: $0, minutes: nil) })
                        case "list":  TaskListView(tasks: model.tasks,
                                                   onAdd: { model.addTask(title: $0, dueDate: $1, dueTime: $2) },
                                                   onComplete: model.completeTask,
                                                   onReschedule: { reschedule = $0 })
                        default:      TaskScheduleView(view: model.taskView, tasks: model.tasks, anchor: model.calAnchor,
                                                       onTapSlot: { day, mins in seed(for: day, minutes: mins) },
                                                       onTapTask: { model.openTaskDetail($0.id) })
                        }
                    }
                }
            }
        }
        .task { await model.refreshTasks() }
        .sheet(item: $reschedule) { t in
            RescheduleSheet(task: t) { date, time in
                model.rescheduleTask(t.id, dueDate: date, dueTime: time)
            }
        }
        .sheet(item: $quickAdd) { seed in
            QuickAddSheet(seed: seed) { title, date, time in
                model.addTask(title: title, dueDate: date, dueTime: time)
            }
        }
    }

    private func seed(for day: Date, minutes: Int?) {
        quickAdd = QuickAddSeed(date: day, minutes: minutes)
    }

    private func shift(_ dir: Int) {
        let cal = CalendarMath.cal
        let unit: Calendar.Component
        let amount: Int
        switch model.taskView {
        case "day": unit = .day; amount = dir
        case "3day": unit = .day; amount = dir * 3
        case "week": unit = .day; amount = dir * 7
        case "month": unit = .month; amount = dir
        default: return
        }
        model.calAnchor = cal.date(byAdding: unit, value: amount, to: model.calAnchor) ?? model.calAnchor
    }

    private var rangeLabel: String {
        let df = DateFormatter()
        if model.taskView == "month" {
            df.dateFormat = "MMMM yyyy"
            return df.string(from: model.calAnchor)
        }
        let days = CalendarMath.rangeDays(view: model.taskView, anchor: model.calAnchor)
        df.dateFormat = "MMM d"
        guard let first = days.first, let last = days.last else { return "" }
        return days.count == 1 ? df.string(from: first) : "\(df.string(from: first)) – \(df.string(from: last))"
    }
}

struct QuickAddSeed: Identifiable {
    let date: Date
    let minutes: Int?
    var id: String { "\(date.timeIntervalSince1970)-\(minutes ?? -1)" }
}

// MARK: - List

struct TaskListView: View {
    let tasks: [TaskItem]
    let onAdd: (String, String?, String?) -> Void
    let onComplete: (String) -> Void
    let onReschedule: (TaskItem) -> Void

    @State private var title = ""
    @State private var due = ""
    @State private var time = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Inline add (matches Android's list view — no sheet).
            HStack(spacing: 8) {
                TextField("New event", text: $title)
                    .textFieldStyle(.roundedBorder)
                Button("Add") {
                    guard !title.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                    onAdd(title, due.isEmpty ? nil : due, time.isEmpty ? nil : time)
                    title = ""; due = ""; time = ""
                }
                .buttonStyle(.primary)
            }
            HStack(spacing: 8) {
                TextField("Due date — 2026-11-01", text: $due)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("14:30", text: $time)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 100)
            }
            Spacer().frame(height: 8)

            if tasks.isEmpty {
                EmptyState(text: "No events yet. Add one above or ask in Chat.", systemImage: "checkmark.circle")
            } else {
                ForEach(tasks) { row($0) }
            }
        }
    }

    @ViewBuilder
    private func row(_ t: TaskItem) -> some View {
        let done = t.status == "done"
        AppCard {
            HStack(spacing: 8) {
                Button { if !done { onComplete(t.id) } } label: {
                    Image(systemName: done ? "checkmark.square.fill" : "square")
                        .font(.system(size: 20))
                        .foregroundStyle(done ? Theme.accent : Theme.textFaint)
                }
                .buttonStyle(.plain).disabled(done)
                Text(t.title)
                    .appBody()
                    .strikethrough(done)
                    .foregroundStyle(done ? Theme.textMuted : Theme.text)
                Spacer()
                if let d = t.dueDate {
                    Text(t.dueTime != nil ? "\(d) \(t.dueTime!)" : d)
                        .appLabelSmall().foregroundStyle(Theme.textMuted)
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(Theme.surfaceSunk, in: Capsule())
                        .onTapGesture { if !done { onReschedule(t) } }
                }
            }
        }
    }
}

// MARK: - Schedule grid (day / 3day / week)

struct TaskScheduleView: View {
    let view: String
    let tasks: [TaskItem]
    let anchor: Date
    let onTapSlot: (Date, Int) -> Void
    let onTapTask: (TaskItem) -> Void

    private let hourH: CGFloat = 56

    var body: some View {
        let days = CalendarMath.rangeDays(view: view, anchor: anchor)
        VStack(spacing: 0) {
            // Day headers + an all-day row for tasks with no time.
            HStack(alignment: .top, spacing: 0) {
                Spacer().frame(width: 26)
                ForEach(days, id: \.self) { day in
                    let allDay = tasks.filter { $0.dayKey == CalendarMath.dayKey(day) && $0.dueTime == nil }
                    VStack(spacing: 2) {
                        Text(dayHeader(day)).appLabelSmall()
                        ForEach(allDay.prefix(2)) { t in
                            Text(t.title).font(.system(size: 9)).lineLimit(1)
                                .padding(.horizontal, 3).padding(.vertical, 1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.marigold.opacity(0.25), in: RoundedRectangle(cornerRadius: 3))
                                .onTapGesture { onTapTask(t) }
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.bottom, 4)

            ScrollViewReader { proxy in
                ScrollView {
                    HStack(alignment: .top, spacing: 0) {
                        VStack(spacing: 0) {
                            ForEach(0..<24, id: \.self) { h in
                                Text(String(format: "%02d", h))
                                    .appLabelSmall().foregroundStyle(Theme.textFaint)
                                    .frame(height: hourH, alignment: .top)
                                    .id("hour-\(h)")
                            }
                        }
                        .frame(width: 26)
                        ForEach(days, id: \.self) { day in
                            dayColumn(day).frame(maxWidth: .infinity)
                        }
                    }
                    .padding(.top, 4)
                }
                .onAppear { proxy.scrollTo("hour-7", anchor: .top) }
            }
        }
    }

    @ViewBuilder
    private func dayColumn(_ day: Date) -> some View {
        let key = CalendarMath.dayKey(day)
        let dayTasks = tasks.filter { $0.dayKey == key && $0.dueTime != nil }
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(0..<24, id: \.self) { _ in
                    Rectangle().fill(Theme.border).frame(height: 1)
                    Spacer().frame(height: hourH - 1)
                }
            }
            .contentShape(Rectangle())
            .gesture(
                SpatialTapGesture().onEnded { value in
                    let mins = Int((value.location.y / hourH) * 60 / 30) * 30
                    onTapSlot(day, min(max(0, mins), 23 * 60 + 30))
                }
            )
            ForEach(dayTasks) { t in
                let mins = t.minutesOfDay ?? 9 * 60
                Text(t.title)
                    .appLabelSmall()
                    .lineLimit(1)
                    .padding(.horizontal, 4).padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 4))
                    .offset(y: CGFloat(mins) / 60 * hourH)
                    .onTapGesture { onTapTask(t) }
            }
        }
    }

    private func dayHeader(_ d: Date) -> String {
        let df = DateFormatter(); df.dateFormat = "EEE d"
        return df.string(from: d)
    }
}

// MARK: - Month

struct TaskMonthView: View {
    let tasks: [TaskItem]
    let anchor: Date
    let onTapDay: (Date) -> Void

    private let cols = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)

    var body: some View {
        let grid = CalendarMath.monthGrid(anchor: anchor)
        LazyVGrid(columns: cols, spacing: 2) {
            ForEach(["M", "T", "W", "T", "F", "S", "S"], id: \.self) {
                Text($0).appLabelSmall().foregroundStyle(Theme.textMuted)
            }
            ForEach(grid, id: \.self) { day in
                let key = CalendarMath.dayKey(day)
                let dayTasks = tasks.filter { $0.dayKey == key }
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(CalendarMath.cal.component(.day, from: day))")
                        .appLabelSmall()
                        .foregroundStyle(CalendarMath.isSameMonth(day, anchor) ? Theme.text : Theme.textFaint)
                    ForEach(dayTasks.prefix(2)) { t in
                        Text(t.title).font(.system(size: 8)).lineLimit(1)
                            .foregroundStyle(Theme.accent)
                    }
                    if dayTasks.count > 2 {
                        Text("+\(dayTasks.count - 2)").font(.system(size: 8)).foregroundStyle(Theme.textMuted)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 54, alignment: .topLeading)
                .padding(3)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.border, lineWidth: 0.5))
                .onTapGesture { onTapDay(day) }
            }
        }
    }
}

// MARK: - Sheets

struct RescheduleSheet: View {
    @Environment(\.dismiss) private var dismiss
    let task: TaskItem
    let onSave: (String?, String?) -> Void

    @State private var date = Date()
    @State private var hasDate = true
    @State private var hasTime = false
    @State private var time = Date()

    var body: some View {
        NavigationStack {
            Form {
                Toggle("Has a date", isOn: $hasDate)
                if hasDate {
                    DatePicker("Date", selection: $date, displayedComponents: .date)
                    Toggle("Specific time", isOn: $hasTime)
                    if hasTime {
                        DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                    }
                }
            }
            .navigationTitle(task.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if !hasDate { onSave(nil, nil) }
                        else {
                            let t = hasTime ? DateFormatter.hhmm.string(from: time) : nil
                            onSave(date.isoDay, t)
                        }
                        dismiss()
                    }
                }
            }
            .onAppear {
                if let d = parseISODay(task.dueDate) { date = d }
                hasDate = task.dueDate != nil
                hasTime = task.dueTime != nil
            }
        }
    }
}

struct QuickAddSheet: View {
    @Environment(\.dismiss) private var dismiss
    let seed: QuickAddSeed
    let onAdd: (String, String?, String?) -> Void

    @State private var title = ""
    @State private var date = Date()
    @State private var hasTime = false
    @State private var time = Date()

    var body: some View {
        NavigationStack {
            Form {
                TextField("What is it?", text: $title)
                DatePicker("Date", selection: $date, displayedComponents: .date)
                Toggle("Specific time", isOn: $hasTime)
                if hasTime {
                    DatePicker("Time", selection: $time, displayedComponents: .hourAndMinute)
                }
            }
            .navigationTitle("New event").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        let t = hasTime ? DateFormatter.hhmm.string(from: time) : nil
                        onAdd(title, date.isoDay, t)
                        dismiss()
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                date = seed.date
                if let m = seed.minutes {
                    hasTime = true
                    time = CalendarMath.cal.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: seed.date) ?? Date()
                }
            }
        }
    }
}

extension DateFormatter {
    static let hhmm: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f
    }()
}
