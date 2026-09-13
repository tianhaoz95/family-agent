package app.familyagent.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * A Markdown-native rich text editor for the wiki — the stored (and
 * cross-platform) format is plain Markdown text, always; formatting is
 * applied by a toolbar that inserts/removes real Markdown syntax
 * characters ("**", "#", "- ") around the selection or current line,
 * exactly like the raw text a family member could have typed by hand.
 * [VisualTransformation] then displays that same text styled (headings
 * bigger and bold, bold/italic/code/link spans rendered as such) —
 * a pure function of the current text, recomputed fresh every
 * recomposition, so there is no separate "style state" that can ever
 * drift from what's actually stored or get lost across a keystroke.
 *
 * This shape is deliberate, not incidental: an earlier version of this
 * file kept a persistent, per-character [androidx.compose.ui.text.SpanStyle]
 * buffer alongside the text (mirroring the iOS/desktop editors, which use a
 * real mutable rich-text control — `UITextView` / `contenteditable` — that
 * Compose has no equivalent of). That buffer was reliably wiped by the next
 * real keystroke — confirmed on a live device, not assumed — because
 * `BasicTextField(value: TextFieldValue, onValueChange)` reconstructs its
 * `AnnotatedString` from its own plain-text `EditingBuffer` on every IME
 * edit, discarding externally-applied spans. Styling as a read-only
 * transform of the Markdown text itself has no such state to lose. The
 * visible cost — a heading's "# " and bold's "**" stay on screen rather
 * than hiding — is the honest trade for that robustness on this platform;
 * see docs/DECISIONS.md → "Family wiki".
 */
object MarkdownRichText {
    val h1Size = 24.sp
    val h2Size = 21.sp
    val h3Size = 18.sp

    private val INLINE = Regex(
        "(\\*\\*\\*(.+?)\\*\\*\\*)|(\\*\\*(.+?)\\*\\*)|(\\*(.+?)\\*)|(`(.+?)`)|(\\[(.+?)]\\((.+?)\\))"
    )
    private val NUMBERED_PREFIX = Regex("^\\d+\\.\\s+")

    fun visualTransformation(): VisualTransformation = VisualTransformation { text ->
        TransformedText(toDisplayAnnotated(text.text), OffsetMapping.Identity)
    }

    private fun toDisplayAnnotated(markdown: String): AnnotatedString = buildAnnotatedString {
        val lines = markdown.split("\n")
        for ((i, line) in lines.withIndex()) {
            appendDisplayLine(this, line)
            if (i < lines.size - 1) append("\n")
        }
    }

    private fun appendDisplayLine(b: AnnotatedString.Builder, line: String) {
        val headSize: TextUnit? = when {
            line.startsWith("### ") -> h3Size
            line.startsWith("## ") -> h2Size
            line.startsWith("# ") -> h1Size
            else -> null
        }
        if (headSize != null) {
            b.withStyle(androidx.compose.ui.text.SpanStyle(fontSize = headSize, fontWeight = FontWeight.Bold)) {
                appendInlineDisplay(this, line)
            }
        } else {
            appendInlineDisplay(b, line)
        }
    }

    private fun appendInlineDisplay(b: AnnotatedString.Builder, text: String) {
        var last = 0
        for (m in INLINE.findAll(text)) {
            if (m.range.first > last) b.append(text.substring(last, m.range.first))
            val style = when {
                m.groupValues[2].isNotEmpty() -> androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold, fontStyle = FontStyle.Italic)
                m.groupValues[4].isNotEmpty() -> androidx.compose.ui.text.SpanStyle(fontWeight = FontWeight.Bold)
                m.groupValues[6].isNotEmpty() -> androidx.compose.ui.text.SpanStyle(fontStyle = FontStyle.Italic)
                m.groupValues[8].isNotEmpty() -> androidx.compose.ui.text.SpanStyle(fontFamily = FontFamily.Monospace, background = Color(0x14000000))
                m.groupValues[10].isNotEmpty() -> androidx.compose.ui.text.SpanStyle(color = Color(0xFF0075DE), textDecoration = TextDecoration.Underline)
                else -> androidx.compose.ui.text.SpanStyle()
            }
            b.withStyle(style) { append(m.value) }
            last = m.range.last + 1
        }
        if (last < text.length) b.append(text.substring(last))
    }
}

/** Drives one [TextFieldValue]'s Markdown from toolbar taps — Bold/Italic
 *  wrap the selection in "**"/"*", heading/list actions rewrite the
 *  current line's leading syntax. The field's stored text is already
 *  exactly the page's Markdown body; no conversion step on save/load. */
