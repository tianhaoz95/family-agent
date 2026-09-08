import SwiftUI

struct ActivityView: View {
    @Environment(AppModel.self) private var model

    private func actorLabel(_ a: String) -> String {
        switch a {
        case "task-agent": "Events"
        case "document-agent": "Documents"
        case "routine": "Routine"
        case "user": "You"
        default: a
        }
    }

    var body: some View {
        ScrollView {
            ScreenScaffold(title: "Activity", subtitle: "Everything the assistant and you have done.") {
                if model.activity.isEmpty {
                    EmptyState(text: "Nothing yet.", systemImage: "clock")
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(model.activity) { e in
                            HStack(alignment: .top, spacing: 10) {
                                Chip(text: actorLabel(e.actor), color: Theme.skyWash)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(e.detail).appBodySmall()
                                    Text(friendlyTimestamp(e.ts)).appLabelSmall().foregroundStyle(Theme.textMuted)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 4)
                            Divider()
                        }
                    }
                }
            }
        }
        .task { await model.refreshActivity() }
    }
}
