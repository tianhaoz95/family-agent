package app.familyagent.android.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.UploadFile
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
) {
    val context = LocalContext.current
    var pasteFilename by remember { mutableStateOf("") }
    var pasteText by remember { mutableStateOf("") }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }

    val pickFileLauncher = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) uploadFromUri(context, uri, onUpload)
    }

    val takePictureLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        val uri = pendingCameraUri
        if (success && uri != null) uploadFromUri(context, uri, onUpload, defaultMimeType = "image/jpeg")
        pendingCameraUri = null
    }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Documents", style = MaterialTheme.typography.titleLarge)
        Text(
            "Upload a PDF, photo, or scan a document with the camera.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { pickFileLauncher.launch("*/*") }) {
                Icon(Icons.Filled.UploadFile, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Upload")
            }
            OutlinedButton(onClick = {
                val uri = createScanUri(context)
                pendingCameraUri = uri
                takePictureLauncher.launch(uri)
            }) {
                Icon(Icons.Filled.CameraAlt, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Scan")
            }
        }
        uploadStatus?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Spacer(Modifier.height(12.dp))

        var pasteExpanded by remember { mutableStateOf(false) }
        TextButton(onClick = { pasteExpanded = !pasteExpanded }) {
            Text(if (pasteExpanded) "Hide paste-text option" else "Or paste text directly")
        }
        if (pasteExpanded) {
            OutlinedTextField(
                value = pasteFilename,
                onValueChange = { pasteFilename = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("Filename, e.g. electric-bill.txt") },
                singleLine = true,
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = pasteText,
                onValueChange = { pasteText = it },
                modifier = Modifier.fillMaxWidth().height(96.dp),
                placeholder = { Text("Paste the document text here") },
            )
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = {
                    if (pasteFilename.isNotBlank() && pasteText.isNotBlank()) {
                        onIngest(pasteFilename, pasteText)
                        pasteFilename = ""
                        pasteText = ""
                    }
                },
                modifier = Modifier.align(Alignment.End),
            ) { Text("Ingest") }
        }

        Spacer(Modifier.height(12.dp))

        if (documents.isEmpty()) {
            EmptyState("No documents ingested yet.")
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(documents, key = { it.id }) { doc ->
                    ElevatedCard {
                        Column(Modifier.padding(12.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    doc.filename,
                                    style = MaterialTheme.typography.titleMedium,
                                    modifier = Modifier.weight(1f),
                                )
                                doc.extracted?.category?.let { category ->
                                    Surface(
                                        color = MaterialTheme.colorScheme.secondary.copy(alpha = 0.14f),
                                        shape = RoundedCornerShape(999.dp),
                                    ) {
                                        Text(
                                            category.uppercase(),
                                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.secondary,
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(
                                doc.extracted?.summary ?: "Extracting…",
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
