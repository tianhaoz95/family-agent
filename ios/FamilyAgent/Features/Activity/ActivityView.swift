import SwiftUI

struct ActivityView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Activity",
                           subtitle: "Everything the agent has read or changed, newest first.") {
                if model.activity.isEmpty {
                    EmptyState(text: "Nothing has happened yet.", systemImage: "clock")
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(model.activity) { e in
                            HStack(alignment: .top, spacing: 10) {
                                Text(String(e.ts.split(separator: "T").last?.split(separator: ".").first ?? ""))
                                    .appLabelSmall()
                                    .foregroundStyle(Theme.textMuted)
                                    .padding(.top, 2)
                                Text(e.actor)
                                    .appLabelSmall()
                                    .foregroundStyle(Theme.accentInk)
                                    .padding(.horizontal, 8).padding(.vertical, 2)
                                    .background(Theme.accentSoft, in: Capsule())
                                Text(e.detail).appBody()
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 8)
                        }
                    }
                }
            }
        }
        .task { await model.refreshActivity() }
    }
}
