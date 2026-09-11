import SwiftUI

/// The Artifacts tab — a browsable list of the full pages the assistant
/// generated with `render_artifact`. Tapping one pushes the sealed viewer.
/// The iOS mirror of the desktop `#view-artifacts` and Android `ArtifactsScreen`.
struct ArtifactsView: View {
    @Environment(AppModel.self) private var model
    // Set imperatively, only inside the row's tap action — NOT
    // `NavigationLink(value: ArtifactPresentation(...))`, which was tried
    // first and made tapping a row silently do nothing: that constructs a
    // fresh (random-UUID) value on every view *re-render*, not just on tap,
    // since it's computed declaratively in the body. SwiftUI needs a
    // NavigationLink's value to stay stable across renders while a tap is
    // being recognized; regenerating it on every render — confirmed via
    // device logs: zero requests to /artifacts/:id ever fired — can drop
    // the tap before it ever reaches the destination or the network.
    // `.navigationDestination(item:)` (same pattern as `AppModel
    // .viewingArtifact` + `fullScreenCover(item:)`) pushes only when this
    // is explicitly set, so it's still a fresh identity per tap without
    // that hazard.
    @State private var pushed: ArtifactPresentation?

    var body: some View {
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
                        Button {
                            pushed = ArtifactPresentation(artifactId: a.id)
                        } label: {
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
        .navigationDestination(item: $pushed) { presentation in
            ArtifactViewerView(artifactId: presentation.artifactId, presentedAsSheet: false)
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
