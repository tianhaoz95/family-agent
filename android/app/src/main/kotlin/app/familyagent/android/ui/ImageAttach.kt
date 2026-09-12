package app.familyagent.android.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

// Chat images travel to agent-core as JPEG data URIs and the planner model
// (gemma4:e2b) is multimodal. Phone photos are 10+ MP — downscale before
// encoding so the request stays small and the local model stays quick.
private const val MAX_EDGE = 1536
private const val JPEG_QUALITY = 85

/**
 * Reads an image [uri], downscales it to at most [MAX_EDGE] on the long side,
 * and returns it as a `data:image/jpeg;base64,…` URI. Null if it can't be read.
 */
suspend fun uriToScaledJpegDataUri(context: Context, uri: Uri): String? = withContext(Dispatchers.IO) {
    val raw = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@withContext null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
    val longest = maxOf(bounds.outWidth, bounds.outHeight).coerceAtLeast(1)
    var sample = 1
    while (longest / sample > MAX_EDGE * 2) sample *= 2

    val decoded = BitmapFactory.decodeByteArray(
        raw, 0, raw.size,
        BitmapFactory.Options().apply { inSampleSize = sample },
    ) ?: return@withContext null

    val scale = minOf(1f, MAX_EDGE.toFloat() / maxOf(decoded.width, decoded.height))
    val bmp = if (scale < 1f) {
        Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt(), (decoded.height * scale).toInt(), true)
    } else {
        decoded
    }

    val out = ByteArrayOutputStream()
    bmp.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
    "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

/** PNG-encodes a [Bitmap] already in memory (e.g. a rendered drawing canvas)
 *  as a data URI — no downscaling, since the source is already exactly the
 *  size it should be. */
fun bitmapToPngDataUri(bitmap: Bitmap): String {
    val out = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
    return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
}

/** Decode a `data:…;base64,…` URI back to an ImageBitmap for display. */
fun dataUriToImageBitmap(dataUri: String): ImageBitmap? = runCatching {
    val b64 = dataUri.substringAfter(",", "")
    val bytes = Base64.decode(b64, Base64.DEFAULT)
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
}.getOrNull()
