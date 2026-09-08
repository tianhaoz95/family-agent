import SwiftUI

// Shared UI pieces — the iOS mirror of `android/.../ui/Components.kt`.

// MARK: - ScreenScaffold

/// Standard screen frame: a title, an editorial serif subtitle, then content.
/// Transparent — the `Atmosphere` gradient shows through.
struct ScreenScaffold<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).appHeadline().foregroundStyle(Theme.text)
            Spacer().frame(height: 6)
            Text(subtitle)
                .font(.serif(17))
                .foregroundStyle(Theme.textBody)
            Spacer().frame(height: 22)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, 20)
        // Room for the floating menu button (MainShell) — the Android
        // ScreenScaffold reserves the same 58dp.
        .padding(.top, 56)
    }
}

// MARK: - AppCard

struct AppCard<Content: View>: View {
    var accent: Color? = nil
    var onTap: (() -> Void)? = nil
    @ViewBuilder var content: Content

    var body: some View {
        let card = VStack(spacing: 0) {
            if let accent {
                Rectangle().fill(accent).frame(height: 4)
            }
            VStack(alignment: .leading, spacing: 8) { content }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.06), radius: 8, x: 0, y: 3)

        if let onTap {
            Button(action: onTap) { card }
                .buttonStyle(PressScaleStyle())
        } else {
            card
        }
    }
}

struct PressScaleStyle: ButtonStyle {
    var scale: CGFloat = 0.97
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// MARK: - Small bits

struct Chip: View {
    let text: String
    var color: Color = Theme.accent
    var body: some View {
        Text(text.uppercased())
            .font(.inter(11, .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(color.opacity(0.14), in: Capsule())
    }
}

struct StatusDot: View {
    let color: Color
    var body: some View { Circle().fill(color).frame(width: 9, height: 9) }
}

struct EmptyState: View {
    let text: String
    var systemImage: String = "sparkles"
    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                Circle().fill(Theme.accentSoft).frame(width: 72, height: 72)
                Image(systemName: systemImage)
                    .font(.system(size: 26))
                    .foregroundStyle(Theme.accent)
            }
            Text(text)
                .appBody()
                .foregroundStyle(Theme.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
        .padding(.horizontal, 24)
    }
}

// MARK: - CopyButton

struct CopyButton: View {
    let text: String
    @State private var copied = false
    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
        } label: {
            Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                .font(.inter(12, .medium))
                .foregroundStyle(copied ? Theme.ok : Theme.textMuted)
        }
        .buttonStyle(.plain)
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

// MARK: - SpeakButton

struct SpeakButton: View {
    let text: String
    let speakingText: String?
    let loadingText: String?
    let onToggle: (String) -> Void

    private var body_: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var playing: Bool { speakingText == body_ }
    private var loading: Bool { loadingText == body_ }

    var body: some View {
        Button { onToggle(body_) } label: {
            HStack(spacing: 5) {
                if loading {
                    ProgressView().controlSize(.mini).tint(Theme.accent)
                    Text("Synthesizing…").font(.inter(12, .medium)).foregroundStyle(Theme.textMuted)
                } else if playing {
                    Image(systemName: "stop.fill").font(.system(size: 12)).foregroundStyle(Theme.accent)
                    Text("Stop").font(.inter(12, .medium)).foregroundStyle(Theme.accent)
                } else {
                    Image(systemName: "speaker.wave.2").font(.system(size: 12)).foregroundStyle(Theme.textMuted)
                    Text("Read aloud").font(.inter(12, .medium)).foregroundStyle(Theme.textMuted)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - TypingDots

struct TypingDots: View {
    @State private var t = 0.0
    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Theme.textMuted)
                    .frame(width: 7, height: 7)
                    .offset(y: bounce(i) * -5)
                    .opacity(0.45 + 0.55 * bounce(i))
            }
        }
        .padding(.horizontal, 18).padding(.vertical, 15)
        .background(Theme.surface)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 6, bottomTrailingRadius: 18, topTrailingRadius: 18))
        .overlay(
            UnevenRoundedRectangle(topLeadingRadius: 18, bottomLeadingRadius: 6, bottomTrailingRadius: 18, topTrailingRadius: 18)
                .stroke(Theme.border, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.06), radius: 8, y: 3)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(60))
                await MainActor.run { t += 0.12 }
            }
        }
    }
    private func bounce(_ i: Int) -> Double {
        (sin(t - Double(i) * 0.6) + 1) / 2
    }
}

// MARK: - FlowLayout

/// Simple wrapping layout (the iOS analogue of Compose `FlowRow`).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x + s.width > maxWidth, x > 0 {
                x = 0; y += rowHeight + spacing; rowHeight = 0
            }
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX; y += rowHeight + spacing; rowHeight = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
        }
    }
}

// MARK: - StepsStrip

struct StepsStrip: View {
    let steps: [ToolStep]
    let live: Bool
    let onTap: () -> Void

    private var running: Bool { steps.contains { $0.phase == "running" } || (live && steps.isEmpty) }
    private var errored: Bool { steps.contains { $0.phase == "error" } }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 7) {
                    if running {
                        ProgressView().controlSize(.mini).tint(Theme.accent)
                        Text(steps.isEmpty ? "Working…" : "Working — \(steps.count) tool call\(steps.count == 1 ? "" : "s")")
                            .appLabelSmall().foregroundStyle(Theme.accent)
                    } else {
                        Text(errored ? "!" : "✓")
                            .font(.inter(11, .bold))
                            .foregroundStyle(errored ? Theme.danger : Theme.accent)
                        Text("\(steps.count) tool call\(steps.count == 1 ? "" : "s")")
                            .appLabelSmall().foregroundStyle(Theme.textMuted)
                    }
                }
                if !steps.isEmpty {
                    FlowLayout(spacing: 5) {
                        ForEach(steps.prefix(8)) { s in
                            HStack(spacing: 5) {
                                Circle()
                                    .fill(s.phase == "error" ? Theme.danger : Theme.accent)
                                    .frame(width: 5, height: 5)
                                Text(stepVerb(s))
                                    .appLabelSmall()
                                    .foregroundStyle(s.phase == "error" ? Theme.danger : Theme.textMuted)
                                    .lineLimit(1)
                            }
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Theme.surfaceSunk, in: Capsule())
                        }
                    }
                }
            }
            .padding(.horizontal, 11).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// Friendly verb for one tool call — mirrors `stepVerb` in Components.kt.
func stepVerb(_ s: ToolStep) -> String {
    let map: [String: String] = [
        "search_documents": "search documents",
        "list_documents": "list documents",
        "get_document": "open a document",
        "save_extraction": "save document fields",
        "search_tasks": "search events",
        "list_tasks": "list events",
        "create_task": "add an event",
        "update_task": "update an event",
        "list_sticky_notes": "read the board",
        "add_sticky_note": "pin a note",
        "list_family_tools": "list tools",
        "describe_family_tool": "inspect a tool",
        "call_family_tool": "use a tool",
        "run_code": "run a calculation",
        "web_search": "search the web",
        "open_page": "open a web page",
        "list_skills": "list skills",
        "use_skill": "use a skill",
        "current_datetime": "check the time",
    ]
    if let v = map[s.tool] { return v }
    return s.tool.replacingOccurrences(of: "_", with: " ")
}
