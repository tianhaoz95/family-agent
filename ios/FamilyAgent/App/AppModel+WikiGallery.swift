import Foundation

extension AppModel {
    // MARK: Family wiki (see docs/DECISIONS.md → "Family wiki")

    func refreshWikiPages() async {
        if let pages = await perform({ try await api.listWikiPages() }) { wikiPages = pages }
    }

    func createWikiPage(title: String, then opened: @escaping (WikiPage) -> Void) {
        Task {
            if let page = await perform({ try await api.createWikiPage(title: title) }) {
                await refreshWikiPages()
                opened(page)
            }
        }
    }

    func saveWikiPage(_ id: String, title: String, body: String, then done: @escaping (WikiPage?) -> Void) {
        Task {
            let page = await perform { try await api.updateWikiPage(id, title: title, body: body) }
            if page != nil { await refreshWikiPages() }
            done(page)
        }
    }

    func revertWikiPage(_ id: String, then done: @escaping (WikiPage?) -> Void) {
        Task {
            let page = await perform { try await api.revertWikiPage(id) }
            if page != nil { await refreshWikiPages() }
            done(page)
        }
    }

    func deleteWikiPage(_ id: String, then done: @escaping () -> Void) {
        Task {
            _ = await perform { try await api.deleteWikiPage(id) }
            await refreshWikiPages()
            done()
        }
    }

    // MARK: Gallery (see docs/DECISIONS.md → "Family gallery")

    func refreshGallery() async {
        if let photos = await perform({ try await api.listGalleryPhotos(scope: galleryScope) }) { galleryPhotos = photos }
    }

    func setGalleryScope(_ scope: String) {
        galleryScope = scope
        Task { await refreshGallery() }
    }

    /// `image`/`thumb` are already downscaled to their own target sizes by
    /// the caller (`ImageAttach.scaledJpegDataURI`, two different `maxPixel`
    /// values) — no server-side processing at all. See docs/DECISIONS.md →
    /// "Family gallery".
    func uploadGalleryPhoto(image: String, thumb: String) {
        Task {
            galleryUploading = true
            _ = await perform { try await api.createGalleryPhoto(scope: galleryScope, image: image, thumb: thumb) }
            galleryUploading = false
            await refreshGallery()
        }
    }

    func saveGalleryCaption(_ id: String, caption: String?, then done: @escaping (GalleryPhoto?) -> Void) {
        Task {
            let photo = await perform { try await api.updateGalleryPhotoCaption(id, caption: caption) }
            if photo != nil { await refreshGallery() }
            done(photo)
        }
    }

    func deleteGalleryPhoto(_ id: String, then done: @escaping () -> Void) {
        Task {
            _ = await perform { try await api.deleteGalleryPhoto(id) }
            await refreshGallery()
            done()
        }
    }
}
