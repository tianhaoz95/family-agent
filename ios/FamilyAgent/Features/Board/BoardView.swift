import SwiftUI

private let NOTE_SIZE: CGFloat = 148
// Zoom shrinks/grows the STICKERS, not the board: the corkboard rectangle
// (drawn at `geo.size`, the fixed frame GeometryReader hands us) never
// changes size. What changes is the logical coordinate space notes live in
// (`geo.size / boardZoom`) and the on-screen size/position each note is
// rendered at (note.x/y and NOTE_SIZE, each multiplied by boardZoom) — so
// zooming out reveals more logical space for notes to spread into while the
// canvas itself stays put. Mirrors the desktop fix (fixed #note-board +
// scaled #note-canvas layer), done as plain arithmetic here (no
// .scaleEffect) so drag-gesture math stays unambiguous.
private let BOARD_ZOOM_MIN = 0.5
private let BOARD_ZOOM_MAX = 1.5
private let BOARD_ZOOM_KEY = "familyAgent.boardZoom"

struct BoardView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: StickyNote?
    @State private var boardZoom: Double = {
        let saved = UserDefaults.standard.double(forKey: BOARD_ZOOM_KEY)
        return saved >= BOARD_ZOOM_MIN && saved <= BOARD_ZOOM_MAX ? saved : 1
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenScaffold(title: "Board", subtitle: "A corkboard of sticky notes. Drag to rearrange; tap to edit.", scrollable: false) {
                VStack(spacing: 14) {
                    HStack(spacing: 10) {
                        BrandSegmented(options: [("shared", "Shared"), ("private", "Mine")],
                                       selection: Binding(get: { model.noteScope }, set: { model.setNoteScope($0) }))
                        Spacer()
                        zoomControls
                        Button {
                            let n = model.notes.count
                            let cascade = 24 + Double(n % 6) * 24
                            model.addBlankNote(x: cascade, y: cascade) { editing = $0 }
                        } label: { Label("Add", systemImage: "plus") }
                        .buttonStyle(.ghost)
                    }

                    GeometryReader { geo in
                        let logicalSize = CGSize(width: geo.size.width / boardZoom, height: geo.size.height / boardZoom)
                        ZStack(alignment: .topLeading) {
                            RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous)
                                .fill(Theme.surface)
                                .overlay(RoundedRectangle(cornerRadius: Theme.R.lg, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
                                .elevation(Theme.E.card)

                            if model.notes.isEmpty {
                                Text("Nothing pinned up yet. Tap \u{201C}Add\u{201D}.")
                                    .appBodySmall().foregroundStyle(Theme.textMuted)
                                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                            }

                            ForEach(model.notes) { note in
                                DraggableNote(
                                    note: note,
                                    zoom: boardZoom,
                                    logicalBoardSize: logicalSize,
                                    onTap: { editing = note },
                                    onMove: { x, y in model.moveNote(note.id, x: x, y: y) },
                                    onDelete: { model.deleteNote(note.id) }
                                )
                            }
                        }
                        .clipped()
                    }
                }
            }
        }
        .task { await model.refreshNotes() }
        .sheet(item: $editing) { note in
            EditNoteSheet(note: note) { text, color in
                if text.isEmpty {
                    model.deleteNote(note.id)
                } else {
                    model.editNote(note.id, text: text != note.text ? text : nil,
                                   color: color != note.color ? color : nil)
                }
            } onCancel: {
                if note.text.isEmpty { model.deleteNote(note.id) }
            }
        }
    }

    private var zoomControls: some View {
        HStack(spacing: 2) {
            Button { setZoom(boardZoom - 0.1) } label: {
                Image(systemName: "minus").font(.system(size: 12, weight: .semibold))
                    .frame(width: 28, height: 28)
            }
            .disabled(boardZoom <= BOARD_ZOOM_MIN)
            Text("\(Int((boardZoom * 100).rounded()))%")
                .font(.inter(12, .medium)).foregroundStyle(Theme.textMuted)
                .frame(minWidth: 38)
            Button { setZoom(boardZoom + 0.1) } label: {
                Image(systemName: "plus").font(.system(size: 12, weight: .semibold))
                    .frame(width: 28, height: 28)
            }
            .disabled(boardZoom >= BOARD_ZOOM_MAX)
        }
        .padding(.horizontal, 4)
        .background(Theme.surfaceHigh, in: Capsule())
    }

    private func setZoom(_ z: Double) {
        boardZoom = min(BOARD_ZOOM_MAX, max(BOARD_ZOOM_MIN, (z * 10).rounded() / 10))
        UserDefaults.standard.set(boardZoom, forKey: BOARD_ZOOM_KEY)
    }
}

