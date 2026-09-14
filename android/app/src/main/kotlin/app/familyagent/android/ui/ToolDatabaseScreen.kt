package app.familyagent.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.Tool
import app.familyagent.android.data.ToolDbColumn
import app.familyagent.android.data.ToolDbOverview
import app.familyagent.android.data.ToolDbQueryResult
import app.familyagent.android.data.ToolDbRowPage
import app.familyagent.android.ui.theme.AppAccents
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.long

private const val PAGE_SIZE = 50
private val prettyJsonFormat = Json { prettyPrint = true }

/**
 * Read-only browser for a "server"-kind tool's private SQLite database, or a
 * static tool's saved `/__state` blobs — the mobile mirror of desktop's
 * `#db-inspector`. Everything here is display-only: the harness only ever
 * opens the connection `readOnly`, and the one write-shaped affordance (the
 * SQL box) is server-side-restricted to SELECT/WITH/EXPLAIN/PRAGMA anyway —
 * this screen doesn't need to (and doesn't) enforce that itself.
 */
@Composable
fun ToolDatabaseScreen(
    toolId: String,
    loadTool: suspend (String) -> Tool?,
    loadOverview: suspend (String) -> Result<ToolDbOverview>,
    loadRows: suspend (
        id: String, table: String, limit: Int?, offset: Int?, orderBy: String?, dir: String?,
    ) -> Result<ToolDbRowPage>,
    runQuery: suspend (id: String, sql: String) -> Result<ToolDbQueryResult>,
    loadStateValue: suspend (id: String, key: String) -> Result<JsonElement?>,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var tool by remember { mutableStateOf<Tool?>(null) }
    var overview by remember { mutableStateOf<ToolDbOverview?>(null) }
    var selectedTable by remember { mutableStateOf<String?>(null) }
    var selectedStateKey by remember { mutableStateOf<String?>(null) }
    var stateValueText by remember { mutableStateOf<String?>(null) }
    var rowPage by remember { mutableStateOf<ToolDbRowPage?>(null) }
    var queryResult by remember { mutableStateOf<ToolDbQueryResult?>(null) }
    var orderBy by remember { mutableStateOf<String?>(null) }
    var dir by remember { mutableStateOf("asc") }
    var offset by remember { mutableStateOf(0) }
    var sql by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    fun runningQuery() = queryResult != null

    suspend fun loadPage() {
        val table = selectedTable ?: return
        loading = true
        error = null
        loadRows(toolId, table, PAGE_SIZE, offset, orderBy, orderBy?.let { dir })
            .onSuccess { rowPage = it; queryResult = null }
            .onFailure { error = it.message ?: "Couldn't load rows"; rowPage = null }
        loading = false
    }

    fun selectTable(name: String) {
        selectedTable = name
        selectedStateKey = null
        orderBy = null
        dir = "asc"
        offset = 0
        sql = ""
        scope.launch { loadPage() }
    }

    fun selectStateKey(key: String) {
        selectedStateKey = key
        selectedTable = null
        scope.launch {
            loading = true
            error = null
            loadStateValue(toolId, key)
                .onSuccess { v ->
                    stateValueText = v?.let { prettyJson(it) } ?: "null"
                }
                .onFailure { error = it.message ?: "Couldn't load" }
            loading = false
        }
    }

    fun runSql() {
        val q = sql.trim()
        if (q.isEmpty()) return
        scope.launch {
            loading = true
            error = null
            selectedTable = null
            offset = 0
            runQuery(toolId, q)
                .onSuccess { queryResult = it; rowPage = null }
                .onFailure { error = it.message ?: "Couldn't run that query" }
            loading = false
        }
    }

    LaunchedEffect(toolId) {
        loading = true
        tool = loadTool(toolId)
        loadOverview(toolId)
            .onSuccess { ov ->
                overview = ov
                if (ov.kind == "server") {
                    ov.tables.firstOrNull()?.let { selectTable(it.name) } ?: run { loading = false }
                } else {
                    ov.stateEntries.firstOrNull()?.let { selectStateKey(it.key) } ?: run { loading = false }
                }
            }
            .onFailure { error = it.message ?: "Couldn't load"; loading = false }
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
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to Tools")
                    }
                    Column(Modifier.weight(1f)) {
                        Text(
                            (tool?.name ?: "Tool") + (if (overview?.kind == "static") " — saved data" else " — database"),
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        overview?.sizeBytes?.let {
                            Text(fmtBytes(it), style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
                        }
                    }
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            }
        }

        val ov = overview
        when {
            error != null && ov == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(error!!, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            }
            ov == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            ov.kind != "server" -> StaticStateBody(ov, selectedStateKey, stateValueText, loading, error, ::selectStateKey)
            !ov.exists || ov.tables.isEmpty() -> EmptyState(
                text = if (!ov.exists) "This tool starts storing information the first time it's used in Chat or opened."
                else "Once the tool records something, it'll show up here.",
            )
            else -> ServerDbBody(
                tables = ov.tables.map { it.name to it.rowCount },
                selectedTable = selectedTable,
                onSelectTable = ::selectTable,
                sql = sql,
                onSqlChange = { sql = it },
                onRunSql = ::runSql,
                loading = loading,
                error = error,
                rowPage = rowPage,
                queryResult = queryResult,
                orderBy = orderBy,
                dir = dir,
                onSort = { col ->
                    if (orderBy == col) dir = if (dir == "asc") "desc" else "asc" else { orderBy = col; dir = "asc" }
                    offset = 0
                    scope.launch { loadPage() }
                },
                onPrev = { offset = maxOf(0, offset - PAGE_SIZE); scope.launch { loadPage() } },
                onNext = { offset += PAGE_SIZE; scope.launch { loadPage() } },
            )
        }
    }
}

