import SwiftUI
import PhotosUI

/// A family photo gallery, distinct from Documents (a searchable file list —
/// the wrong UX for browsing photos) and the sticky Board (a handful of
/// pinned photos, not a scrollable library). Private-vs-shared mirrors the
/// Board exactly. See docs/DECISIONS.md → "Family gallery".
struct GalleryView: View {
    @Environment(AppModel.self) private var model
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var viewing: GalleryPhoto?

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 8)]

    var body: some View {
        ScreenScaffold(title: "Gallery", subtitle: "Photos for the whole family, or just for you.") {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Picker("", selection: Binding(get: { model.galleryScope }, set: { model.setGalleryScope($0) })) {
                        Text("Shared").tag("shared")
                        Text("Mine").tag("private")
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: 220)
                    Spacer()
                    PhotosPicker(selection: $photoItems, matching: .images) {
                        Label("Add", systemImage: "plus")
                    }
                    .buttonStyle(.soft)
                }

                if model.galleryUploading {
                    HStack(spacing: 8) { ProgressView(); Text("Uploading\u{2026}").appBodySmall().foregroundStyle(Theme.textMuted) }
                }

                if model.galleryPhotos.isEmpty && !model.galleryUploading {
                    EmptyState(text: "No photos yet. Add one above.", systemImage: "photo.stack")
                } else {
                    LazyVGrid(columns: columns, spacing: 8) {
                        ForEach(model.galleryPhotos) { photo in
                            Button { viewing = photo } label: {
                                if let ui = ImageAttach.image(fromDataURI: photo.thumb) {
                                    Image(uiImage: ui)
                                        .resizable().scaledToFill()
                                        .frame(width: 110, height: 110)
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .fullScreenCover(item: $viewing) { photo in
            GalleryPhotoViewer(photoId: photo.id) { viewing = nil }
        }
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                    guard let display = ImageAttach.scaledJpegDataURI(data, maxPixel: 1600),
                          let thumb = ImageAttach.scaledJpegDataURI(data, maxPixel: 360, quality: 0.75) else { continue }
                    model.uploadGalleryPhoto(image: display, thumb: thumb)
                }
                photoItems = []
            }
        }
        .task { await model.refreshGallery() }
        .refreshable { await model.refreshGallery() }
    }
}

/// Fetches the full-size image on open (the grid only ever holds the
/// thumbnail) — same "list is light, one item is heavy" shape as the wiki
/// page editor re-fetching its own fresh copy. Chrome mirrors the system
/// Photos viewer: an inline nav bar (back chevron, the date as the title,
/// an overflow menu for delete) plus a native bottom toolbar (share, a
/// caption toggle) rather than a custom full-screen overlay.
struct GalleryPhotoViewer: View {
    let photoId: String
    var onClose: () -> Void
    @Environment(AppModel.self) private var model
    @State private var photo: GalleryPhoto?
    @State private var caption = ""
    @State private var editingCaption = false
    @State private var showDeleteConfirm = false
    @FocusState private var captionFocused: Bool

    private var titleText: String {
        // Server sends fractional-second ISO 8601 ("…08:43:56.342Z"); the
        // plain ISO8601DateFormatter() rejects that and returns nil, so the
        // fractional-seconds formatter has to be tried first (same fallback
        // ArtifactsView / Calendar+.swift's `friendlyTimestamp` already use).
        let fractional = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
        guard let photo, let date = fractional.date(from: photo.createdAt) ?? ISO8601DateFormatter().date(from: photo.createdAt) else { return "Photo" }
        let df = DateFormatter()
        if Calendar.current.isDateInToday(date) { df.dateFormat = "'Today,' h:mm a" }
        else if Calendar.current.isDateInYesterday(date) { df.dateFormat = "'Yesterday,' h:mm a" }
        else { df.dateFormat = "MMM d, yyyy" }
        return df.string(from: date)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let photo, let ui = ImageAttach.image(fromDataURI: photo.image) {
                    Image(uiImage: ui)
                        .resizable().scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Theme.canvas)
            .navigationTitle(titleText)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { onClose() } label: { Image(systemName: "chevron.left") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(role: .destructive) { showDeleteConfirm = true } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
                ToolbarItemGroup(placement: .bottomBar) {
                    if let photo, let ui = ImageAttach.image(fromDataURI: photo.image) {
                        ShareLink(item: Image(uiImage: ui), preview: SharePreview(photo.caption?.isEmpty == false ? photo.caption! : "Photo", image: Image(uiImage: ui))) {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                    Spacer()
                    Button {
                        editingCaption.toggle()
                        captionFocused = editingCaption
                    } label: {
                        Image(systemName: (photo?.caption?.isEmpty == false) ? "text.bubble.fill" : "text.bubble")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if editingCaption {
                    HStack(spacing: 8) {
                        TextField("Add a caption\u{2026}", text: $caption)
                            .focused($captionFocused)
                            .textFieldStyle(.plain)
                            .padding(10)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .onSubmit { saveCaption() }
                        Button("Save") { saveCaption() }.buttonStyle(.primary)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                } else if let c = photo?.caption, !c.isEmpty {
                    Text(c)
                        .appBodySmall()
                        .foregroundStyle(Theme.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }
            }
        }
        .alert("Delete this photo?", isPresented: $showDeleteConfirm) {
            Button("Delete", role: .destructive) { model.deleteGalleryPhoto(photoId) { onClose() } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("This can't be undone.") }
        .task {
            if let p = await model.perform({ try await model.api.getGalleryPhoto(photoId) }) {
                photo = p
                caption = p.caption ?? ""
            }
        }
    }

    private func saveCaption() {
        model.saveGalleryCaption(photoId, caption: caption.isEmpty ? nil : caption) { updated in
            if let updated { photo = updated }
        }
        editingCaption = false
    }
}
