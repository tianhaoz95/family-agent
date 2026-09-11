import SwiftUI

// Shared UI pieces — the iOS mirror of `android/.../ui/Components.kt`.

// MARK: - ScreenScaffold

/// Standard screen frame: a title, an editorial serif subtitle, then content.
/// Transparent — the `Atmosphere` gradient shows through.
///
/// The title is a **fixed** header, not part of the scrollable body: MainShell's
/// floating menu button is a ZStack overlay at a fixed position, oblivious to
/// any scroll offset. Older versions of this view put the title inside the
/// same ScrollView as the content (each screen wrapped the whole thing in its
/// own `ScrollView { ScreenScaffold(...) { ... } }`) — as soon as the screen
/// scrolled even slightly, the title (now above the reserved top inset) moved
/// up underneath the button and was covered by it, exactly the effect Chat/
/// Messages' own screens never had because *their* title row lives in a plain
/// HStack outside their ScrollView. This makes every ScreenScaffold user do
/// the same thing by construction — the caller no longer wraps it in its own
/// ScrollView; only `subtitle` + `content` scroll under the fixed title.
struct ScreenScaffold<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).appHeadline().foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 20)
                // Room for the floating menu button (MainShell) — the Android
                // ScreenScaffold reserves the same 58dp.
                .padding(.top, 58)
                .padding(.bottom, 6)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // The serif voice stays, but quieter: at 16.5 it ran three lines on
                    // Routines/Vault/Skills and pushed content far down the screen while
                    // competing with the title for attention.
                    Text(subtitle)
                        .font(.serif(15))
                        .lineSpacing(1.5)
                        .foregroundStyle(Theme.textBody)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer().frame(height: 20)
                    content
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
                .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - AppCard

struct AppCard<Content: View>: View {
    var accent: Color? = nil
    var padding: CGFloat = 18
    var onTap: (() -> Void)? = nil
    @ViewBuilder var content: Content

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous) }

    var body: some View {
        let card = VStack(spacing: 0) {
            if let accent {
                Capsule().fill(accent).frame(width: 34, height: 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, padding)
                    .padding(.top, padding - 6)
            }
            VStack(alignment: .leading, spacing: 8) { content }
                .padding(padding)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        // Paper, not glass: a flat warm-white sheet, a warm hairline, and a short
        // shadow. (The glossy top-highlight gradient that used to be here read as a
        // web card — it only made sense while the ground was a dark colour wash.)
        .background(Theme.surface, in: shape)
        .overlay(shape.strokeBorder(Theme.border, lineWidth: 1))
        .elevation(Theme.E.card)

        if let onTap {
            Button(action: onTap) { card }
                .buttonStyle(PressScaleStyle())
        } else {
            card
        }
    }
}

struct PressScaleStyle: ButtonStyle {
    var scale: CGFloat = 0.985
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .brightness(configuration.isPressed ? -0.015 : 0)
            .animation(.spring(response: 0.28, dampingFraction: 0.72), value: configuration.isPressed)
    }
}

// MARK: - Small bits

struct Chip: View {
    let text: String
    var color: Color = Theme.accentInk
    var body: some View {
        Text(text.uppercased())
            .font(.inter(10.5, .bold))
            .tracking(0.4)
            .foregroundStyle(color.opacity(0.92))
            .padding(.horizontal, 9)
            .padding(.vertical, 3.5)
            .background(color.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.10), lineWidth: 1))
    }
}

struct StatusDot: View {
    let color: Color
    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8)
            .overlay(Circle().strokeBorder(color.opacity(0.25), lineWidth: 3).blur(radius: 0.5))
    }
}

struct EmptyState: View {
    let text: String
    var systemImage: String = "sparkles"
    var body: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().fill(Theme.accentSoft).frame(width: 78, height: 78)
                Circle().strokeBorder(.white.opacity(0.6), lineWidth: 1).frame(width: 78, height: 78)
                Image(systemName: systemImage)
                    .font(.system(size: 27, weight: .regular))
                    .foregroundStyle(Theme.accentInk.opacity(0.85))
            }
            .elevation(Theme.E.sm)
            Text(text)
                .font(.inter(14.5))
                .foregroundStyle(Theme.textMuted)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 72)
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
                    Image(systemName: "stop.fill").font(.system(size: 12)).foregroundStyle(Theme.accentInk)
                    Text("Stop").font(.inter(12, .medium)).foregroundStyle(Theme.accentInk)
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
    private let shape = UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 6, bottomTrailingRadius: 20, topTrailingRadius: 20)
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Theme.accent.opacity(0.55))
                    .frame(width: 6.5, height: 6.5)
                    .scaleEffect(0.7 + 0.5 * bounce(i))
                    .offset(y: bounce(i) * -3)
                    .opacity(0.4 + 0.6 * bounce(i))
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
        .background(Theme.surfaceSunk, in: shape)
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(55))
                await MainActor.run { t += 0.14 }
            }
        }
    }
    private func bounce(_ i: Int) -> Double {
        (sin(t - Double(i) * 0.7) + 1) / 2
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
                            .appLabelSmall().foregroundStyle(Theme.accentInk)
                    } else {
                        Text(errored ? "!" : "✓")
                            .font(.inter(11, .bold))
                            .foregroundStyle(errored ? Theme.danger : Theme.accentInk)
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

/// Friendly verb for one tool call — mirrors `stepVerb` in `DetailSheet.kt`.
func stepVerb(_ s: ToolStep) -> String {
    if s.tool == "task", let sub = s.subagent, !sub.isEmpty { return "Delegated to \(sub)" }
    switch s.tool {
    case "search_documents":  return "Searched documents"
    case "list_documents":    return "Listed documents"
    case "read_document":     return "Read a document"
    case "search_tasks":      return "Searched tasks"
    case "list_tasks":        return "Listed tasks"
    case "create_task":       return "Created a task"
    case "complete_task":     return "Completed a task"
    case "list_sticky_notes": return "Read the notes board"
    case "add_sticky_note":   return "Pinned a note"
    case "run_code":          return "Ran a calculation"
    case "web_search":        return "Searched the web"
    case "open_page":         return "Opened a web page"
    case "call_family_tool":  return "Used a family tool"
    case "call_mcp_tool":     return "Called a connected service"
    case "use_skill":         return "Loaded a skill"
    case "current_datetime":  return "Checked the date"
    default:                  return s.tool.replacingOccurrences(of: "_", with: " ")
    }
}
