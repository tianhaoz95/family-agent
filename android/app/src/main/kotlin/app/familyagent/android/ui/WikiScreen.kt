package app.familyagent.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.MenuBook
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.WikiPage
import app.familyagent.android.ui.theme.AppAccents

/**
 * The family wiki's page list — every page is shared, no private/shared
 * toggle (see docs/DECISIONS.md → "Family wiki"). Tapping a page pushes
 * [WikiPageScreen]; "New page" creates one and opens straight into it.
 * Mirrors the desktop `#view-wiki` and iOS `WikiView`.
 */
@Composable
fun WikiScreen(
    pages: List<WikiPage>,
    onRefresh: () -> Unit,
    onCreate: (title: String) -> Unit,
    onOpen: (String) -> Unit,
    onDelete: (String) -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }
    var showNewDialog by remember { mutableStateOf(false) }
    var newTitle by remember { mutableStateOf("") }

    ScreenScaffold(
        title = "Wiki",
        subtitle = "A shared notebook for the family — anyone can read and edit any page.",
    ) {
        FilledTonalButton(onClick = { newTitle = ""; showNewDialog = true }) {
            Icon(Icons.Rounded.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(4.dp))
            Text("New page")
        }
        Spacer(Modifier.height(12.dp))

        if (pages.isEmpty()) {
            EmptyState(
                text = "No pages yet. Start the family notebook with one.",
                icon = {
                    Icon(
                        Icons.Rounded.MenuBook,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(pages, key = { it.id }) { p ->
                    var menuOpen by remember { mutableStateOf(false) }
                    AppCard(onClick = { onOpen(p.id) }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    p.title,
                                    style = MaterialTheme.typography.titleMedium,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Spacer(Modifier.height(3.dp))
                                Text(
                                    "Edited by ${p.updatedByName}",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = AppAccents.textSecondary,
                                )
                            }
                            Box {
                                IconButton(onClick = { menuOpen = true }) {
                                    Icon(Icons.Rounded.MoreVert, contentDescription = "More")
                                }
                                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                    DropdownMenuItem(
                                        text = { Text("Delete") },
                                        leadingIcon = { Icon(Icons.Rounded.Delete, contentDescription = null) },
                                        onClick = { menuOpen = false; onDelete(p.id) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (showNewDialog) {
        AlertDialog(
            onDismissRequest = { showNewDialog = false },
            title = { Text("New page") },
            text = {
                OutlinedTextField(
                    value = newTitle,
                    onValueChange = { newTitle = it },
                    label = { Text("Title") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                )
            },
            confirmButton = {
                TextButton(
                    enabled = newTitle.isNotBlank(),
                    onClick = {
                        val t = newTitle.trim()
                        showNewDialog = false
                        if (t.isNotEmpty()) onCreate(t)
                    },
                ) { Text("Create") }
            },
            dismissButton = { TextButton(onClick = { showNewDialog = false }) { Text("Cancel") } },
        )
    }
}

/**
 * Edit/preview a single page. Loads its own fresh copy on appear (the list
 * row's [WikiPage] may be stale) — same "list is light, one item is fetched
 * fresh" shape as [GalleryPhotoScreen]. Chrome mirrors [ArtifactViewScreen]'s
 * top bar (back, title, overflow menu).
 */
@Composable
fun WikiPageScreen(
    pageId: String,
    load: suspend (String) -> WikiPage?,
    onSave: (id: String, title: String, body: String, onDone: (WikiPage?) -> Unit) -> Unit,
    onRevert: (id: String, onDone: (WikiPage?) -> Unit) -> Unit,
    onDelete: (String) -> Unit,
    onClose: () -> Unit,
) {
    var title by remember { mutableStateOf("") }
    val richController = remember(pageId) { RichTextController("") }
    var canUndo by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }

    LaunchedEffect(pageId) {
        if (loaded) return@LaunchedEffect
        loaded = true
        load(pageId)?.let { page ->
            title = page.title; richController.setMarkdown(page.body); canUndo = page.prevBody != null
        }
    }

    BackHandler { onClose() }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Surface(color = MaterialTheme.colorScheme.background) {
            Column {
                Row(
                    Modifier.fillMaxWidth().statusBarsPadding().padding(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to Wiki")
                    }
                    Text(
                        title.ifBlank { "Page" },
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Box {
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(Icons.Rounded.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            if (canUndo) {
                                DropdownMenuItem(
                                    text = { Text("Undo last edit") },
                                    onClick = {
                                        menuOpen = false
                                        onRevert(pageId) { page ->
                                            if (page != null) {
                                                title = page.title; richController.setMarkdown(page.body); canUndo = page.prevBody != null
                                                status = "Reverted to the previous version."
                                            }
                                        }
                                    },
                                )
                            }
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

        Column(Modifier.weight(1f).fillMaxWidth().padding(16.dp)) {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text("Page title") },
                textStyle = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            RichTextToolbar(richController)
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Spacer(Modifier.height(10.dp))
            Surface(
                Modifier.weight(1f).fillMaxWidth(),
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
            ) {
                Box(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp)) {
                    RichTextEditor(richController, modifier = Modifier.fillMaxWidth())
                }
            }
            if (status.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text(status, style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
            }
            Spacer(Modifier.height(10.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Button(onClick = {
                    status = "Saving…"
                    onSave(pageId, title, richController.currentMarkdown()) { page ->
                        if (page == null) {
                            status = "Couldn't save."
                        } else {
                            canUndo = page.prevBody != null
                            status = "Saved — last edited by ${page.updatedByName}."
                        }
                    }
                }) { Text("Save") }
            }
        }
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text("Delete this page?") },
            text = { Text("This can't be undone.") },
            confirmButton = {
                TextButton(onClick = { showDeleteConfirm = false; onDelete(pageId) }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { showDeleteConfirm = false }) { Text("Cancel") } },
        )
    }
}
