package app.familyagent.android.ui

import android.annotation.SuppressLint
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Comment
import androidx.compose.material.icons.rounded.Article
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.familyagent.android.data.Artifact
import app.familyagent.android.data.ArtifactSummary
import app.familyagent.android.data.NewArtifactCommentRequest
import app.familyagent.android.ui.theme.AppAccents
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayInputStream

/**
 * The Artifacts tab — a list of the full pages the assistant generated with
 * `render_artifact`. Tapping one navigates to [ArtifactViewScreen]. Mirrors the
 * desktop `#view-artifacts` and iOS `ArtifactsView`.
 */
@Composable
fun ArtifactsScreen(
    artifacts: List<ArtifactSummary>,
    loading: Boolean,
    onRefresh: () -> Unit,
    onOpen: (String) -> Unit,
    onDelete: (String) -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }

    ScreenScaffold(
        title = "Artifacts",
        subtitle = "Full pages the assistant made to explain something — ask it for one in Chat.",
    ) {
        if (artifacts.isEmpty()) {
            EmptyState(
                text = if (loading) "Loading…" else
                    "No artifacts yet. Ask the assistant to walk you through something with a page.",
                icon = {
                    Icon(
                        Icons.Rounded.Article,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(artifacts, key = { it.id }) { a ->
                    var menuOpen by remember { mutableStateOf(false) }
                    AppCard(onClick = { onOpen(a.id) }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    a.title,
                                    style = MaterialTheme.typography.titleMedium,
                                    color = MaterialTheme.colorScheme.onSurface,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Spacer(Modifier.height(3.dp))
                                Text(
                                    a.createdAt.take(10),
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
                                        onClick = { menuOpen = false; onDelete(a.id) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Full-screen viewer for one artifact. Sealed WebView (null base URL → opaque
 * origin, all network blocked, navigation denied) — same isolation as [CardView].
 *
 * Highlight-and-comment: the in-page runtime posts a text selection over an
 * `@JavascriptInterface`; a comments bottom sheet lists the notes and can ask
 * the assistant to address them (it edits the artifact or replies). Comments are
 * pushed into the page with `evaluateJavascript(window.__artifactApi.setComments)`.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ArtifactViewScreen(
    artifactId: String,
    load: suspend (String) -> app.familyagent.android.data.ArtifactResponse?,
    vm: app.familyagent.android.AppViewModel,
    onClose: () -> Unit,
    onDelete: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var artifact by remember(artifactId) { mutableStateOf<Artifact?>(null) }
    var comments by remember(artifactId) { mutableStateOf<List<app.familyagent.android.data.ArtifactComment>>(emptyList()) }
    var error by remember(artifactId) { mutableStateOf<String?>(null) }
    var showSource by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var showComments by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var pendingQuote by remember { mutableStateOf<Triple<String, String, String>?>(null) }
    var webRef by remember { mutableStateOf<WebView?>(null) }

    val json = remember { kotlinx.serialization.json.Json { ignoreUnknownKeys = true } }
    fun pushComments() {
        val web = webRef ?: return
        val payload = comments.map {
            app.familyagent.android.data.ArtifactCommentAnchor(it.id, it.quote ?: "", it.prefix ?: "", it.suffix ?: "", it.status)
        }
        val arr = json.encodeToString(
            kotlinx.serialization.builtins.ListSerializer(app.familyagent.android.data.ArtifactCommentAnchor.serializer()),
            payload,
        )
        web.post { web.evaluateJavascript("window.__artifactApi && window.__artifactApi.setComments($arr);", null) }
    }
    LaunchedEffect(comments) { pushComments() }

    LaunchedEffect(artifactId) {
        error = null
        val r = load(artifactId)
        if (r == null) { error = "This artifact may have been deleted." }
        else { artifact = r.artifact; comments = r.comments }
    }

    BackHandler { onClose() }

    val openCount = comments.count { it.status == "open" }

    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        Surface(color = MaterialTheme.colorScheme.background) {
            Column {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .padding(start = 4.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to Artifacts")
                    }
                    Text(
                        artifact?.title ?: "Artifact",
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    BadgedBox(badge = { if (openCount > 0) Badge { Text("$openCount") } }) {
                        IconButton(onClick = { showComments = true }, enabled = artifact != null) {
                            Icon(Icons.AutoMirrored.Rounded.Comment, contentDescription = "Comments")
                        }
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }, enabled = artifact != null) {
                            Icon(Icons.Rounded.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(text = { Text("View source") }, onClick = { menuOpen = false; showSource = true })
                            if (artifact?.canRevert == true) {
                                DropdownMenuItem(text = { Text("Undo last edit") }, onClick = {
                                    menuOpen = false
                                    scope.launch { vm.revertArtifact(artifactId)?.let { artifact = it.artifact; comments = it.comments } }
                                })
                            }
                            DropdownMenuItem(
                                text = { Text("Delete") },
                                leadingIcon = { Icon(Icons.Rounded.Delete, contentDescription = null) },
                                onClick = { menuOpen = false; onDelete() },
                            )
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                if (working) {
                    Text(
                        "The assistant is working through the comments…",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.primaryContainer).padding(8.dp),
                    )
                }
            }
        }

        when {
            artifact != null -> {
                val a = artifact!!
                if (showSource) {
                    Text(
                        a.html,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp),
                    )
                } else {
                    AndroidView(
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        factory = { ctx ->
                            WebView(ctx).apply {
                                settings.javaScriptEnabled = true
                                settings.domStorageEnabled = false
                                settings.allowFileAccess = false
                                settings.allowContentAccess = false
                                settings.blockNetworkLoads = true
                                settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
                                addJavascriptInterface(object {
                                    @android.webkit.JavascriptInterface
                                    fun post(msg: String) {
                                        val obj = runCatching { json.parseToJsonElement(msg).jsonObject }.getOrNull() ?: return
                                        if (obj["type"]?.jsonPrimitive?.content == "artifact:selection") {
                                            val q = obj["quote"]?.jsonPrimitive?.content ?: return
                                            post {
                                                pendingQuote = Triple(
                                                    q,
                                                    obj["prefix"]?.jsonPrimitive?.content ?: "",
                                                    obj["suffix"]?.jsonPrimitive?.content ?: "",
                                                )
                                                showComments = true
                                            }
                                        }
                                    }
                                }, "AndroidArtifact")
                                webViewClient = object : WebViewClient() {
                                    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse =
                                        WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                                    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true
                                    override fun onPageFinished(view: WebView?, url: String?) { pushComments() }
                                }
                                webRef = this
                                loadDataWithBaseURL(null, a.document, "text/html", "utf-8", null)
                            }
                        },
                        update = { web ->
                            if (web.tag != a.revision) {
                                web.tag = a.revision
                                web.loadDataWithBaseURL(null, a.document, "text/html", "utf-8", null)
                            }
                        },
                    )
                }
            }
            error != null -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(error!!, style = MaterialTheme.typography.bodyLarge, color = AppAccents.textSecondary)
            }
            else -> Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        }
    }

    if (showComments) {
        ArtifactCommentsSheet(
            comments = comments,
            canRevert = artifact?.canRevert == true,
            working = working,
            pendingQuote = pendingQuote,
            onDismiss = { showComments = false; pendingQuote = null },
            onAdd = { body ->
                val pq = pendingQuote
                scope.launch {
                    val c = vm.addArtifactComment(
                        artifactId,
                        NewArtifactCommentRequest(body, pq?.first, pq?.second, pq?.third),
                    )
                    if (c != null) { comments = comments + c; pendingQuote = null }
                }
            },
            onAskAI = { ids ->
                scope.launch {
                    working = true
                    vm.resolveArtifactComments(artifactId, ids)?.let { artifact = it.artifact; comments = it.comments }
                    working = false
                }
            },
            onDelete = { cid -> scope.launch { if (vm.deleteArtifactComment(artifactId, cid)) comments = comments.filterNot { it.id == cid } } },
            onReopen = { cid -> scope.launch { vm.reopenArtifactComment(artifactId, cid)?.let { r -> comments = comments.map { if (it.id == cid) r else it } } } },
            onRevert = { scope.launch { vm.revertArtifact(artifactId)?.let { artifact = it.artifact; comments = it.comments } } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ArtifactCommentsSheet(
    comments: List<app.familyagent.android.data.ArtifactComment>,
    canRevert: Boolean,
    working: Boolean,
    pendingQuote: Triple<String, String, String>?,
    onDismiss: () -> Unit,
    onAdd: (String) -> Unit,
    onAskAI: (List<String>?) -> Unit,
    onDelete: (String) -> Unit,
    onReopen: (String) -> Unit,
    onRevert: () -> Unit,
) {
    var draft by remember(pendingQuote) { mutableStateOf("") }
    val open = comments.filter { it.status == "open" }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 18.dp).padding(bottom = 24.dp)
                .heightIn(max = 560.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Comments", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                if (canRevert) TextButton(onClick = onRevert) { Text("Undo edit") }
            }

            if (pendingQuote != null) {
                Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.medium) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (pendingQuote.first.isNotEmpty()) {
                            Text("“${pendingQuote.first.take(140)}”", style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
                        }
                        OutlinedTextField(
                            value = draft, onValueChange = { draft = it },
                            modifier = Modifier.fillMaxWidth(),
                            placeholder = { Text("What should change here? (or a question)") },
                            minLines = 2,
                        )
                        Button(onClick = { if (draft.isNotBlank()) { onAdd(draft); draft = "" } }, enabled = draft.isNotBlank(), modifier = Modifier.align(Alignment.End)) {
                            Text("Comment")
                        }
                    }
                }
            }

            if (open.isNotEmpty()) {
                Button(onClick = { onAskAI(null) }, enabled = !working, modifier = Modifier.fillMaxWidth()) {
                    Text("Ask the assistant to address ${open.size}")
                }
            }

            if (comments.isEmpty()) {
                Text("Select text in the page to leave a comment.", style = MaterialTheme.typography.bodyMedium, color = AppAccents.textSecondary)
            }
            comments.forEach { c ->
                Surface(
                    tonalElevation = if (c.status == "resolved") 0.dp else 1.dp,
                    shape = MaterialTheme.shapes.medium,
                    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                ) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        if (!c.quote.isNullOrEmpty()) {
                            Text("“${c.quote.take(120)}”", style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
                        }
                        Text(c.body, style = MaterialTheme.typography.bodyMedium)
                        if (c.status == "resolved") {
                            Text(
                                (if (c.resolvedBy == "agent") "Assistant: " else "") + (c.resolution ?: "Resolved."),
                                style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary,
                            )
                            TextButton(onClick = { onReopen(c.id) }, contentPadding = PaddingValues(0.dp)) { Text("Reopen") }
                        } else {
                            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                                TextButton(onClick = { onAskAI(listOf(c.id)) }, enabled = !working, contentPadding = PaddingValues(0.dp)) { Text("Ask AI") }
                                TextButton(onClick = { onDelete(c.id) }, contentPadding = PaddingValues(0.dp)) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                            }
                        }
                    }
                }
            }
        }
    }
}
