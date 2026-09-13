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
import androidx.compose.material.icons.automirrored.rounded.Comment
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
import kotlinx.coroutines.launch

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
    vm: app.familyagent.android.AppViewModel,
    onSave: (id: String, title: String, body: String, onDone: (WikiPage?) -> Unit) -> Unit,
    onRevert: (id: String, onDone: (WikiPage?) -> Unit) -> Unit,
    onDelete: (String) -> Unit,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    val richController = remember(pageId) { RichTextController("") }
    var canUndo by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    var comments by remember(pageId) { mutableStateOf<List<app.familyagent.android.data.WikiComment>>(emptyList()) }
    var showComments by remember { mutableStateOf(false) }
    var pendingQuote by remember { mutableStateOf<Triple<String, String, String>?>(null) }

    LaunchedEffect(pageId) {
        if (loaded) return@LaunchedEffect
        loaded = true
        load(pageId)?.let { page ->
            title = page.title; richController.setMarkdown(page.body); canUndo = page.prevBody != null
        }
        vm.ensureFamilyMembersLoaded()
        comments = vm.wikiComments(pageId)
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
                    IconButton(onClick = {
                        // A `null` selection means "comment on the whole
                        // page" — represented as an empty-quote anchor so
                        // the composer opens immediately either way (unlike
                        // artifacts, which need a separate "no selection"
                        // fallback button since a comment there is always
                        // opened from an in-page selection first).
                        pendingQuote = richController.currentSelectionQuote() ?: Triple("", "", "")
                        showComments = true
                    }) {
                        Icon(Icons.AutoMirrored.Rounded.Comment, contentDescription = "Comments")
                    }
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

    if (showComments) {
        WikiCommentsSheet(
            comments = comments,
            pendingQuote = pendingQuote,
            onDismiss = { showComments = false; pendingQuote = null },
            onAdd = { body ->
                val pq = pendingQuote
                scope.launch {
                    val req = app.familyagent.android.data.NewWikiCommentRequest(
                        body, pq?.first?.ifEmpty { null }, pq?.second?.ifEmpty { null }, pq?.third?.ifEmpty { null },
                    )
                    vm.addWikiComment(pageId, req)?.let { comments = comments + it; pendingQuote = null }
                }
            },
            onDelete = { cid -> scope.launch { if (vm.deleteWikiComment(pageId, cid)) comments = comments.filterNot { it.id == cid } } },
            onResolve = { cid -> scope.launch { vm.resolveWikiComment(pageId, cid)?.let { r -> comments = comments.map { if (it.id == cid) r else it } } } },
            onReopen = { cid -> scope.launch { vm.reopenWikiComment(pageId, cid)?.let { r -> comments = comments.map { if (it.id == cid) r else it } } } },
            onReply = { cid, body ->
                scope.launch {
                    vm.replyToWikiComment(pageId, cid, body)?.let { r ->
                        comments = comments.map { if (it.id == cid) r.comment else it }
                        richController.setMarkdown(r.page.body)
                        canUndo = r.page.prevBody != null
                    }
                }
            },
            nameForUserId = { id -> vm.nameForUserId(id) },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WikiCommentsSheet(
    comments: List<app.familyagent.android.data.WikiComment>,
    pendingQuote: Triple<String, String, String>?,
    onDismiss: () -> Unit,
    onAdd: (String) -> Unit,
    onDelete: (String) -> Unit,
    onResolve: (String) -> Unit,
    onReopen: (String) -> Unit,
    onReply: (String, String) -> Unit,
    nameForUserId: (String) -> String,
) {
    var draft by remember(pendingQuote) { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 24.dp)
                .heightIn(max = 560.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("Comments", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)

            if (pendingQuote != null) {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (pendingQuote.first.isNotEmpty()) {
                            Text("“${pendingQuote.first.take(140)}”", style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
                        }
                        OutlinedTextField(
                            value = draft, onValueChange = { draft = it },
                            modifier = Modifier.fillMaxWidth(),
                            placeholder = { Text(if (pendingQuote.first.isEmpty()) "Comment on this page…" else "What should change here? (or a question)") },
                            minLines = 2,
                        )
                        Button(onClick = { if (draft.isNotBlank()) { onAdd(draft); draft = "" } }, enabled = draft.isNotBlank(), modifier = Modifier.align(Alignment.End)) {
                            Text("Comment")
                        }
                    }
                }
            }

            if (comments.isEmpty()) {
                Text(
                    "Select text in the page, then tap the comment button — or comment on the whole page.",
                    style = MaterialTheme.typography.bodyMedium, color = AppAccents.textSecondary,
                )
            }
            comments.forEach { c ->
                CommentThreadCard(
                    quote = c.quote,
                    commentBody = c.body,
                    authorLabel = c.userName,
                    replies = c.replies,
                    status = c.status,
                    onReply = { body -> onReply(c.id, body) },
                    onResolve = { onResolve(c.id) },
                    onReopen = { onReopen(c.id) },
                    onDelete = { onDelete(c.id) },
                )
            }
        }
    }
}
