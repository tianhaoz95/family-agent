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

                bloom(0.12 + 0.06 * sin(phase),        0.05 + 0.05 * cos(phase * 0.8), 1.15, Theme.bloomSky)
                bloom(0.92 - 0.05 * cos(phase),        0.16 + 0.06 * sin(phase * 1.1), 1.28, Theme.bloomPeach)
                bloom(0.78 + 0.05 * sin(phase * 0.7),  0.95 - 0.05 * cos(phase),       1.34, Theme.bloomLilac)
                bloom(0.05 - 0.04 * cos(phase * 0.9),  0.86 + 0.05 * sin(phase),       1.10, Theme.bloomMint)
            }
            .ignoresSafeArea()
        }
    }
}
