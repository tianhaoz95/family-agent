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
import androidx.compose.material.icons.rounded.Article
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.familyagent.android.data.Artifact
import app.familyagent.android.data.ArtifactSummary
import app.familyagent.android.ui.theme.AppAccents
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
 * Full-screen viewer for one artifact. Loads it, renders the wrapped document
 * in a sealed WebView: null base URL (opaque origin), all network blocked
 * (`shouldInterceptRequest` → empty + `blockNetworkLoads`), navigation denied.
 * Same isolation as [CardView], full-size and scrollable.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ArtifactViewScreen(
    artifactId: String,
    load: suspend (String) -> Artifact?,
    onClose: () -> Unit,
    onDelete: () -> Unit,
) {
    var artifact by remember(artifactId) { mutableStateOf<Artifact?>(null) }
    var error by remember(artifactId) { mutableStateOf<String?>(null) }
    var showSource by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }

    LaunchedEffect(artifactId) {
        error = null
        artifact = load(artifactId) ?: run { error = "This artifact may have been deleted."; null }
    }

    BackHandler { onClose() }

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
                    Box {
                        IconButton(onClick = { menuOpen = true }, enabled = artifact != null) {
                            Icon(Icons.Rounded.MoreVert, contentDescription = "More")
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            DropdownMenuItem(
                                text = { Text("View source") },
                                onClick = { menuOpen = false; showSource = true },
                            )
                            DropdownMenuItem(
                                text = { Text("Delete") },
                                leadingIcon = { Icon(Icons.Rounded.Delete, contentDescription = null) },
                                onClick = { menuOpen = false; onDelete() },
                            )
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }

        when {
            artifact != null -> {
                val a = artifact!!
                if (showSource) {
                    Text(
                        a.html,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .verticalScroll(rememberScrollState())
                            .padding(16.dp),
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
                                webViewClient = object : WebViewClient() {
                                    override fun shouldInterceptRequest(
                                        view: WebView?,
                                        request: WebResourceRequest?,
                                    ): WebResourceResponse =
                                        WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                                    override fun shouldOverrideUrlLoading(
                                        view: WebView?,
                                        request: WebResourceRequest?,
                                    ): Boolean = true
                                }
                                loadDataWithBaseURL(null, a.document, "text/html", "utf-8", null)
                            }
                        },
                        update = { /* immutable per id */ },
                    )
                }
            }
            error != null -> {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(error!!, style = MaterialTheme.typography.bodyLarge, color = AppAccents.textSecondary)
                }
            }
            else -> {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
    }
}