@Composable
private fun StaticStateBody(
    overview: ToolDbOverview,
    selectedKey: String?,
    valueText: String?,
    loading: Boolean,
    error: String?,
    onSelect: (String) -> Unit,
) {
    if (overview.stateEntries.isEmpty()) {
        EmptyState(text = "This tool hasn't stored anything so far.")
        return
    }
    Row(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.width(140.dp).fillMaxHeight().padding(vertical = 8.dp)) {
            items(overview.stateEntries, key = { it.key }) { e ->
                val active = e.key == selectedKey
                Row(
                    Modifier.fillMaxWidth()
                        .background(if (active) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                        .clickableRow { onSelect(e.key) }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                ) {
                    Column {
                        Text(if (e.key == "__ls") "browser storage" else e.key, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(fmtBytes(e.bytes), style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
                    }
                }
            }
        }
        VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Box(Modifier.weight(1f).fillMaxHeight()) {
            when {
                loading && valueText == null -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                error != null -> Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(12.dp))
                valueText != null -> Text(
                    valueText,
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.fillMaxSize().padding(12.dp).verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()),
                )
            }
        }
    }
}

@Composable
private fun ServerDbBody(
    tables: List<Pair<String, Int?>>,
    selectedTable: String?,
    onSelectTable: (String) -> Unit,
    sql: String,
    onSqlChange: (String) -> Unit,
    onRunSql: () -> Unit,
    loading: Boolean,
    error: String?,
    rowPage: ToolDbRowPage?,
    queryResult: ToolDbQueryResult?,
    orderBy: String?,
    dir: String,
    onSort: (String) -> Unit,
    onPrev: () -> Unit,
    onNext: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            tables.forEach { (name, count) ->
                FilterChip(
                    selected = name == selectedTable,
                    onClick = { onSelectTable(name) },
                    label = { Text(if (count != null) "$name ($count)" else name) },
                )
            }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = sql,
                onValueChange = onSqlChange,
                modifier = Modifier.weight(1f),
                placeholder = { Text("SELECT … (read-only)") },
                singleLine = true,
                shape = MaterialTheme.shapes.medium,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { onRunSql() }),
            )
            Button(onClick = onRunSql, enabled = sql.isNotBlank(), shape = MaterialTheme.shapes.medium) { Text("Run") }
        }

        if (error != null) {
            Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 8.dp))
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                loading && rowPage == null && queryResult == null -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                queryResult != null -> {
                    val q = queryResult
                    Column {
                        Text(
                            if (q.truncated) "${q.rowCount} rows (truncated — refine the query to see more)"
                            else "${q.rowCount} row${if (q.rowCount == 1) "" else "s"}",
                            style = MaterialTheme.typography.labelSmall,
                            color = AppAccents.textSecondary,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        )
                        DataGrid(q.columns.map { ToolDbColumn(it, "", false, false) }, q.rows, null, "asc", null)
                    }
                }
                rowPage != null -> {
                    val p = rowPage
                    Column {
                        DataGrid(p.columns, p.rows, orderBy, dir, onSort)
                    }
                }
                else -> {}
            }
        }

        rowPage?.let { p ->
            val from = if (p.total == 0) 0 else p.offset + 1
            val to = minOf(p.offset + p.limit, p.total)
            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onPrev, enabled = p.offset > 0) { Text("← Prev") }
                Text("$from–$to of ${p.total}", style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
                TextButton(onClick = onNext, enabled = to < p.total) { Text("Next →") }
            }
        }
    }
}

