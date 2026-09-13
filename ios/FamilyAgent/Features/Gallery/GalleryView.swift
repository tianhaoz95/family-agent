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
/// page editor re-fetching its own fresh copy.
struct GalleryPhotoViewer: View {
    let photoId: String
    var onClose: () -> Void
    @Environment(AppModel.self) private var model
    @State private var photo: GalleryPhoto?
    @State private var caption = ""
    @State private var showDeleteConfirm = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 16) {
                Spacer()
                if let photo, let ui = ImageAttach.image(fromDataURI: photo.image) {
                    Image(uiImage: ui).resizable().scaledToFit().frame(maxHeight: 500)
                } else {
                    ProgressView().tint(.white)
                }
                Spacer()
                HStack(spacing: 8) {
                    TextField("Add a caption\u{2026}", text: $caption)
                        .textFieldStyle(.roundedBorder)
                    Button("Save") {
                        model.saveGalleryCaption(photoId, caption: caption.isEmpty ? nil : caption) { updated in
                            if let updated { photo = updated }
                        }
                    }
                    .buttonStyle(.soft)
                    Button("Delete", role: .destructive) { showDeleteConfirm = true }
                        .buttonStyle(.soft)
                }
                .padding(.horizontal, 20)
                Button("Close") { onClose() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .padding(.bottom, 20)
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
}