class RichTextController(initial: String) {
    var value by mutableStateOf(TextFieldValue(initial, TextRange(initial.length)))
        private set

    fun onValueChange(new: TextFieldValue) {
        value = new
    }

    fun setMarkdown(markdown: String) {
        value = TextFieldValue(markdown, TextRange(markdown.length))
    }

    fun currentMarkdown(): String = value.text

    private fun currentLineBounds(): Pair<Int, Int> {
        val text = value.text
        val cursor = value.selection.start.coerceIn(0, text.length)
        var start = cursor
        while (start > 0 && text[start - 1] != '\n') start--
        var end = cursor
        while (end < text.length && text[end] != '\n') end++
        return start to end
    }

    fun toggleTrait(bold: Boolean) {
        val sel = value.selection
        if (sel.collapsed) return
        val text = value.text
        val start = minOf(sel.start, sel.end)
        val end = maxOf(sel.start, sel.end)
        val marker = if (bold) "**" else "*"
        val selected = text.substring(start, end)
        val before = text.substring(0, start)
        val after = text.substring(end)
        val wrapped = before.endsWith(marker) && after.startsWith(marker)
        val newText: String
        val newStart: Int
        val newEnd: Int
        if (wrapped) {
            newText = before.removeSuffix(marker) + selected + after.removePrefix(marker)
            newStart = start - marker.length
            newEnd = end - marker.length
        } else {
            newText = before + marker + selected + marker + after
            newStart = start + marker.length
            newEnd = end + marker.length
        }
        value = TextFieldValue(newText, TextRange(newStart, newEnd))
    }

    fun setHeading(level: Int) {
        val (start, end) = currentLineBounds()
        val text = value.text
        val line = text.substring(start, end)
        val stripped = line.replaceFirst(Regex("^#{1,3}\\s+"), "")
        val newLine = when (level) {
            1 -> "# $stripped"
            2 -> "## $stripped"
            3 -> "### $stripped"
            else -> stripped
        }
        val newText = text.substring(0, start) + newLine + text.substring(end)
        val delta = newLine.length - line.length
        value = TextFieldValue(newText, TextRange((value.selection.start + delta).coerceIn(0, newText.length)))
    }

    fun toggleList(bullet: Boolean) {
        val (start, end) = currentLineBounds()
        val text = value.text
        val line = text.substring(start, end)
        val newLine = when {
            line.startsWith("- ") || line.startsWith("* ") -> line.substring(2)
            MarkdownRichText.run { Regex("^\\d+\\.\\s+") }.containsMatchIn(line) ->
                line.replaceFirst(Regex("^\\d+\\.\\s+"), "")
            bullet -> "- $line"
            else -> "1. $line"
        }
        val newText = text.substring(0, start) + newLine + text.substring(end)
        val delta = newLine.length - line.length
        value = TextFieldValue(newText, TextRange((value.selection.start + delta).coerceIn(0, newText.length)))
    }
}

/** Bold / Italic / heading / list buttons above the editor — horizontally
 *  scrollable since it doesn't fit a phone width at once. */
@Composable
fun RichTextToolbar(controller: RichTextController) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 4.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        RichTextToolbarButton("H1") { controller.setHeading(1) }
        RichTextToolbarButton("H2") { controller.setHeading(2) }
        RichTextToolbarButton("¶") { controller.setHeading(0) }
        Box(Modifier.height(18.dp).width(1.dp).background(MaterialTheme.colorScheme.outlineVariant))
        RichTextToolbarButton("B", bold = true) { controller.toggleTrait(bold = true) }
        RichTextToolbarButton("I", italic = true) { controller.toggleTrait(bold = false) }
        Box(Modifier.height(18.dp).width(1.dp).background(MaterialTheme.colorScheme.outlineVariant))
        RichTextToolbarButton("•") { controller.toggleList(bullet = true) }
        RichTextToolbarButton("1.") { controller.toggleList(bullet = false) }
    }
}

@Composable
private fun RichTextToolbarButton(label: String, bold: Boolean = false, italic: Boolean = false, onClick: () -> Unit) {
    TextButton(onClick = onClick, contentPadding = PaddingValues(horizontal = 8.dp)) {
        Text(
            label,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.SemiBold,
            fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
        )
    }
}

@Composable
fun RichTextEditor(controller: RichTextController, modifier: Modifier = Modifier) {
    BasicTextField(
        value = controller.value,
        onValueChange = controller::onValueChange,
        modifier = modifier,
        textStyle = MaterialTheme.typography.bodyMedium.copy(color = LocalContentColor.current),
        visualTransformation = MarkdownRichText.visualTransformation(),
    )
}
