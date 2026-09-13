package app.familyagent.android.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Comment
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.PhotoLibrary
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.familyagent.android.data.GalleryPhoto
import app.familyagent.android.ui.theme.AppAccents
import kotlinx.coroutines.launch
import java.io.File

private const val GALLERY_DISPLAY_EDGE = 1600
private const val GALLERY_THUMB_EDGE = 360
private const val GALLERY_THUMB_QUALITY = 75

/**
 * A family photo gallery, distinct from Documents (a searchable file list —
 * the wrong UX for browsing photos) and the sticky Board (a handful of
 * pinned photos, not a scrollable library). Private-vs-shared mirrors the
 * Board exactly. Mirrors desktop `#view-gallery` and iOS `GalleryView`. See
 * docs/DECISIONS.md → "Family gallery".
 */
@Composable
fun GalleryScreen(
    photos: List<GalleryPhoto>,
    scope: String,
    uploading: Boolean,
    onScope: (String) -> Unit,
    onUpload: (image: String, thumb: String) -> Unit,
    onRefresh: () -> Unit,
    onOpen: (String) -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()

    val pickPhotos = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        coroutineScope.launch {
            for (uri in uris) {
                val display = uriToScaledJpegDataUri(context, uri, maxEdge = GALLERY_DISPLAY_EDGE) ?: continue
                val thumb = uriToScaledJpegDataUri(context, uri, maxEdge = GALLERY_THUMB_EDGE, quality = GALLERY_THUMB_QUALITY) ?: continue
                onUpload(display, thumb)
            }
        }
    }

    ScreenScaffold(
        title = "Gallery",
        subtitle = "Photos for the whole family, or just for you.",
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            SingleChoiceSegmentedButtonRow(Modifier.weight(1f)) {
                listOf("shared" to "Shared", "private" to "Mine").forEachIndexed { i, (key, label) ->
                    SegmentedButton(
                        selected = scope == key,
                        onClick = { onScope(key) },
                        shape = SegmentedButtonDefaults.itemShape(i, 2),
                    ) { Text(label) }
                }
            }
            Spacer(Modifier.width(10.dp))
            FilledTonalButton(onClick = { pickPhotos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
                Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("Add")
            }
        }
        Spacer(Modifier.height(12.dp))

        if (uploading) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("Uploading…", style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
            }
            Spacer(Modifier.height(8.dp))
        }

        if (photos.isEmpty() && !uploading) {
            EmptyState(
                text = "No photos yet. Add one above.",
                icon = {
                    Icon(
                        Icons.Rounded.PhotoLibrary,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 110.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(photos, key = { it.id }) { photo ->
                    val bitmap = remember(photo.thumb) { dataUriToImageBitmap(photo.thumb) }
                    if (bitmap != null) {
                        Image(
                            bitmap = bitmap,
                            contentDescription = photo.caption,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier
                                .aspectRatio(1f)
                                .clip(RoundedCornerShape(10.dp))
                                .clickable(onClick = { onOpen(photo.id) }),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Fetches the full-size image on open (the grid only ever holds the
 * thumbnail) — same "list is light, one item is heavy" shape as
 * [WikiPageScreen]. Chrome mirrors the system Photos viewer: a top bar (back
 * chevron, the date as the title, an overflow menu for delete) plus a bottom
 * toolbar (share, a caption toggle) rather than a bare full-bleed overlay —
 * see docs/DECISIONS.md → "Family gallery" and the desktop/iOS counterparts.
 */
@Composable
fun GalleryPhotoScreen(
    photoId: String,
    load: suspend (String) -> GalleryPhoto?,
    onSaveCaption: (id: String, caption: String?, onDone: (GalleryPhoto?) -> Unit) -> Unit,
    onDelete: (String) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var photo by remember { mutableStateOf<GalleryPhoto?>(null) }
    var caption by remember { mutableStateOf("") }
    var editingCaption by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }

    LaunchedEffect(photoId) {
        if (loaded) return@LaunchedEffect
        loaded = true
        load(photoId)?.let { p -> photo = p; caption = p.caption ?: "" }
    }

    BackHandler { onClose() }

    val titleText = photo?.let { formatPhotoDate(it.createdAt) } ?: "Photo"

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Surface(color = MaterialTheme.colorScheme.background) {
            Column {
                Row(
                    Modifier.fillMaxWidth().statusBarsPadding().padding(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to Gallery")
                    }
                    Text(
                        titleText,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Box {
                        IconButton(onClick = { menuOpen = true }, enabled = photo != null) {
                            Icon(Icons.Rounded.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("Delete") },
                                leadingIcon = { Icon(Icons.Rounded.Delete, contentDescription = null) },
                                onClick = { menuOpen = false; showDeleteConfirm = true },
                            )
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }

        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            val bitmap = photo?.image?.takeIf { it.isNotEmpty() }?.let { remember(it) { dataUriToImageBitmap(it) } }
            if (bitmap != null) {
                Image(bitmap = bitmap, contentDescription = photo?.caption, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize().padding(16.dp))
            } else {
                CircularProgressIndicator()
            }
        }

        if (editingCaption) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = caption,
                    onValueChange = { caption = it },
                    placeholder = { Text("Add a caption…") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                Button(onClick = {
                    onSaveCaption(photoId, caption.ifBlank { null }) { updated ->
                        if (updated != null) photo = updated
                        editingCaption = false
                    }
                }) { Text("Save") }
            }
        } else if (!photo?.caption.isNullOrEmpty()) {
            Text(
                photo?.caption.orEmpty(),
                style = MaterialTheme.typography.bodySmall,
                color = AppAccents.textSecondary,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = {
                    val p = photo ?: return@IconButton
                    sharePhoto(context, p)
                },
                enabled = photo?.image?.isNotEmpty() == true,
            ) { Icon(Icons.Rounded.Share, contentDescription = "Share") }
            Spacer(Modifier.weight(1f))
            IconButton(onClick = {
                if (editingCaption) {
                    editingCaption = false
                } else {
                    caption = photo?.caption ?: ""
                    editingCaption = true
                }
            }) {
                Icon(
                    Icons.AutoMirrored.Rounded.Comment,
                    contentDescription = "Add or edit caption",
                    tint = if (editingCaption) MaterialTheme.colorScheme.primary else LocalContentColor.current,
                )
            }
        }
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("Delete this photo?") },
            text = { Text("This can't be undone.") },
            confirmButton = {
                TextButton(onClick = { showDeleteConfirm = false; onDelete(photoId) }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { showDeleteConfirm = false }) { Text("Cancel") } },
        )
    }
}

/** "Today, 7:52 AM" / "Yesterday, …" / "Sep 13, 2026" — mirrors the desktop
 *  (`friendlyDate` + a time) and iOS (`titleText`) formatting exactly. */
private fun formatPhotoDate(iso: String): String = runCatching {
    val instant = java.time.Instant.parse(iso)
    val zdt = instant.atZone(java.time.ZoneId.systemDefault())
    val today = java.time.LocalDate.now()
    val time = zdt.format(java.time.format.DateTimeFormatter.ofPattern("h:mm a"))
    when (zdt.toLocalDate()) {
        today -> "Today, $time"
        today.minusDays(1) -> "Yesterday, $time"
        else -> zdt.format(java.time.format.DateTimeFormatter.ofPattern("MMM d, yyyy"))
    }
}.getOrDefault("Photo")

/** Decodes the photo's data: URI to a real file under cache/gallery/ (see
 *  res/xml/file_paths.xml) just long enough to hand a content:// URI to a
 *  share-sheet Intent — mirrors createChatPhotoUri's FileProvider shape. */
private fun sharePhoto(context: android.content.Context, photo: GalleryPhoto) {
    val uriData = photo.image
    val comma = uriData.indexOf(',')
    if (comma < 0) return
    val mime = if (uriData.contains("image/png")) "image/png" else "image/jpeg"
    val ext = if (mime == "image/png") "png" else "jpg"
    val bytes = android.util.Base64.decode(uriData.substring(comma + 1), android.util.Base64.DEFAULT)
    val dir = File(context.cacheDir, "gallery").apply { mkdirs() }
    val file = File(dir, "photo-${photo.id}.$ext")
    file.writeBytes(bytes)
    val contentUri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_SEND).apply {
        type = mime
        putExtra(Intent.EXTRA_STREAM, contentUri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(intent, "Share photo"))
}
