import SwiftUI

// The DESIGN.md button system, as SwiftUI styles:
//   .primary  — the one filled #0075de pill (one per screen)
//   .ghost    — #e6f3fe sky-tint fill, accent text (secondary actions)
//   .soft     — transparent, quiet; accent-tinted label
// All 8pt-ish radius via Capsule for pills, springy press.

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.inter(14.5, .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(
                (enabled ? Theme.accent : Theme.textFaint)
                    .opacity(configuration.isPressed ? 0.82 : 1),
                in: Capsule(style: .continuous)
            )
            .elevation(enabled ? Theme.E.sm : Theme.Shadow(color: .clear, radius: 0, y: 0))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

struct GhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.inter(14, .semibold))
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(Theme.accentSoft.opacity(configuration.isPressed ? 0.7 : 1), in: Capsule(style: .continuous))
            .overlay(Capsule().strokeBorder(Theme.accent.opacity(0.12), lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

struct SoftButtonStyle: ButtonStyle {
    var tint: Color = Theme.accent
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.inter(13.5, .medium))
            .foregroundStyle(tint.opacity(configuration.isPressed ? 0.55 : 1))
            .padding(.horizontal, 8).padding(.vertical, 5)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { .init() }
}
extension ButtonStyle where Self == GhostButtonStyle {
    static var ghost: GhostButtonStyle { .init() }
}
extension ButtonStyle where Self == SoftButtonStyle {
    static var soft: SoftButtonStyle { .init() }
    static func soft(_ tint: Color) -> SoftButtonStyle { .init(tint: tint) }
}

// MARK: - Brand segmented control (warm paper, not the iOS grey)

struct BrandSegmented<Tag: Hashable>: View {
    let options: [(Tag, String)]
    @Binding var selection: Tag
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.0) { tag, label in
                let selected = tag == selection
                Text(label)
                    .font(.inter(13, selected ? .semibold : .medium))
                    .foregroundStyle(selected ? Theme.accent : Theme.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 7)
                    .background {
                        if selected {
                            Capsule(style: .continuous)
                                .fill(Theme.surface)
                                .elevation(Theme.E.sm)
                                .matchedGeometryEffect(id: "seg", in: ns)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { selection = tag }
                    }
            }
        }
        .padding(3)
        .background(Theme.surfaceSunk, in: Capsule(style: .continuous))
        .overlay(Capsule().strokeBorder(Theme.border, lineWidth: 1))
    }
}
