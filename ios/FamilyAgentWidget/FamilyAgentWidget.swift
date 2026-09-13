import SwiftUI
import WidgetKit

/// The home screen widget: a Claude/Gemini-style launcher bar — an
/// input-field-shaped tap target that opens Chat, plus mic and camera
/// buttons that open Chat AND immediately trigger that control. Each zone is
/// its own `Link` (supported inside a widget since iOS 16) to a
/// `familyagent://chat[?action=mic|camera]` URL; the app's `onOpenURL`
/// (`WidgetLaunch.swift`) parses it. The Android counterpart is
/// `widget/FamilyAgentWidget.kt`.
///
/// No `TimelineProvider` data of any kind: this is a static shortcut row,
/// not a dashboard, so a single placeholder-free entry with `.never` refresh
/// is all it needs.
struct FamilyAgentWidgetEntry: TimelineEntry {
    let date: Date
}

struct FamilyAgentWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> FamilyAgentWidgetEntry { FamilyAgentWidgetEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (FamilyAgentWidgetEntry) -> Void) {
        completion(FamilyAgentWidgetEntry(date: Date()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<FamilyAgentWidgetEntry>) -> Void) {
        completion(Timeline(entries: [FamilyAgentWidgetEntry(date: Date())], policy: .never))
    }
}

private func chatURL(action: String? = nil) -> URL {
    var comps = URLComponents()
    comps.scheme = "familyagent"
    comps.host = "chat"
    if let action { comps.queryItems = [URLQueryItem(name: "action", value: action)] }
    return comps.url!
}

/// Matches `Theme.accent` (`#0075DE`) — the widget extension is a separate
/// target from the app, so it can't reach `Theme.swift` directly, and one
/// hard-coded color constant here is simpler than sharing a whole file for
/// this alone. Kept in sync with `Theme.accent` / Android's `ic_widget_*.xml`
/// fill by hand, same as every other cross-platform token in this app.
private let accent = Color(red: 0x00 / 255, green: 0x75 / 255, blue: 0xDE / 255)
private let fieldBg = Color(white: 0.96)

struct FamilyAgentWidgetEntryView: View {
    var body: some View {
        HStack(spacing: 10) {
            Image("WidgetLogo")
                .resizable()
                .frame(width: 30, height: 30)
                .clipShape(RoundedRectangle(cornerRadius: 7))

            Link(destination: chatURL()) {
                HStack {
                    Text("Ask Family Agent…")
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .frame(height: 42)
                .background(fieldBg)
                .clipShape(RoundedRectangle(cornerRadius: 21))
            }
            .buttonStyle(.plain)

            Link(destination: chatURL(action: "mic")) {
                Image(systemName: "mic.fill")
                    .foregroundStyle(accent)
                    .frame(width: 42, height: 42)
            }
            .buttonStyle(.plain)

            Link(destination: chatURL(action: "camera")) {
                Image(systemName: "camera.fill")
                    .foregroundStyle(accent)
                    .frame(width: 42, height: 42)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .containerBackground(.white, for: .widget)
    }
}

struct FamilyAgentWidget: Widget {
    let kind: String = "FamilyAgentWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: FamilyAgentWidgetProvider()) { _ in
            FamilyAgentWidgetEntryView()
        }
        .configurationDisplayName("Family Agent")
        .description("Jump into Chat, or start talking / snap a photo right away.")
        .supportedFamilies([.systemMedium])
        // A launcher bar makes no sense stacked into someone else's Smart
        // Stack rotation — it should just sit where it was placed.
        .disableContentMarginsIfNeeded()
    }
}

@main
struct FamilyAgentWidgetBundle: WidgetBundle {
    var body: some Widget {
        FamilyAgentWidget()
    }
}

private extension WidgetConfiguration {
    /// `.contentMarginsDisabled()` only exists on iOS 17+; this app's widget
    /// extension shares the app's iOS 18 minimum, but spelling it as an
    /// availability-guarded shim (rather than calling it bare) keeps this
    /// file copy-paste-safe if the deployment target ever drifts down.
    func disableContentMarginsIfNeeded() -> some WidgetConfiguration {
        if #available(iOSApplicationExtension 17.0, *) {
            return self.contentMarginsDisabled()
        }
        return self
    }
}
