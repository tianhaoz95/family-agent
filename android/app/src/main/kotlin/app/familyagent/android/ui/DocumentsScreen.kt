package app.familyagent.android.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CameraAlt
import androidx.compose.material.icons.rounded.UploadFile
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.DriveFileRenameOutline
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.familyagent.android.data.Document
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private data class DocRow(
    val id: String,
    val filename: String,
    val category: String?,
    val summary: String?,
    val extractionStatus: String,
    val snippet: String? = null,
)

private val SEARCH_MODES = listOf(
    "hybrid" to "Smart",
    "keyword" to "Exact",
    "fuzzy" to "Fuzzy",
    "semantic" to "Meaning",
)

@Composable
fun DocumentsScreen(
    documents: List<Document>,
    uploadStatus: String?,
    searchQuery: String,
    searchMode: String,
    searchResults: List<app.familyagent.android.data.DocumentSearchHit>?,
    searching: Boolean,
    semanticEnabled: Boolean,
    onSearchChange: (query: String, mode: String) -> Unit,
    onIngest: (filename: String, text: String) -> Unit,
    onUpload: (filename: String, bytes: ByteArray, mimeType: String?) -> Unit,
    onDelete: (id: String) -> Unit,
    onRetry: (id: String) -> Unit,
    onPreview: (id: String) -> Unit = {},
    onRename: (id: String, filename: String, byAgent: Boolean) -> Unit = { _, _, _ -> },
    onSuggestName: (id: String, onResult: (Result<String>) -> Unit) -> Unit = { _, _ -> },
) {
    val context = LocalContext.current
    var pasteFilename by remember { mutableStateOf("") }
    var pasteText by remember { mutableStateOf("") }
    var pasteExpanded by remember { mutableStateOf(false) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }
    var renameTarget by remember { mutableStateOf<Document?>(null) }

    val pickFileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) uploadFromUri(context, uri, onUpload)
    }

    val takePictureLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val uri = pendingCameraUri
        if (success && uri != null) uploadFromUri(context, uri, onUpload, defaultMimeType = "image/jpeg")
        pendingCameraUri = null
    }

    ScreenScaffold(
        title = "Documents",
        subtitle = "Upload a PDF or photo, or scan a document with the camera.",
    ) {
        // ---- search ----
        OutlinedTextField(
            value = searchQuery,
            onValueChange = { onSearchChange(it, searchMode) },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Search — by name, content, or meaning") },
            singleLine = true,
            shape = MaterialTheme.shapes.medium,
            leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null, modifier = Modifier.size(18.dp)) },
            trailingIcon = {
                if (searchQuery.isNotEmpty()) {
                    IconButton(onClick = { onSearchChange("", searchMode) }) {
                        Icon(Icons.Rounded.Close, contentDescription = "Clear search", modifier = Modifier.size(18.dp))
                    }
                }
            },
        )
        AnimatedVisibility(searchQuery.isNotBlank()) {
            Column {
                Spacer(Modifier.height(8.dp))
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    SEARCH_MODES.forEachIndexed { i, (key, label) ->
                        SegmentedButton(
                            selected = searchMode == key,
                            onClick = { onSearchChange(searchQuery, key) },
                            shape = SegmentedButtonDefaults.itemShape(i, SEARCH_MODES.size),
                        ) { Text(label, style = MaterialTheme.typography.labelMedium) }
                    }
                }
                val note = when {
                    searchMode == "semantic" && !semanticEnabled ->
                        "No embedding model on the server — showing keyword + fuzzy results."
                    searching -> "Searching…"
                    searchResults != null ->
                        "${searchResults.size} ${if (searchResults.size == 1) "match" else "matches"}"
                    else -> null
                }
                note?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }

        Spacer(Modifier.height(12.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = { pickFileLauncher.launch("*/*") },
                modifier = Modifier.weight(1f),
                shape = MaterialTheme.shapes.medium,
                contentPadding = PaddingValues(vertical = 14.dp),
            ) {
                Icon(Icons.Rounded.UploadFile, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Upload")
            }
            OutlinedButton(
                onClick = {
                    val uri = createScanUri(context)
                    pendingCameraUri = uri
                    takePictureLauncher.launch(uri)
                },
                modifier = Modifier.weight(1f),
                shape = MaterialTheme.shapes.medium,
                contentPadding = PaddingValues(vertical = 14.dp),
            ) {
                Icon(Icons.Rounded.CameraAlt, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text("Scan")
            }
        }
        uploadStatus?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Spacer(Modifier.height(10.dp))
        TextButton(
            onClick = { pasteExpanded = !pasteExpanded },
            contentPadding = PaddingValues(horizontal = 4.dp, vertical = 4.dp),
        ) {
            Icon(
                if (pasteExpanded) Icons.Rounded.KeyboardArrowDown else Icons.AutoMirrored.Rounded.KeyboardArrowRight,
                contentDescription = null,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(4.dp))
            Text("Paste text directly")
        }
        AnimatedVisibility(pasteExpanded) {
            Column {
                OutlinedTextField(
                    value = pasteFilename,
                    onValueChange = { pasteFilename = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("Filename, e.g. electric-bill.txt") },
                    singleLine = true,
                    shape = MaterialTheme.shapes.medium,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = pasteText,
                    onValueChange = { pasteText = it },
                    modifier = Modifier.fillMaxWidth().height(110.dp),
                    placeholder = { Text("Paste the document text here") },
                    shape = MaterialTheme.shapes.medium,
                )
                Spacer(Modifier.height(8.dp))
                Button(
                    onClick = {
                        if (pasteFilename.isNotBlank() && pasteText.isNotBlank()) {
                            onIngest(pasteFilename, pasteText)
                            pasteFilename = ""
                            pasteText = ""
                            pasteExpanded = false
                        }
                    },
                    modifier = Modifier.align(Alignment.End),
                    shape = MaterialTheme.shapes.medium,
                ) { Text("Ingest") }
            }
        }

        Spacer(Modifier.height(14.dp))

        val searchActive = searchQuery.isNotBlank()
        val rows: List<DocRow> = if (searchActive) {
            (searchResults ?: emptyList()).map {
                DocRow(it.id, it.filename, it.category, it.summary, it.extractionStatus, it.snippet.ifBlank { null })
            }
        } else {
            documents.map { DocRow(it.id, it.filename, it.extracted?.category, it.extracted?.summary, it.extractionStatus) }
        }

        when {
            searchActive && searchResults == null -> {
                // first search in flight — the "Searching…" note above covers it
            }
            searchActive && rows.isEmpty() -> EmptyState(
                text = "No documents match “$searchQuery”.",
                icon = {
                    Icon(
                        Icons.Rounded.Search,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
            !searchActive && rows.isEmpty() -> EmptyState(
                text = "No documents yet. Upload or scan one to get started.",
                icon = {
                    Icon(
                        Icons.Rounded.FolderOpen,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(rows, key = { it.id }) { row ->
                    DocumentCard(
                        row = row,
                        query = searchQuery,
                        onPreview = { onPreview(row.id) },
                        onRename = {
                            renameTarget = documents.firstOrNull { it.id == row.id }
                                ?: Document(id = row.id, filename = row.filename, rawText = "", createdAt = "")
                        },
                        onDelete = { onDelete(row.id) },
                        onRetry = { onRetry(row.id) },
                    )
                }
            }
        }
    }

    renameTarget?.let { doc ->
        RenameDocumentDialog(
            doc = doc,
            onSuggestName = onSuggestName,
            onConfirm = { newName, byAgent ->
                onRename(doc.id, newName, byAgent)
                renameTarget = null
            },
            onDismiss = { renameTarget = null },
        )
    }
}

@Composable
private fun DocumentCard(
    row: DocRow,
    query: String,
    onPreview: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
    onRetry: () -> Unit,
) {
    AppCard(onClick = onPreview) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                row.filename,
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            row.category?.let { category ->
                Spacer(Modifier.width(8.dp))
                Chip(category)
            }
            IconButton(onClick = onRename, modifier = Modifier.size(32.dp)) {
                Icon(
                    Icons.Rounded.DriveFileRenameOutline,
                    contentDescription = "Rename ${row.filename}",
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onDelete, modifier = Modifier.size(32.dp)) {
                Icon(
                    Icons.Rounded.Delete,
                    contentDescription = "Delete ${row.filename}",
                    modifier = Modifier.size(18.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        when {
            row.summary != null -> Text(
                row.summary,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            row.extractionStatus == "failed" -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "Couldn't read this document.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f, fill = false),
                )
                TextButton(
                    onClick = onRetry,
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                ) { Text("Retry") }
            }
            else -> Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(
                    "Extracting…",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        row.snippet?.let { snippet ->
            Spacer(Modifier.height(6.dp))
            Text(
                highlightTerms(snippet, query),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Bold the query's word tokens (3+ chars, so filler like "is" / "my" doesn't
 * speckle the snippet) wherever they appear in [text].
 */
@Composable
private fun highlightTerms(text: String, query: String): AnnotatedString {
    val terms = Regex("[\\p{L}\\p{N}]{3,}").findAll(query.lowercase()).map { it.value }.toSet()
    if (terms.isEmpty()) return AnnotatedString(text)
    val lower = text.lowercase()
    val marks = BooleanArray(text.length)
    for (t in terms) {
        var from = lower.indexOf(t)
        while (from >= 0) {
            for (i in from until from + t.length) marks[i] = true
            from = lower.indexOf(t, from + t.length)
        }
    }
    return buildAnnotatedString {
        var i = 0
        while (i < text.length) {
            val on = marks[i]
            val start = i
            while (i < text.length && marks[i] == on) i++
            if (on) withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text.substring(start, i)) }
            else append(text.substring(start, i))
        }
    }
}

/**
 * Rename a document by hand, or let the agent propose a name from the document's
 * content. The agent only ever fills the field — the rename is applied only when
 * the user taps Save, and an unedited AI name is flagged as agent-sourced.
 */
@Composable
private fun RenameDocumentDialog(
    doc: Document,
    onSuggestName: (id: String, onResult: (Result<String>) -> Unit) -> Unit,
    onConfirm: (filename: String, byAgent: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember(doc.id) { mutableStateOf(doc.filename) }
    var byAgent by remember(doc.id) { mutableStateOf(false) }
    var suggesting by remember(doc.id) { mutableStateOf(false) }
    var error by remember(doc.id) { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename document") },
        text = {
            Column {
                OutlinedTextField(
                    value = name,
                    onValueChange = {
                        name = it
                        byAgent = false
                    },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    label = { Text("Name") },
                    shape = MaterialTheme.shapes.medium,
                )
                Spacer(Modifier.height(8.dp))
                TextButton(
                    onClick = {
                        suggesting = true
                        error = null
                        onSuggestName(doc.id) { result ->
                            suggesting = false
                            result
                                .onSuccess {
                                    name = it
                                    byAgent = true
                                }
                                .onFailure { error = it.message ?: "Couldn't suggest a name" }
                        }
                    },
                    enabled = !suggesting,
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                ) {
                    if (suggesting) {
                        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Rounded.AutoAwesome, contentDescription = null, modifier = Modifier.size(16.dp))
                    }
                    Spacer(Modifier.width(6.dp))
                    Text(if (suggesting) "Thinking…" else "Suggest with agent")
                }
                val hint = error ?: if (byAgent) "Agent suggestion — edit it or tap Save to confirm." else null
                hint?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (error != null) MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(name.trim(), byAgent) },
                enabled = name.isNotBlank() && name.trim() != doc.filename,
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Camera capture needs a content:// URI to write into ahead of time — a raw file path won't do. */
private fun createScanUri(context: Context): Uri {
    val dir = File(context.cacheDir, "scans").apply { mkdirs() }
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
    val file = File(dir, "scan-$stamp.jpg")
    return FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
}

private fun uploadFromUri(
    context: Context,
    uri: Uri,
    onUpload: (filename: String, bytes: ByteArray, mimeType: String?) -> Unit,
    defaultMimeType: String? = null,
) {
    val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return
    val mimeType = context.contentResolver.getType(uri) ?: defaultMimeType
    val filename = queryDisplayName(context, uri) ?: fallbackFilename(mimeType)
    onUpload(filename, bytes, mimeType)
}

private fun queryDisplayName(context: Context, uri: Uri): String? {
    if (uri.scheme != "content") return null
    return context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (nameIndex >= 0 && cursor.moveToFirst()) cursor.getString(nameIndex) else null
    }
}

private fun fallbackFilename(mimeType: String?): String {
    val ext = when (mimeType) {
        "application/pdf" -> "pdf"
        "image/png" -> "png"
        "image/webp" -> "webp"
        else -> "jpg"
    }
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
    return "upload-$stamp.$ext"
}
