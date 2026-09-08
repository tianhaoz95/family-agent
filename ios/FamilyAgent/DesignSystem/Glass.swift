import SwiftUI

/// Liquid Glass abstraction. iOS 26 gets the real `.glassEffect` / `.buttonStyle(.glass)`;
/// iOS 18–25 falls back to `.ultraThinMaterial` + a hairline border (the closest
/// the older SDK offers). Every "glass" surface in the app routes through here so
/// the availability check lives in one place.
enum GlassKind {
    case chrome         // sidebars, nav/toolbars
    case sheet          // detail / editor sheets (long-form reading → stronger)
    case floating       // floating action clusters, mic-overlay chrome
}

extension View {
    /// Apply a glass background clipped to `shape`.
    @ViewBuilder
    func glass(_ kind: GlassKind = .chrome,
               in shape: some Shape = RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous)) -> some View {
        if #available(iOS 26, *) {
            switch kind {
            case .floating:
                self.glassEffect(.regular.interactive(), in: shape)
            case .chrome, .sheet:
                self.glassEffect(.regular, in: shape)
            }
        } else {
            let material: Material = (kind == .sheet) ? .regularMaterial : .ultraThinMaterial
            self.background(material, in: shape)
                .overlay(shape.stroke(Theme.border, lineWidth: 1))
        }
    }

    /// A glass-styled button (composer send, floating actions).
    @ViewBuilder
    func glassButton(prominent: Bool = false) -> some View {
        if #available(iOS 26, *) {
            if prominent { self.buttonStyle(.glassProminent) }
            else { self.buttonStyle(.glass) }
        } else {
            if prominent {
                self.buttonStyle(.borderedProminent).tint(Theme.accent)
            } else {
                self.buttonStyle(.bordered).tint(Theme.accent)
            }
        }
    }

    /// Group child glass shapes so they merge/morph (iOS 26 `GlassEffectContainer`).
    /// No-op below 26.
    @ViewBuilder
    func glassGroup() -> some View {
        if #available(iOS 26, *) {
            GlassEffectContainer { self }
        } else {
            self
        }
    }
}
