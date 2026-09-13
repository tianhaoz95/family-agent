import UIKit

/// Bidirectional markdown ⇄ rich text for the wiki editor. The wiki stores
/// (and every other client renders) plain Markdown — this is the one place
/// that turns it into something a person can format by tapping "Bold"
/// instead of typing "**", and back again on save. Deliberately a small,
/// line-oriented subset (paragraphs, # / ## / ### headings, **bold**,
/// *italic*, `code`, [text](url) links, "- " / "1. " lists) — a family wiki
/// doesn't need tables, blockquotes, or nested lists, and a hand-rolled
/// subset keeps this a few hundred lines instead of embedding a CommonMark
/// engine. See docs/DECISIONS.md → "Family wiki".
enum MarkdownRichText {
    // Custom trait carried on a paragraph's first character, read back at
    // serialization time — headings are realized as real font size/weight so
    // they simply *look* like headings while typing, not a hidden attribute.
    static let h1Size: CGFloat = 26
    static let h2Size: CGFloat = 22
    static let h3Size: CGFloat = 19
    static let bodySize: CGFloat = 16

    static func bodyFont() -> UIFont { .systemFont(ofSize: bodySize) }

    // MARK: Markdown -> rich text

    static func toAttributed(_ markdown: String) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let lines = markdown.components(separatedBy: "\n")
        for (i, rawLine) in lines.enumerated() {
            result.append(lineToAttributed(rawLine))
            if i < lines.count - 1 { result.append(NSAttributedString(string: "\n", attributes: [.font: bodyFont()])) }
        }
        if result.length == 0 { result.append(NSAttributedString(string: "", attributes: [.font: bodyFont()])) }
        return result
    }

    private static func lineToAttributed(_ line: String) -> NSAttributedString {
        var text = line
        var prefixFont: UIFont = bodyFont()
        var prefix = ""

        if text.hasPrefix("### ") { text.removeFirst(4); prefixFont = .boldSystemFont(ofSize: h3Size) }
        else if text.hasPrefix("## ") { text.removeFirst(3); prefixFont = .boldSystemFont(ofSize: h2Size) }
        else if text.hasPrefix("# ") { text.removeFirst(2); prefixFont = .boldSystemFont(ofSize: h1Size) }
        else if text.hasPrefix("- ") || text.hasPrefix("* ") { text.removeFirst(2); prefix = "•  " }
        else if let m = text.range(of: #"^\d+\.\s"#, options: .regularExpression) {
            prefix = String(text[m]).replacingOccurrences(of: #"^(\d+)\.\s"#, with: "$1.  ", options: .regularExpression)
            text.removeSubrange(m)
        }

        let inline = inlineToAttributed(text, baseFont: prefixFont)
        guard !prefix.isEmpty else { return inline }
        let withPrefix = NSMutableAttributedString(string: prefix, attributes: [.font: prefixFont])
        withPrefix.append(inline)
        return withPrefix
    }

    /// Bold/italic/code/links within one line — Apple's own inline-markdown
    /// parser does the heavy lifting (bold/italic/code/strikethrough/links
    /// are all part of its supported subset), so this app hand-rolls none of
    /// that; it only widens headings/lists on top, and only when parsing
    /// fails (bad syntax) does the line fall back to plain text.
    private static func inlineToAttributed(_ text: String, baseFont: UIFont) -> NSAttributedString {
        guard !text.isEmpty else { return NSAttributedString(string: "", attributes: [.font: baseFont]) }
        guard let parsed = try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else {
            return NSAttributedString(string: text, attributes: [.font: baseFont])
        }
        let ns = NSMutableAttributedString(attributedString: NSAttributedString(parsed))
        let full = NSRange(location: 0, length: ns.length)
        // Apple's parser leaves `.font` unset for plain runs and sets an
        // inline-markdown-flavored one (system default, not ours) for
        // bold/italic/code — rebuild each run's font from our base + its
        // symbolic traits so headings/list text stay the right size.
        ns.enumerateAttribute(.font, in: full, options: []) { value, range, _ in
            let traits = (value as? UIFont)?.fontDescriptor.symbolicTraits ?? []
            var descriptor = baseFont.fontDescriptor
            if !traits.isDisjoint(with: .traitBold) { descriptor = descriptor.withSymbolicTraits(descriptor.symbolicTraits.union(.traitBold)) ?? descriptor }
            if !traits.isDisjoint(with: .traitItalic) { descriptor = descriptor.withSymbolicTraits(descriptor.symbolicTraits.union(.traitItalic)) ?? descriptor }
            if !traits.isDisjoint(with: .traitMonoSpace) {
                ns.addAttribute(.font, value: UIFont.monospacedSystemFont(ofSize: baseFont.pointSize, weight: .regular), range: range)
                ns.addAttribute(.backgroundColor, value: UIColor.secondarySystemBackground, range: range)
                return
            }
            ns.addAttribute(.font, value: UIFont(descriptor: descriptor, size: baseFont.pointSize), range: range)
        }
        return ns
    }

    // MARK: Rich text -> markdown

    static func toMarkdown(_ attributed: NSAttributedString) -> String {
        let plain = attributed.string
        var out: [String] = []
        var loc = 0
        for piece in plain.components(separatedBy: "\n") {
            let len = (piece as NSString).length
            let range = NSRange(location: loc, length: len)
            out.append(lineToMarkdown(attributed.attributedSubstring(from: range)))
            loc += len + 1
        }
        return out.joined(separator: "\n")
    }

    private static func lineToMarkdown(_ line: NSAttributedString) -> String {
        guard line.length > 0 else { return "" }
        let firstFont = line.attribute(.font, at: 0, effectiveRange: nil) as? UIFont ?? bodyFont()
        let str = line.string

        // A heading's bold is implied by "#"/"##"/"###" — strip the trait
        // `setHeading` forced on before inline-serializing, or every heading
        // would come back doubly (and redundantly) wrapped in "**…**".
        if firstFont.pointSize >= h1Size - 1 && firstFont.fontDescriptor.symbolicTraits.contains(.traitBold) {
            return "# " + inlineToMarkdown(strippingBold(line))
        }
        if firstFont.pointSize >= h2Size - 1 && firstFont.fontDescriptor.symbolicTraits.contains(.traitBold) {
            return "## " + inlineToMarkdown(strippingBold(line))
        }
        if firstFont.pointSize >= h3Size - 1 && firstFont.fontDescriptor.symbolicTraits.contains(.traitBold) {
            return "### " + inlineToMarkdown(strippingBold(line))
        }
        if str.hasPrefix("•") {
            let rest = str.drop(while: { $0 == "•" || $0 == " " })
            let stripped = line.attributedSubstring(from: NSRange(location: str.distance(from: str.startIndex, to: rest.startIndex), length: (rest as NSString).length))
            return "- " + inlineToMarkdown(stripped)
        }
        if let m = str.range(of: #"^\d+\.\s+"#, options: .regularExpression) {
            let numberPart = str[m].trimmingCharacters(in: .whitespaces)
            let restStart = str.distance(from: str.startIndex, to: m.upperBound)
            let stripped = line.attributedSubstring(from: NSRange(location: restStart, length: (str as NSString).length - restStart))
            return numberPart + " " + inlineToMarkdown(stripped)
        }
        return inlineToMarkdown(line)
    }

    private static func strippingBold(_ line: NSAttributedString) -> NSAttributedString {
        let mutable = NSMutableAttributedString(attributedString: line)
        mutable.enumerateAttribute(.font, in: NSRange(location: 0, length: mutable.length), options: []) { value, range, _ in
            guard let font = value as? UIFont else { return }
            let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.subtracting(.traitBold)) ?? font.fontDescriptor
            mutable.addAttribute(.font, value: UIFont(descriptor: descriptor, size: font.pointSize), range: range)
        }
        return mutable
    }

    private static func inlineToMarkdown(_ run: NSAttributedString) -> String {
        guard run.length > 0 else { return "" }
        var out = ""
        run.enumerateAttributes(in: NSRange(location: 0, length: run.length), options: []) { attrs, range, _ in
            var piece = (run.string as NSString).substring(with: range)
            guard !piece.isEmpty else { return }
            let font = attrs[.font] as? UIFont
            let traits = font?.fontDescriptor.symbolicTraits ?? []
            if traits.contains(.traitMonoSpace) {
                out += "`\(piece)`"
                return
            }
            if let link = attrs[.link] {
                let url = (link as? URL)?.absoluteString ?? "\(link)"
                out += "[\(piece)](\(url))"
                return
            }
            let bold = traits.contains(.traitBold)
            let italic = traits.contains(.traitItalic)
            if bold && italic { piece = "***\(piece)***" }
            else if bold { piece = "**\(piece)**" }
            else if italic { piece = "*\(piece)*" }
            out += piece
        }
        return out
    }
}
