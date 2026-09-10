import SwiftUI

/// Text that clamps to `collapsedLimit` lines and, only when the content actually
/// overflows that, reveals a "Show more / less" toggle. Used by the Activity feed
/// so long detail lines stay scannable (mirrors the desktop `.activity-detail`
/// clamp and Android's `maxLines` toggle).
struct ExpandableText: View {
    let text: String
    var font: Font = .inter(15)
    var collapsedLimit = 2

    @State private var expanded = false
    @State private var fullHeight: CGFloat = 0
    @State private var clampedHeight: CGFloat = 0

    private var truncatable: Bool { fullHeight > clampedHeight + 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(text)
                .font(font)
                .fixedSize(horizontal: false, vertical: true)
                .lineLimit(expanded ? nil : collapsedLimit)
                .background {
                    // Hidden probes measured at the same width: the full text and
                    // the same text clamped to the collapsed line limit.
                    ZStack {
                        Text(text).font(font).fixedSize(horizontal: false, vertical: true)
                            .background(GeometryReader { g in
                                Color.clear.preference(key: FullHeightKey.self, value: g.size.height)
                            })
                        Text(text).font(font).lineLimit(collapsedLimit)
                            .fixedSize(horizontal: false, vertical: true)
                            .background(GeometryReader { g in
                                Color.clear.preference(key: ClampedHeightKey.self, value: g.size.height)
                            })
                    }
                    .hidden()
                }
                .onPreferenceChange(FullHeightKey.self) { fullHeight = $0 }
                .onPreferenceChange(ClampedHeightKey.self) { clampedHeight = $0 }

            if truncatable {
                Button(expanded ? "Show less" : "Show more") {
                    withAnimation(.easeInOut(duration: 0.15)) { expanded.toggle() }
                }
                .font(.inter(12, .medium))
                .foregroundStyle(Theme.accentInk)
                .buttonStyle(.plain)
            }
        }
    }
}

private struct FullHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct ClampedHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
