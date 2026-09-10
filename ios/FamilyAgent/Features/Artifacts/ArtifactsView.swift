import SwiftUI

/// The Artifacts tab — a browsable list of the full pages the assistant
/// generated with `render_artifact`. Tapping one pushes the sealed viewer.
/// The iOS mirror of the desktop `#view-artifacts` and Android `ArtifactsScreen`.
struct ArtifactsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            ScreenScaffold(
                title: "Artifacts",
                subtitle: "Full pages the assistant made to explain something \u{2014} ask it for one in Chat."
            ) {
                VStack(alignment: .leading, spacing: 10) {
                    if model.artifacts.isEmpty {
                        EmptyState(
                            text: "No artifacts yet. Ask the assistant to walk you through something with a page.",
                            systemImage: "rectangle.on.rectangle.angled"
                        )
                    } else {
                        ForEach(model.artifacts) { a in
                            NavigationLink(value: a.id) {
                                AppCard {
                                    HStack(spacing: 8) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(a.title).appTitleSmall().lineLimit(2)
                                            Text(relativeDate(a.createdAt))
                                                .appLabelSmall().foregroundStyle(Theme.textMuted)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(Theme.textFaint)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button(role: .destructive) { model.deleteArtifact(a.id) } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
            }
        }
        .navigationDestination(for: String.self) { id in
            ArtifactViewerView(artifactId: id, presentedAsSheet: false)
        }
        .task { await model.refreshArtifacts() }
        .refreshable { await model.refreshArtifacts() }
    }

    private func relativeDate(_ iso: String) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return "" }
        let rel = RelativeDateTimeFormatter()
        rel.unitsStyle = .abbreviated
        return rel.localizedString(for: date, relativeTo: .now)
    }
}