private struct DraggableNote: View {
    let note: StickyNote
    let zoom: Double
    let logicalBoardSize: CGSize
    let onTap: () -> Void
    let onMove: (Double, Double) -> Void
    let onDelete: () -> Void

    @State private var drag: CGSize = .zero
    @GestureState private var dragging = false

    private var tilt: Double {
        var h = 0
        for c in note.id.unicodeScalars { h = h &* 31 &+ Int(c.value) }
        return Double((h % 7) - 3) * 0.9
    }

    var body: some View {
        // note.x/note.y are logical (unzoomed) coordinates; the rendered
        // position and size are both scaled by `zoom` so the note visually
        // shrinks/grows without moving the board itself. Font/padding are
        // scaled too rather than using .scaleEffect, so the drag gesture's
        // reported translation (plain screen points) needs no un-transforming.
        let size = NOTE_SIZE * zoom
        VStack(alignment: .leading) {
            HStack {
                Spacer()
                Button { onDelete() } label: {
                    Image(systemName: "xmark").font(.system(size: 11 * zoom)).foregroundStyle(.black.opacity(0.5))
                }
            }
            Text(note.text.isEmpty ? "Tap to write…" : note.text)
                .font(.inter(13 * zoom))
                .foregroundStyle(note.text.isEmpty ? Color.black.opacity(0.4) : Color(hex: 0x33302A))
            Spacer()
        }
        .padding(12 * zoom)
        .frame(width: size, height: size, alignment: .topLeading)
        .background(Theme.noteColor(note.color))
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .rotationEffect(.degrees(dragging ? 0 : tilt))
        .shadow(color: .black.opacity(dragging ? 0.22 : 0.12), radius: dragging ? 12 : 4, y: 3)
        .offset(x: note.x * zoom + drag.width, y: note.y * zoom + drag.height)
        .gesture(
            DragGesture()
                .updating($dragging) { _, s, _ in s = true }
                .onChanged { drag = $0.translation }
                .onEnded { value in
                    let maxX = max(0, logicalBoardSize.width - NOTE_SIZE)
                    let maxY = max(0, logicalBoardSize.height - NOTE_SIZE)
                    let nx = min(max(0, note.x + value.translation.width / zoom), maxX)
                    let ny = min(max(0, note.y + value.translation.height / zoom), maxY)
                    drag = .zero
                    onMove(nx, ny)
                }
        )
        .onTapGesture { onTap() }
    }
}

private struct EditNoteSheet: View {
    @Environment(\.dismiss) private var dismiss
    let note: StickyNote
    let onSave: (String, String) -> Void
    let onCancel: () -> Void

    @State private var text = ""
    @State private var color = "butter"

    var body: some View {
        NavigationStack {
            Form {
                TextEditor(text: $text).frame(minHeight: 120)
                Section("Colour") {
                    HStack {
                        ForEach(Theme.noteNames, id: \.self) { name in
                            Circle()
                                .fill(Theme.noteColor(name))
                                .frame(width: 30, height: 30)
                                .overlay(name == color ? Image(systemName: "checkmark").font(.caption.bold()) : nil)
                                .onTapGesture { color = name }
                        }
                    }
                }
            }
            .navigationTitle(note.text.isEmpty ? "New note" : "Edit note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel(); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { onSave(text.trimmingCharacters(in: .whitespacesAndNewlines), color); dismiss() }
                }
            }
            .onAppear { text = note.text; color = note.color }
        }
    }
}
