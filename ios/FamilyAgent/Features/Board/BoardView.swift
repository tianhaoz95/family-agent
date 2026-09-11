import SwiftUI

private let NOTE_SIZE: CGFloat = 148

struct BoardView: View {
    @Environment(AppModel.self) private var model
    @State private var editing: StickyNote?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScreenScaffold(title: "Board", subtitle: "A corkboard of sticky notes. Drag to rearrange; tap to edit.", scrollable: false) {
                VStack(spacing: 14) {
                    HStack(spacing: 10) {
                        BrandSegmented(options: [("shared", "Shared"), ("private", "Mine")],
                                       selection: Binding(get: { model.noteScope }, set: { model.setNoteScope($0) }))
                        Button {
                            let n = model.notes.count
                            let cascade = 24 + Double(n % 6) * 24
                            model.addBlankNote(x: cascade, y: cascade) { editing = $0 }
                        } label: { Label("Add", systemImage: "plus") }
                        .buttonStyle(.ghost)
                    }

                    GeometryReader { geo in
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
                                    boardSize: geo.size,
                                    onTap: { editing = note },
                                    onMove: { x, y in model.moveNote(note.id, x: x, y: y) },
                                    onDelete: { model.deleteNote(note.id) }
                                )
                            }
                        }
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
}

private struct DraggableNote: View {
    let note: StickyNote
    let boardSize: CGSize
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
        let base = CGPoint(x: note.x, y: note.y)
        VStack(alignment: .leading) {
            HStack {
                Spacer()
                Button { onDelete() } label: {
                    Image(systemName: "xmark").font(.system(size: 11)).foregroundStyle(.black.opacity(0.5))
                }
            }
            Text(note.text.isEmpty ? "Tap to write…" : note.text)
                .font(.inter(13))
                .foregroundStyle(note.text.isEmpty ? Color.black.opacity(0.4) : Color(hex: 0x33302A))
            Spacer()
        }
        .padding(12)
        .frame(width: NOTE_SIZE, height: NOTE_SIZE, alignment: .topLeading)
        .background(Theme.noteColor(note.color))
        .clipShape(RoundedRectangle(cornerRadius: 3))
        .rotationEffect(.degrees(dragging ? 0 : tilt))
        .shadow(color: .black.opacity(dragging ? 0.22 : 0.12), radius: dragging ? 12 : 4, y: 3)
        .offset(x: base.x + drag.width, y: base.y + drag.height)
        .gesture(
            DragGesture()
                .updating($dragging) { _, s, _ in s = true }
                .onChanged { drag = $0.translation }
                .onEnded { value in
                    let maxX = max(0, boardSize.width - NOTE_SIZE)
                    let maxY = max(0, boardSize.height - NOTE_SIZE)
                    let nx = min(max(0, note.x + value.translation.width), maxX)
                    let ny = min(max(0, note.y + value.translation.height), maxY)
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