@Composable
private fun DataGrid(
    columns: List<ToolDbColumn>,
    rows: List<Map<String, JsonElement>>,
    orderBy: String?,
    dir: String,
    onSort: ((String) -> Unit)?,
) {
    if (rows.isEmpty()) {
        Text("No rows.", style = MaterialTheme.typography.bodyMedium, color = AppAccents.textSecondary, modifier = Modifier.padding(16.dp))
        return
    }
    val cellWidth = 130.dp
    Box(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
        Column {
            Row(Modifier.background(MaterialTheme.colorScheme.surfaceVariant)) {
                columns.forEach { col ->
                    Row(
                        Modifier.width(cellWidth).padding(horizontal = 8.dp, vertical = 8.dp)
                            .let { m -> if (onSort != null) m.clickableRow { onSort(col.name) } else m },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            col.name + if (col.pk) " 🔑" else "",
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (orderBy == col.name) Text(if (dir == "asc") " ▲" else " ▼", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            LazyColumn {
                items(rows) { row ->
                    Row {
                        columns.forEach { col ->
                            val v = row[col.name]
                            Text(
                                v?.let(::displayString) ?: "NULL",
                                style = MaterialTheme.typography.bodySmall,
                                color = if (v == null || v is JsonNull) AppAccents.textSecondary else MaterialTheme.colorScheme.onSurface,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.width(cellWidth).padding(horizontal = 8.dp, vertical = 6.dp),
                            )
                        }
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f))
                }
            }
        }
    }
}

@Composable
private fun EmptyState(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = AppAccents.textSecondary,
            modifier = Modifier.padding(32.dp),
        )
    }
}

private fun Modifier.clickableRow(onClick: () -> Unit): Modifier = this.clickable(onClick = onClick)

/** Mirrors desktop's `renderDbGrid` cell rendering: null, a blob marker
 *  object (`{ __blob: true, bytes, preview }`), or a plain value. */
private fun displayString(v: JsonElement): String = when {
    v is JsonNull -> "NULL"
    v is JsonObject && (v["__blob"] as? JsonPrimitive)?.booleanOrNull == true -> {
        val bytes = (v["bytes"] as? JsonPrimitive)?.long ?: 0L
        "‹blob $bytes B›"
    }
    v is JsonPrimitive && v.isString -> v.content
    v is JsonPrimitive -> v.content
    else -> v.toString()
}

private fun prettyJson(v: JsonElement): String =
    prettyJsonFormat.encodeToString(JsonElement.serializer(), v)

private fun fmtBytes(n: Int): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "%.1f KB".format(n / 1024.0)
    else -> "%.1f MB".format(n / (1024.0 * 1024.0))
}
