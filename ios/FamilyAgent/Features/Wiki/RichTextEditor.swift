import SwiftUI
import UIKit

/// Drives one `UITextView`'s formatting from toolbar taps — Bold/Italic
/// toggle the current selection's font traits, heading/list actions rewrite
/// the current line. Every method ends by telling the text view's delegate
/// the text changed (mutating `.textStorage` directly doesn't trigger
/// `UITextViewDelegate` on its own) so the SwiftUI binding stays in sync.
@MainActor
@Observable
final class RichTextController {
    weak var textView: UITextView?

    private func notifyChanged() {
        guard let tv = textView else { return }
        tv.delegate?.textViewDidChange?(tv)
    }

    /// Bold/italic need an actual selection — there's no sensible "line" to
    /// apply a character trait to with just a caret.
    func toggleTrait(_ trait: UIFontDescriptor.SymbolicTraits) {
        guard let tv = textView else { return }
        let range = tv.selectedRange
        guard range.length > 0 else { return }
        let storage = tv.textStorage
        let currentlyOn = (storage.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont)?
            .fontDescriptor.symbolicTraits.contains(trait) ?? false
        storage.beginEditing()
        storage.enumerateAttribute(.font, in: range, options: []) { value, subrange, _ in
            let font = value as? UIFont ?? MarkdownRichText.bodyFont()
            var traits = font.fontDescriptor.symbolicTraits
            if currentlyOn { traits.remove(trait) } else { traits.insert(trait) }
            let descriptor = font.fontDescriptor.withSymbolicTraits(traits) ?? font.fontDescriptor
            storage.addAttribute(.font, value: UIFont(descriptor: descriptor, size: font.pointSize), range: subrange)
        }
        storage.endEditing()
        tv.selectedRange = range
        notifyChanged()
    }

    /// `level` 0 clears back to body text.
    func setHeading(_ level: Int) {
        guard let tv = textView else { return }
        let storage = tv.textStorage
        let ns = storage.string as NSString
        let lineRange = ns.lineRange(for: tv.selectedRange)
        guard lineRange.length > 0 else { return }
        let size: CGFloat = switch level {
        case 1: MarkdownRichText.h1Size
        case 2: MarkdownRichText.h2Size
        case 3: MarkdownRichText.h3Size
        default: MarkdownRichText.bodySize
        }
        storage.beginEditing()
        storage.enumerateAttribute(.font, in: lineRange, options: []) { value, subrange, _ in
            let font = value as? UIFont ?? MarkdownRichText.bodyFont()
            var traits = font.fontDescriptor.symbolicTraits
            if level > 0 { traits.insert(.traitBold) } else { traits.remove(.traitBold) }
            let descriptor = font.fontDescriptor.withSymbolicTraits(traits) ?? font.fontDescriptor
            storage.addAttribute(.font, value: UIFont(descriptor: descriptor, size: size), range: subrange)
        }
        storage.endEditing()
        tv.selectedRange = tv.selectedRange
        notifyChanged()
    }

    /// Toggles the current line's bullet/number prefix — a real, editable
    /// text prefix rather than a hidden paragraph attribute (see
    /// MarkdownRichText's file comment for why: it keeps the round-trip to
    /// Markdown simple at the cost of the bullet being just deletable text).
    func toggleList(bullet: Bool) {
        guard let tv = textView else { return }
        let storage = tv.textStorage
        let ns = storage.string as NSString
        let lineRange = ns.lineRange(for: tv.selectedRange)
        let lineStr = ns.substring(with: lineRange)
        let font = (lineRange.length > 0 ? storage.attribute(.font, at: lineRange.location, effectiveRange: nil) as? UIFont : nil) ?? MarkdownRichText.bodyFont()
        storage.beginEditing()
        if lineStr.hasPrefix("•  ") {
            storage.deleteCharacters(in: NSRange(location: lineRange.location, length: 3))
        } else if let m = lineStr.range(of: #"^\d+\.\s+"#, options: .regularExpression) {
            storage.deleteCharacters(in: NSRange(location: lineRange.location, length: (String(lineStr[m]) as NSString).length))
        } else if bullet {
            storage.insert(NSAttributedString(string: "•  ", attributes: [.font: font]), at: lineRange.location)
        } else {
            storage.insert(NSAttributedString(string: "1.  ", attributes: [.font: font]), at: lineRange.location)
        }
        storage.endEditing()
        notifyChanged()
    }

