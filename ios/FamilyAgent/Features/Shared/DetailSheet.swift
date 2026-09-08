import SwiftUI

/// One bottom-sheet for "assistant referenced this" / "preview this document" /
/// "under the hood" — mirrors `android/.../ui/DetailSheet.kt`.
struct DetailSheet: View {
    let content: DetailContent
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                switch content {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity).padding(24)
                case .failed(let msg):
                    Text(msg).appBody().foregroundStyle(Theme.danger)
                case .task(let t):        taskDetail(t)
                case .document(let d, let pdf): documentDetail(d, pdf)
                case .steps(let steps):   stepsDetail(steps)
                case .cardSource(let title, let fragment): cardSource(title, fragment)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .padding(.bottom, 28)
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(.regularMaterial)
        .presentationDragIndicator(.visible)
    }

    // MARK: task

    @ViewBuilder
    private func taskDetail(_ t: TaskItem) -> some View {
        Text(t.title).font(.inter(22, .bold))
        Spacer().frame(height: 6)
        Chip(text: t.status == "done" ? "done" : "open",
             color: t.status == "done" ? Theme.ok : Theme.accent)
        if let d = t.dueDate {
            Spacer().frame(height: 8)
            Text("Due \(d)" + (t.dueTime.map { " at \($0)" } ?? ""))
                .appBodySmall().foregroundStyle(Theme.textMuted)
        }
        if let notes = t.notes, !notes.isEmpty {
            Spacer().frame(height: 10)
            Text(notes).appBody()
        }
        Spacer().frame(height: 12)
        Text("Open the Events tab to reschedule or complete it.")
            .appLabelSmall().foregroundStyle(Theme.textMuted)
    }

    // MARK: document

    @ViewBuilder
    private func documentDetail(_ doc: Document, _ pdf: Data?) -> some View {
        Text(doc.filename).font(.inter(22, .bold))
        if let cat = doc.extracted?.category {
            Spacer().frame(height: 6); Chip(text: cat)
        }
        if let sum = doc.extracted?.summary, !sum.isEmpty {
            Spacer().frame(height: 10); Text(sum).appBody()
        }
        if let dates = doc.extracted?.importantDates, !dates.isEmpty {
            Spacer().frame(height: 8)
            Text("Important dates: \(dates.joined(separator: ", "))")
                .appBodySmall().foregroundStyle(Theme.textMuted)
        }
        Spacer().frame(height: 14)

        let isPDF = doc.originalMime == "application/pdf" || doc.filename.lowercased().hasSuffix(".pdf")
        if isPDF, let pdf {
            PDFPreview(data: pdf)
                .frame(height: 460)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            Spacer().frame(height: 12)
            Text("Extracted text").appLabelSmall().foregroundStyle(Theme.textMuted)
            Spacer().frame(height: 6)
        } else if isPDF {
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 16)
        }

        Text(doc.rawText)
            .font(.system(.footnote, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Theme.surfaceSunk, in: RoundedRectangle(cornerRadius: 12))
    }

    // MARK: steps

    @ViewBuilder
    private func stepsDetail(_ steps: [ToolStep]) -> some View {
        Text("Under the hood").font(.inter(22, .bold))
        Spacer().frame(height: 6)
        Text("Every tool the assistant called for this reply, in order — the exact arguments it passed and what came back.")
            .appLabelSmall().foregroundStyle(Theme.textMuted)
        Spacer().frame(height: 14)
        if steps.isEmpty {
            Text("No tools were called — the assistant answered directly.")
                .appBody().foregroundStyle(Theme.textMuted)
        }
        ForEach(Array(steps.enumerated()), id: \.element.id) { i, s in
            stepCard(i + 1, s)
            Spacer().frame(height: 12)
        }
    }

    @ViewBuilder
    private func stepCard(_ n: Int, _ s: ToolStep) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("\(n)").font(.inter(12.5, .bold)).foregroundStyle(Theme.accent)
                Text(stepVerb(s)).appTitleSmall()
                Spacer()
                if let ms = s.durationMs {
                    Text(ms < 1000 ? "\(Int(ms))ms" : String(format: "%.1fs", ms / 1000))
                        .appLabelSmall().foregroundStyle(Theme.textMuted)
                }
            }
            Text(s.tool).font(.system(.caption2, design: .monospaced)).foregroundStyle(Theme.textMuted)
                .padding(.top, 2)
            Spacer().frame(height: 8)
            Text("CALLED WITH").appLabelSmall().foregroundStyle(Theme.textMuted)
            monoBlock(s.input?.prettyJSON ?? "(no arguments)")
            if let err = s.error {
                Spacer().frame(height: 8)
                Text("ERROR").appLabelSmall().foregroundStyle(Theme.danger)
                monoBlock(err)
            } else if let out = s.output {
                Spacer().frame(height: 8)
                Text("RETURNED").appLabelSmall().foregroundStyle(Theme.textMuted)
                monoBlock(out.isEmpty ? "(empty)" : out)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.border, lineWidth: 1))
    }

    @ViewBuilder
    private func monoBlock(_ text: String) -> some View {
        Text(text)
            .font(.system(.caption2, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Theme.surfaceSunk, in: RoundedRectangle(cornerRadius: 8))
            .padding(.top, 4)
    }

    // MARK: card source

    @ViewBuilder
    private func cardSource(_ title: String, _ fragment: String) -> some View {
        Text("Card source").font(.inter(22, .bold))
        Spacer().frame(height: 4)
        Text(title).appBodySmall().foregroundStyle(Theme.textMuted)
        Spacer().frame(height: 10)
        Text("The HTML the assistant wrote. It runs sandboxed — no network, no access to the app.")
            .appLabelSmall().foregroundStyle(Theme.textMuted)
        Spacer().frame(height: 10)
        Text(fragment)
            .font(.system(.footnote, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Theme.surfaceSunk, in: RoundedRectangle(cornerRadius: 12))
    }
}
