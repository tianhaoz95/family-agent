import SwiftUI
import PDFKit

/// Renders a PDF from raw bytes — replaces Android's manual `PdfRenderer` bitmap
/// loop with PDFKit.
struct PDFPreview: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.displayDirection = .vertical
        v.backgroundColor = .clear
        v.document = PDFDocument(data: data)
        return v
    }
    func updateUIView(_ v: PDFView, context: Context) {
        if v.document == nil { v.document = PDFDocument(data: data) }
    }
}
