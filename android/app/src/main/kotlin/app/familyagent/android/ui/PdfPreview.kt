package app.familyagent.android.ui

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

private const val MAX_PREVIEW_PAGES = 20
private const val RENDER_SCALE = 2

/**
 * Renders a PDF's pages with the platform [PdfRenderer] (no third-party lib) —
 * the bytes come from `GET /documents/:id/original`. Pages are decoded off the
 * main thread into bitmaps and shown as a vertical list.
 */
@Composable
fun PdfPreview(bytes: ByteArray, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var pages by remember(bytes) { mutableStateOf<List<ImageBitmap>>(emptyList()) }
    var error by remember(bytes) { mutableStateOf<String?>(null) }

    LaunchedEffect(bytes) {
        runCatching {
            withContext(Dispatchers.IO) {
                val file = File.createTempFile("preview", ".pdf", context.cacheDir)
                file.writeBytes(bytes)
                try {
                    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
                        PdfRenderer(pfd).use { renderer ->
                            (0 until minOf(renderer.pageCount, MAX_PREVIEW_PAGES)).map { i ->
                                renderer.openPage(i).use { page ->
                                    val bmp = Bitmap.createBitmap(
                                        page.width * RENDER_SCALE,
                                        page.height * RENDER_SCALE,
                                        Bitmap.Config.ARGB_8888,
                                    )
                                    bmp.eraseColor(Color.WHITE)
                                    page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                    bmp.asImageBitmap()
                                }
                            }
                        }
                    }
                } finally {
                    file.delete()
                }
            }
        }.onSuccess { pages = it }.onFailure { error = it.message ?: "Couldn't open this PDF" }
    }

    when {
        error != null -> Text(
            error!!,
            modifier = modifier.padding(8.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
        )
        pages.isEmpty() -> Row(
            modifier.fillMaxWidth().padding(24.dp),
            horizontalArrangement = Arrangement.Center,
        ) { CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
        // A plain Column, not LazyColumn — the caller (DetailSheet) already
        // provides the vertical scroll; nesting same-direction scrollables crashes.
        else -> Column(
            modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            pages.forEachIndexed { i, page ->
                Image(
                    bitmap = page,
                    contentDescription = "PDF page ${i + 1}",
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp)),
                    contentScale = ContentScale.FillWidth,
                    alignment = Alignment.TopCenter,
                )
            }
        }
    }
}
