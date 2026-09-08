import SwiftUI

/// The animated gradient canvas — the iOS counterpart of `android/.../ui/Atmosphere.kt`
/// (itself the counterpart of the desktop `body::before/::after` bloom layers).
/// Four soft radial colour blooms drift over the warm paper base on a 34s loop,
/// frozen under Reduce Motion. Sits behind every screen (in `RootView`).
struct Atmosphere: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: reduceMotion)) { ctx in
            Canvas { g, size in
                g.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Theme.canvas))

                let phase: Double = reduceMotion
                    ? 0
                    : (ctx.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 34) / 34)
                        * 2 * .pi

                let w = size.width, h = size.height
                let d = min(w, h)

                let full = Path(CGRect(origin: .zero, size: size))
                func bloom(_ cx: Double, _ cy: Double, _ r: Double, _ color: Color) {
                    g.fill(
                        full,
                        with: .radialGradient(
                            Gradient(colors: [color, color.opacity(0)]),
                            center: CGPoint(x: w * cx, y: h * cy),
                            startRadius: 0,
                            endRadius: d * r
                        )
                    )
                }

                // Radii are a fraction of the SHORT side, so each bloom is a corner
                // glow that falls off well before the middle of the screen. They used
                // to be 1.10–1.34 — larger than the screen itself — which made four
                // full-bleed washes that stacked over the paper instead of lighting it.
                bloom(0.12 + 0.06 * sin(phase),        0.05 + 0.05 * cos(phase * 0.8), 0.72, Theme.bloomSky)
                bloom(0.92 - 0.05 * cos(phase),        0.16 + 0.06 * sin(phase * 1.1), 0.80, Theme.bloomPeach)
                bloom(0.78 + 0.05 * sin(phase * 0.7),  0.95 - 0.05 * cos(phase),       0.85, Theme.bloomLilac)
                bloom(0.05 - 0.04 * cos(phase * 0.9),  0.86 + 0.05 * sin(phase),       0.68, Theme.bloomMint)
            }
            .ignoresSafeArea()
        }
    }
}
