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
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.familyagent.android.data.Document
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun DocumentsScreen(
    documents: List<Document>,
    uploadStatus: String?,
    onIngest: (filename: String, text: String) -> Unit,
    onUpload: (filename: String, bytes: ByteArray, mimeType: String?) -> Unit,
    onDelete: (id: String) -> Unit,
    onRetry: (id: String) -> Unit,
) {
    val context = LocalContext.current
    var pasteFilename by remember { mutableStateOf("") }
    var pasteText by remember { mutableStateOf("") }
    var pasteExpanded by remember { mutableStateOf(false) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }

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

        if (documents.isEmpty()) {
            EmptyState(
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
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(documents, key = { it.id }) { doc ->
                    AppCard {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                doc.filename,
                                style = MaterialTheme.typography.titleMedium,
                                modifier = Modifier.weight(1f),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            doc.extracted?.category?.let { category ->
                                Spacer(Modifier.width(8.dp))
                                Chip(category)
                            }
                            IconButton(
                                onClick = { onDelete(doc.id) },
                                modifier = Modifier.size(32.dp),
                            ) {
                                Icon(
                                    Icons.Rounded.Delete,
                                    contentDescription = "Delete ${doc.filename}",
                                    modifier = Modifier.size(18.dp),
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        Spacer(Modifier.height(6.dp))
                        val summary = doc.extracted?.summary
                        when {
                            summary != null -> Text(
                                summary,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            doc.extractionStatus == "failed" -> Row(
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
                                    onClick = { onRetry(doc.id) },
                                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                                ) { Text("Retry") }
                            }
                            else -> Row(verticalAlignment = Alignment.CenterVertically) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(12.dp),
                                    strokeWidth = 2.dp,
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    "Extracting…",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
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
