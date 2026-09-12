import SwiftUI

// A small freehand-drawing modal for the Board's "Draw" note modality — a
// plain SwiftUI Canvas + drag gesture (not PencilKit, which needs a window-
// scoped PKToolPicker and is overkill for a quick sticky-note doodle),
// mirroring desktop's own hand-rolled <canvas> tool 1:1 (same colour swatches
// + three sizes + undo/clear).
private let DRAW_COLORS: [Color] = [
    Color(hex: 0x2B2B2B), Color(hex: 0xC0392B), Color(hex: 0x0075DE),
    Color(hex: 0x1F8A4C), Color(hex: 0xE6A817), .white,
]
private let DRAW_SIZES: [CGFloat] = [3, 7, 14]
private let DRAW_CANVAS_SIZE = CGSize(width: 320, height: 320)

struct DrawNoteSheet: View {
    let onSave: (UIImage) -> Void
    let onCancel: () -> Void

    @State private var strokes: [DrawStroke] = []
    @State private var current: DrawStroke?
    @State private var color: Color = DRAW_COLORS[0]
    @State private var lineWidth: CGFloat = DRAW_SIZES[1]

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                toolbar
                canvas
                Spacer()
            }
            .padding(20)
            .navigationTitle("Draw a note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pin to board") { onSave(renderImage()) }
                }
            }
        }
    }

    private var toolbar: some View {
        HStack(spacing: 14) {
            HStack(spacing: 7) {
                ForEach(DRAW_COLORS.indices, id: \.self) { i in
                    let c = DRAW_COLORS[i]
                    Circle()
                        .fill(c)
                        .frame(width: 24, height: 24)
                        .overlay(
                            Circle().strokeBorder(
                                color == c ? Theme.accent : Theme.border,
                                lineWidth: color == c ? 2.5 : 1
                            )
                        )
                        .onTapGesture { color = c }
                }
            }
            Divider().frame(height: 20)
            HStack(spacing: 8) {
                ForEach(DRAW_SIZES, id: \.self) { w in
                    Circle()
                        .fill(Theme.textStrong)
                        .frame(width: w, height: w)
                        .frame(width: 26, height: 26)
                        .background(lineWidth == w ? Theme.accentSoft : .clear, in: Circle())
                        .onTapGesture { lineWidth = w }
                }
            }
            Spacer()
            Button("Undo") { if !strokes.isEmpty { strokes.removeLast() } }
                .disabled(strokes.isEmpty)
            Button("Clear") { strokes = [] }
                .disabled(strokes.isEmpty)
        }
        .buttonStyle(.ghost)
        .font(.inter(13, .medium))
    }

    private var canvas: some View {
        Canvas { ctx, _ in
            for s in strokes { draw(s, in: &ctx) }
            if let c = current { draw(c, in: &ctx) }
        }
        .frame(width: DRAW_CANVAS_SIZE.width, height: DRAW_CANVAS_SIZE.height)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: Theme.R.sm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.R.sm, style: .continuous).strokeBorder(Theme.border, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { v in
                    if current == nil {
                        current = DrawStroke(points: [v.location], color: color, width: lineWidth)
                    } else {
                        current?.points.append(v.location)
                    }
                }
                .onEnded { _ in
                    if let s = current { strokes.append(s) }
                    current = nil
                }
        )
    }

    private func draw(_ s: DrawStroke, in ctx: inout GraphicsContext) {
        guard let first = s.points.first else { return }
        if s.points.count == 1 {
            // A tap with no drag still leaves a dot.
            let r = s.width / 2
            ctx.fill(Path(ellipseIn: CGRect(x: first.x - r, y: first.y - r, width: s.width, height: s.width)), with: .color(s.color))
            return
        }
        var path = Path()
        path.move(to: first)
        for p in s.points.dropFirst() { path.addLine(to: p) }
        ctx.stroke(path, with: .color(s.color), style: StrokeStyle(lineWidth: s.width, lineCap: .round, lineJoin: .round))
    }

    private func renderImage() -> UIImage {
        let strokesToRender = strokes
        let renderer = ImageRenderer(
            content:
                Canvas { ctx, size in
                    ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
                    for s in strokesToRender { draw(s, in: &ctx) }
                }
                .frame(width: DRAW_CANVAS_SIZE.width, height: DRAW_CANVAS_SIZE.height)
        )
        renderer.scale = 2
        return renderer.uiImage ?? UIImage()
    }
}

private struct DrawStroke {
    var points: [CGPoint]
    var color: Color
    var width: CGFloat
}
