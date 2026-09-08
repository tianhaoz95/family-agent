import SwiftUI

struct DetailSheet: View {
    let content: DetailContent
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                switch content {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed(let msg):
                    EmptyState(text: msg, systemImage: "exclamationmark.triangle")
                case .task(let t):
                    taskDetail(t)
                case .document(let doc, let pdf):
                    documentDetail(doc, pdf)
                case .steps(let steps):
                    stepsDetail(steps)
                case .cardSource(let title, let fragment):
                    ScrollView {
                        Text(fragment)
                            .font(.system(.footnote, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .padding()
                    }
                    .navigationTitle(title)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(.regularMaterial)
    }

    @ViewBuilder
    private func taskDetail(_ t: TaskItem) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(t.title).appTitle()
                if let d = t.dueDate {
                    Label(d + (t.dueTime.map { " · \($0)" } ?? ""), systemImage: "calendar")
                        .appBodySmall().foregroundStyle(Theme.textMuted)
                }
                Chip(text: t.status == "done" ? "Done" : "To do",
                     color: t.status == "done" ? Theme.ok : Theme.accent)
                if let notes = t.notes, !notes.isEmpty {
                    Text(notes).appBody()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle("Event")
    }

    @ViewBuilder
    private func documentDetail(_ doc: Document, _ pdf: Data?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(doc.filename).appTitle()
                if let cat = doc.extracted?.category {
                    Chip(text: cat, color: Theme.marigold)
                }
                if let sum = doc.extracted?.summary, !sum.isEmpty {
                    Text(sum).appBody().foregroundStyle(Theme.textBody)
                }
                if let dates = doc.extracted?.importantDates, !dates.isEmpty {
                    ForEach(dates, id: \.self) { d in
                        Label(d, systemImage: "calendar").appBodySmall().foregroundStyle(Theme.textMuted)
                    }
                }
                if let pdf {
                    PDFPreview(data: pdf)
                        .frame(height: 460)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                } else if !doc.rawText.isEmpty {
                    Divider()
                    Text(doc.rawText)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle("Document")
    }

    @ViewBuilder
    private func stepsDetail(_ steps: [ToolStep]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(steps) { s in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(stepVerb(s)).appTitleSmall()
                            if let sub = s.subagent { Chip(text: sub, color: Theme.skyWash) }
                            Spacer()
                            Text(s.phase).appLabelSmall().foregroundStyle(s.phase == "error" ? Theme.danger : Theme.textMuted)
                        }
                        if let input = s.input {
                            Text(input.prettyJSON)
                                .font(.system(.caption2, design: .monospaced))
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.surfaceSunk, in: RoundedRectangle(cornerRadius: 8))
                        }
                        if let out = s.output, !out.isEmpty {
                            Text(out)
                                .font(.system(.caption2, design: .monospaced))
                                .lineLimit(12)
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Theme.surfaceSunk, in: RoundedRectangle(cornerRadius: 8))
                        }
                        if let err = s.error {
                            Text(err).font(.caption).foregroundStyle(Theme.danger)
                        }
                    }
                    .padding(12)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
                }
            }
            .padding()
        }
        .navigationTitle("Under the hood")
    }
}
