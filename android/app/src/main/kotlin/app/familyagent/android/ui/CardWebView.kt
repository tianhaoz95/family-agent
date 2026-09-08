package app.familyagent.android.ui

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.foundation.BorderStroke
import app.familyagent.android.data.Card
import app.familyagent.android.ui.theme.AppAccents
import java.io.ByteArrayInputStream

// A generated HTML card, rendered in a sealed inline WebView.
//
// Isolation (mirrors the desktop iframe sandbox): loaded with a null base URL
// so the page gets an opaque origin (no access to app storage/cookies); DOM
// storage off; every network request blocked at the WebViewClient AND the
// settings level; navigation blocked. The only bridge is one method that takes
// an int (the measured height). The document itself also carries a
// no-network CSP (see agent-core/src/cards/wrap.ts).

private const val CARD_MIN_DP = 60
private const val CARD_MAX_DP = 520
private const val CARD_MAX_DP_EXPANDED = 900

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CardView(card: Card, onViewSource: () -> Unit) {
    var expanded by remember(card.id) { mutableStateOf(false) }

    // The value the in-page runtime reports via AndroidCard.postHeight() is in
    // CSS pixels, and Android WebView keeps 1 CSS px ≈ 1 dp — so it maps to dp
    // directly, with no display-density conversion (a real bug once: dividing by
    // ~2.75 density clipped every card to a third of its height).
    var reportedDp by remember(card.id) { mutableStateOf(0) }

    val cap = if (expanded) CARD_MAX_DP_EXPANDED else CARD_MAX_DP
    val targetDp = reportedDp.coerceIn(CARD_MIN_DP, cap)
    val clamped = reportedDp > targetDp + 4
    val animatedH by animateDpAsState(targetDp.dp, label = "cardHeight")

    Surface(
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(Modifier.clip(RoundedCornerShape(16.dp))) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "✨",
                    style = MaterialTheme.typography.labelSmall,
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    card.title,
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onViewSource, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
                    Text("Code", style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
                }
            }
            AndroidView(
                modifier = Modifier.fillMaxWidth().height(animatedH),
                factory = { ctx ->
                    WebView(ctx).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = false
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        settings.blockNetworkLoads = true
                        settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
                        setBackgroundColor(0)
                        isVerticalScrollBarEnabled = false
                        addJavascriptInterface(object {
                            @JavascriptInterface
                            fun postHeight(px: Int) {
                                post { reportedDp = px.coerceIn(0, 4000) }
                            }
                        }, "AndroidCard")
                        webViewClient = object : WebViewClient() {
                            // Block every network request — nothing loads but the inline doc.
                            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse {
                                return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                            }
                            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean = true
                        }
                        // Null base URL => opaque origin, no app-resource / file access.
                        loadDataWithBaseURL(null, card.html, "text/html", "utf-8", null)
                    }
                },
                update = { /* card.html is immutable per id */ },
            )
            if (clamped || expanded) {
                TextButton(
                    onClick = { expanded = !expanded },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (expanded) "Show less" else "Show all", style = MaterialTheme.typography.labelMedium) }
            }
        }
    }
}
