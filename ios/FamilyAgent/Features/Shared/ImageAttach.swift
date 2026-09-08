import SwiftUI
import UIKit
import ImageIO
import UniformTypeIdentifiers

enum ImageAttach {
    /// Downscale to a 1536px long edge and JPEG-encode as a data URI — matches
    /// `android/.../ui/ImageAttach.kt`.
    static func scaledJpegDataURI(_ data: Data, maxPixel: CGFloat = 1536, quality: CGFloat = 0.85) -> String? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let ui = UIImage(cgImage: cg)
        guard let jpeg = ui.jpegData(compressionQuality: quality) else { return nil }
        return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
    }

    static func image(fromDataURI uri: String) -> UIImage? {
        guard let comma = uri.firstIndex(of: ","),
              let data = Data(base64Encoded: String(uri[uri.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}

/// A horizontal tray of attached-image thumbnails with a remove button.
struct ImageTray: View {
    @Binding var images: [String]
    var body: some View {
        if !images.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(images.indices, id: \.self) { i in
                        if let ui = ImageAttach.image(fromDataURI: images[i]) {
                            Image(uiImage: ui)
                                .resizable().scaledToFill()
                                .frame(width: 52, height: 52)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .overlay(alignment: .topTrailing) {
                                    Button { images.remove(at: i) } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .foregroundStyle(.white, .black.opacity(0.5))
                                    }
                                }
                        }
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }
}