    /// The current selection's text, plus a little surrounding context to
    /// disambiguate a repeated phrase — the same anchor shape a comment
    /// thread uses on the artifact viewer. `nil` selection (just a caret,
    /// or none) means "comment on the whole page" to the caller.
    func currentSelectionQuote() -> (quote: String, prefix: String, suffix: String)? {
        guard let tv = textView, tv.selectedRange.length > 0 else { return nil }
        let ns = tv.text as NSString
        let range = tv.selectedRange
        let quote = ns.substring(with: range)
        let prefixStart = max(0, range.location - 48)
        let prefix = ns.substring(with: NSRange(location: prefixStart, length: range.location - prefixStart))
        let suffixEnd = min(ns.length, range.location + range.length + 48)
        let suffix = ns.substring(with: NSRange(location: range.location + range.length, length: suffixEnd - (range.location + range.length)))
        return (quote, prefix, suffix)
    }
}

/// A `UITextView` bound to an `NSAttributedString`, formatted by
/// [RichTextController] rather than a markdown syntax the user types. The
/// wiki editor's storage is still plain Markdown text — `MarkdownRichText`
/// converts at the load/save boundary (see `WikiPageEditorView`).
struct RichTextEditor: UIViewRepresentable {
    @Binding var attributedText: NSAttributedString
    var controller: RichTextController

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.attributedText = attributedText
        tv.font = MarkdownRichText.bodyFont()
        tv.isEditable = true
        tv.isScrollEnabled = true
        tv.backgroundColor = .clear
        tv.textContainerInset = UIEdgeInsets(top: 10, left: 6, bottom: 10, right: 6)
        tv.delegate = context.coordinator
        controller.textView = tv
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        // Only push an external change in (e.g. the page just loaded) — a
        // change originating from typing/formatting already lives in the
        // text view and re-assigning `attributedText` mid-edit would reset
        // the cursor.
        if !context.coordinator.isEditingInternally && tv.attributedText != attributedText {
            tv.attributedText = attributedText
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $attributedText) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<NSAttributedString>
        var isEditingInternally = false
        init(text: Binding<NSAttributedString>) { self.text = text }
        func textViewDidChange(_ textView: UITextView) {
            isEditingInternally = true
            text.wrappedValue = textView.attributedText
            isEditingInternally = false
        }
    }
}

/// Bold / Italic / heading / list buttons above the editor — a small,
/// fixed toolbar (no rich "insert link" flow; see MarkdownRichText's file
/// comment for the supported subset).
struct RichTextToolbar: View {
    let controller: RichTextController

    var body: some View {
        HStack(spacing: 18) {
            Button { controller.setHeading(1) } label: { Text("H1").font(.inter(14, .bold)) }
            Button { controller.setHeading(2) } label: { Text("H2").font(.inter(14, .bold)) }
            Button { controller.setHeading(0) } label: { Image(systemName: "paragraphsign") }
            Divider().frame(height: 16)
            Button { controller.toggleTrait(.traitBold) } label: { Image(systemName: "bold") }
            Button { controller.toggleTrait(.traitItalic) } label: { Image(systemName: "italic") }
            Divider().frame(height: 16)
            Button { controller.toggleList(bullet: true) } label: { Image(systemName: "list.bullet") }
            Button { controller.toggleList(bullet: false) } label: { Image(systemName: "list.number") }
        }
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Theme.accentInk)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
    }
}
