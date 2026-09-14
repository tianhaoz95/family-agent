package app.familyagent.android.ui

import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.familyagent.android.ConnectionStatus
import app.familyagent.android.ReplyNotifications
import app.familyagent.android.data.ServerSettings
import app.familyagent.android.ui.theme.AppAccents
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.delay
import kotlinx.coroutines.tasks.await

@Composable
fun SettingsScreen(
    serverUrl: String,
    connection: ConnectionStatus,
    userName: String,
    userRole: String,
    ttsEnabled: Boolean = false,
    autoRead: Boolean = false,
    onSetAutoRead: (Boolean) -> Unit = {},
    voiceEnabled: Boolean = false,
    micOnLeft: Boolean = false,
    onSetMicOnLeft: (Boolean) -> Unit = {},
    notifyOnReply: Boolean = true,
    onSetNotifyOnReply: (Boolean) -> Unit = {},
    useLocation: Boolean = false,
    onSetUseLocation: (Boolean) -> Unit = {},
    watchRelayEnabled: Boolean = true,
    onSetWatchRelayEnabled: (Boolean) -> Unit = {},
    serverSettings: ServerSettings? = null,
    onSetCardsEnabled: (Boolean) -> Unit = {},
    onSetVaultEnabled: (Boolean) -> Unit = {},
    onSetWebAccess: (provider: String, url: String?, apiKey: String?, onDone: () -> Unit, onError: (String) -> Unit) -> Unit = { _, _, _, _, _ -> },
    onSetChatRetention: (mode: String, value: Int?, onDone: () -> Unit, onError: (String) -> Unit) -> Unit = { _, _, _, _ -> },
    onSetActivityRetention: (mode: String, value: Int?, onDone: () -> Unit, onError: (String) -> Unit) -> Unit = { _, _, _, _ -> },
    desktopUpdateStatus: app.familyagent.android.data.DesktopUpdateStatus? = null,
    desktopUpdatePolling: Boolean = false,
    onTriggerDesktopUpdate: () -> Unit = {},
    onTriggerDesktopRestart: () -> Unit = {},
    onSetAutoUpdateEnabled: (Boolean) -> Unit = {},
    onSave: (String) -> Unit,
    onSignOut: () -> Unit,
) {
    var draft by remember(serverUrl) { mutableStateOf(serverUrl) }
    var showAdvanced by remember { mutableStateOf(false) }
    var showUpdateConfirm by remember { mutableStateOf(false) }
    var showRestartConfirm by remember { mutableStateOf(false) }

    ScreenScaffold(
        title = "Settings",
        subtitle = "Your account and this device's connection.",
    ) {
        AppCard {
            ConnectionStatusRow(connection)
        }

        if (ttsEnabled || voiceEnabled) {
            Spacer(Modifier.height(18.dp))
            SectionLabel("Voice")
            if (ttsEnabled) {
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = autoRead, onCheckedChange = onSetAutoRead)
                    Spacer(Modifier.width(12.dp))
                    Text(
                        "Read replies aloud automatically",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
            if (voiceEnabled) {
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = micOnLeft, onCheckedChange = onSetMicOnLeft)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            "Microphone button on the left",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurface,
                        )
                        Text(
                            "Puts the hold-to-talk mic left of the text field — handy if you're left-handed. Off = right, next to Send.",
                            style = MaterialTheme.typography.bodySmall,
                            color = AppAccents.textSecondary,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Notifications")
        Spacer(Modifier.height(4.dp))
        val notifyContext = LocalContext.current
        var notifyBlockedHint by remember { mutableStateOf(false) }
        val notifyPermissionLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            notifyBlockedHint = !granted
            onSetNotifyOnReply(granted)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(
                checked = notifyOnReply,
                onCheckedChange = { want ->
                    if (want && !ReplyNotifications.hasPermission(notifyContext)) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            notifyPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                        } else {
                            notifyBlockedHint = true
                        }
                    } else {
                        notifyBlockedHint = false
                        onSetNotifyOnReply(want)
                    }
                },
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    "Notify when a reply is ready",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    if (notifyBlockedHint)
                        "Notifications are blocked — allow them for Family Agent in system settings."
                    else
                        "A system notification when the assistant finishes replying in Chat, or an " +
                            "@agent reply in a family channel, while you're not looking at it.",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (notifyBlockedHint) MaterialTheme.colorScheme.error else AppAccents.textSecondary,
                )
            }
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Location")
        Spacer(Modifier.height(4.dp))
        val locationContext = LocalContext.current
        var locationBlockedHint by remember { mutableStateOf(false) }
        val locationPermissionLauncher = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            locationBlockedHint = !granted
            onSetUseLocation(granted)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(
                checked = useLocation,
                onCheckedChange = { want ->
                    if (want) {
                        val already = ContextCompat.checkSelfPermission(
                            locationContext, android.Manifest.permission.ACCESS_COARSE_LOCATION,
                        ) == PackageManager.PERMISSION_GRANTED
                        if (already) {
                            locationBlockedHint = false
                            onSetUseLocation(true)
                        } else {
                            locationPermissionLauncher.launch(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                        }
                    } else {
                        locationBlockedHint = false
                        onSetUseLocation(false)
                    }
                },
            )
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    "Let the assistant use my location",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    if (locationBlockedHint)
                        "Location is blocked — allow it for Family Agent in system settings."
                    else
                        "For “near me” questions only — not a stored home address, and never " +
                            "shared in a family conversation.",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (locationBlockedHint) MaterialTheme.colorScheme.error else AppAccents.textSecondary,
                )
            }
        }

        Spacer(Modifier.height(18.dp))
        WatchCompanionSection(
            enabled = watchRelayEnabled,
            onSetEnabled = onSetWatchRelayEnabled,
        )

        if (serverSettings != null) {
            Spacer(Modifier.height(18.dp))
            SectionLabel("History & activity")
            Spacer(Modifier.height(4.dp))
            Text(
                "How much of your own chat history and activity log this server keeps. This is " +
                    "personal to your account — it doesn't affect anyone else's.",
                style = MaterialTheme.typography.bodySmall,
                color = AppAccents.textSecondary,
            )
            Spacer(Modifier.height(10.dp))
            RetentionRow(
                label = "Chat sessions",
                mode = serverSettings.chatRetentionMode,
                value = serverSettings.chatRetentionValue,
                unitWord = "sessions",
                onSave = { mode, value -> onSetChatRetention(mode, value, {}, {}) },
            )
            Spacer(Modifier.height(14.dp))
            RetentionRow(
                label = "Activity log",
                mode = serverSettings.activityRetentionMode,
                value = serverSettings.activityRetentionValue,
                unitWord = "entries",
                onSave = { mode, value -> onSetActivityRetention(mode, value, {}, {}) },
            )

            Spacer(Modifier.height(18.dp))
            SectionLabel("Assistant")
            Spacer(Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(
                    checked = serverSettings.cardsEnabled,
                    onCheckedChange = onSetCardsEnabled,
                    enabled = serverSettings.isAdmin && !serverSettings.envLocked.cardsEnabled,
                )
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        "Show visual cards",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        when {
                            serverSettings.envLocked.cardsEnabled -> "Pinned by the server (FAMILY_AGENT_CARDS)."
                            !serverSettings.isAdmin -> "Only an admin can change this."
                            else -> "Charts, checklists, diagrams the assistant writes and runs in a sealed sandbox. Off = text only."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = AppAccents.textSecondary,
                    )
                }
            }

            Spacer(Modifier.height(18.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(
                    checked = serverSettings.vaultEnabled,
                    onCheckedChange = onSetVaultEnabled,
                    enabled = serverSettings.isAdmin && !serverSettings.envLocked.vaultEnabled,
                )
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(
                        "Password vault",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Text(
                        when {
                            serverSettings.envLocked.vaultEnabled -> "Pinned by the server (FAMILY_AGENT_VAULT)."
                            !serverSettings.isAdmin -> "Only an admin can change this."
                            else -> "An encrypted store for the family's passwords and 2FA codes. Off by default."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = AppAccents.textSecondary,
                    )
                }
            }

            Spacer(Modifier.height(18.dp))
            InternetAccessSection(serverSettings, onSetWebAccess)

            if (serverSettings.isAdmin) {
                Spacer(Modifier.height(18.dp))
                SectionLabel("Host machine")
                Spacer(Modifier.height(4.dp))
                AppCard {
                    Text(
                        "Update & restart the host",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Checks the laptop running Family Agent for a new version, installs it, and restarts — " +
                            "everyone reconnects in a few seconds. Only works while that machine is on.",
                        style = MaterialTheme.typography.bodySmall,
                        color = AppAccents.textSecondary,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(
                        onClick = { showUpdateConfirm = true },
                        enabled = !desktopUpdatePolling,
                        shape = MaterialTheme.shapes.medium,
                    ) { Text("Update & restart") }
                    if (desktopUpdateStatus != null) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            desktopUpdateStatusText(desktopUpdateStatus),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (desktopUpdateStatus.state == "error") MaterialTheme.colorScheme.error else AppAccents.textSecondary,
                        )
                    }
                    Spacer(Modifier.height(14.dp))
                    Text(
                        "If the app seems stuck — a reply that never finishes, a frozen screen — restarting it (with no update needed) can unstick it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = AppAccents.textSecondary,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(
                        onClick = { showRestartConfirm = true },
                        enabled = !desktopUpdatePolling,
                        shape = MaterialTheme.shapes.medium,
                    ) { Text("Restart the host") }
                    Spacer(Modifier.height(14.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Switch(
                            checked = serverSettings.autoUpdateEnabled,
                            onCheckedChange = onSetAutoUpdateEnabled,
                            enabled = serverSettings.isAdmin && !serverSettings.envLocked.autoUpdateEnabled,
                        )
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                "Install updates automatically",
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurface,
                            )
                            Text(
                                when {
                                    serverSettings.envLocked.autoUpdateEnabled -> "Pinned by the server (FAMILY_AGENT_AUTO_UPDATE)."
                                    !serverSettings.isAdmin -> "Only an admin can change this."
                                    else -> "When on, the host laptop checks periodically and installs a new version on its own — no confirmation prompt."
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = AppAccents.textSecondary,
                            )
                        }
                    }
                }
            }
        }

        if (showUpdateConfirm) {
            AlertDialog(
                onDismissRequest = { showUpdateConfirm = false },
                title = { Text("Update & restart the host?") },
                text = {
                    Text(
                        "This restarts the Family Agent server on the host laptop. Everyone using it — " +
                            "on this phone or any other — will reconnect in a few seconds."
                    )
                },
                confirmButton = {
                    TextButton(onClick = { showUpdateConfirm = false; onTriggerDesktopUpdate() }) { Text("Update & restart") }
                },
                dismissButton = { TextButton(onClick = { showUpdateConfirm = false }) { Text("Cancel") } },
            )
        }

        if (showRestartConfirm) {
            AlertDialog(
                onDismissRequest = { showRestartConfirm = false },
                title = { Text("Restart the host?") },
                text = {
                    Text(
                        "This restarts the Family Agent server on the host laptop — no update, just a fresh start. " +
                            "Use this if it seems stuck. Everyone using it will reconnect in a few seconds."
                    )
                },
                confirmButton = {
                    TextButton(onClick = { showRestartConfirm = false; onTriggerDesktopRestart() }) { Text("Restart") }
                },
                dismissButton = { TextButton(onClick = { showRestartConfirm = false }) { Text("Cancel") } },
            )
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Signed in as")
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(userName, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
            if (userRole.isNotBlank()) {
                Spacer(Modifier.width(8.dp))
                Chip(text = userRole)
            }
        }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = onSignOut, shape = MaterialTheme.shapes.medium) { Text("Sign out") }

        Spacer(Modifier.height(24.dp))
        TextButton(onClick = { showAdvanced = !showAdvanced }) {
            Text(if (showAdvanced) "Hide advanced" else "Advanced")
        }
        if (showAdvanced) {
            SectionLabel("Server address")
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier.fillMaxWidth(),
                placeholder = { Text("http://192.168.1.2:4173") },
                singleLine = true,
                shape = MaterialTheme.shapes.medium,
            )
            Spacer(Modifier.height(10.dp))
            Button(
                onClick = { onSave(draft) },
                enabled = draft.isNotBlank(),
                shape = MaterialTheme.shapes.medium,
            ) { Text("Save & reconnect") }
        }
    }
}

private fun desktopUpdateStatusText(s: app.familyagent.android.data.DesktopUpdateStatus): String = when (s.state) {
    "requested" -> "Waiting for the host to pick this up…"
    "checking" -> "Checking for an update…"
    "no-update" -> "Already up to date."
    "downloading" -> s.percent?.let { "Downloading… ${it.toInt()}%" } ?: "Downloading…"
    "installing" -> "Installing…"
    "restarting" -> "Restarting — should be back in a few seconds."
    "error" -> s.message?.let { "Failed: $it" } ?: "Update failed."
    else -> ""
}

private val WEB_PROVIDERS = listOf(
    "none" to "Off",
    "ddg" to "On — DuckDuckGo (no key)",
    "searxng" to "On — SearXNG (self-hosted)",
    "tavily" to "On — Tavily (API key)",
    "brave" to "On — Brave Search (API key)",
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InternetAccessSection(
    s: ServerSettings,
    onSetWebAccess: (provider: String, url: String?, apiKey: String?, onDone: () -> Unit, onError: (String) -> Unit) -> Unit,
) {
    val editable = s.isAdmin && !s.envLocked.webSearchProvider
    var provider by remember(s.webSearchProvider) { mutableStateOf(s.webSearchProvider) }
    var url by remember(s.webSearchUrl) { mutableStateOf(s.webSearchUrl) }
    var apiKey by remember(s.webSearchApiKeySet) { mutableStateOf("") }
    var status by remember { mutableStateOf<String?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    // Skips the very first LaunchedEffect firing below, which happens on
    // initial composition (loading the saved URL into state, not a user
    // edit) — without it, opening this screen would fire a spurious,
    // idempotent save.
    var hasLoaded by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { hasLoaded = true }

    fun save() {
        status = "Saving…"
        onSetWebAccess(
            provider,
            if (provider == "searxng") url.trim() else null,
            if ((provider == "tavily" || provider == "brave") && apiKey.isNotBlank()) apiKey.trim() else null,
            { status = if (provider == "none") "Off — no internet access." else "On — searching with $provider." },
            { status = it },
        )
    }

    SectionLabel("Internet access")
    Spacer(Modifier.height(4.dp))
    Text(
        "Lets the assistant search the web and read pages (the /web command and the " +
            "research helper). Every request is SSRF-guarded, logged in Activity, and never " +
            "followed through a redirect. Off = only what's on this machine.",
        style = MaterialTheme.typography.bodySmall,
        color = AppAccents.textSecondary,
    )
    Spacer(Modifier.height(8.dp))

    ExposedDropdownMenuBox(expanded = menuOpen && editable, onExpandedChange = { if (editable) menuOpen = it }) {
        OutlinedTextField(
            value = WEB_PROVIDERS.firstOrNull { it.first == provider }?.second ?: "Off",
            onValueChange = {},
            readOnly = true,
            enabled = editable,
            label = { Text("Provider") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = menuOpen) },
            modifier = Modifier.fillMaxWidth().menuAnchor(),
        )
        ExposedDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            WEB_PROVIDERS.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        provider = value
                        menuOpen = false
                        // A provider needing no extra info (off / keyless) is
                        // a complete choice on its own — save immediately, no
                        // separate Save button. One needing a URL/key isn't
                        // complete yet; that field's own edit saves instead
                        // (the LaunchedEffect blocks below).
                        if (value != "searxng" && value != "tavily" && value != "brave") save()
                    },
                )
            }
        }
    }

    if (provider == "searxng") {
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            enabled = editable,
            singleLine = true,
            label = { Text("SearXNG URL") },
            placeholder = { Text("http://localhost:8888") },
            modifier = Modifier.fillMaxWidth(),
        )
        // Debounced auto-save: a fresh LaunchedEffect cancels the previous
        // one whenever `url` changes, so typing doesn't save every keystroke.
        LaunchedEffect(url) {
            if (!hasLoaded) return@LaunchedEffect
            delay(700)
            save()
        }
    }
    if (provider == "tavily" || provider == "brave") {
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = apiKey,
            onValueChange = { apiKey = it },
            enabled = editable,
            singleLine = true,
            label = { Text("API key") },
            placeholder = { Text(if (s.webSearchApiKeySet) "A key is saved — type to replace" else "Paste the provider API key") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        LaunchedEffect(apiKey) {
            if (!hasLoaded || apiKey.isBlank()) return@LaunchedEffect
            delay(700)
            save()
        }
    }

    Spacer(Modifier.height(4.dp))
    Text(
        status ?: when {
            s.envLocked.webSearchProvider -> "Pinned by a FAMILY_AGENT_WEB_SEARCH_* env var on the server."
            !s.isAdmin -> "Only an admin can change this."
            s.webEnabled -> "On — searching with ${s.webSearchProvider}."
            else -> "Off — the assistant has no internet access."
        },
        style = MaterialTheme.typography.bodySmall,
        color = AppAccents.textSecondary,
    )
}

private val RETENTION_MODES = listOf(
    "off" to "Keep everything",
    "count" to "Keep the last N",
    "days" to "Keep the last N days",
)

/**
 * One "keep how much" row — used for both chat sessions and the activity
 * log (Settings → "History & activity"), self-service for any signed-in
 * user (not admin-gated, unlike most of the settings around it). Mirrors
 * the desktop Settings page's retention rows and agent-core's
 * `RetentionMode` (`"off" | "count" | "days"`).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RetentionRow(
    label: String,
    mode: String,
    value: Int?,
    unitWord: String,
    onSave: (mode: String, value: Int?) -> Unit,
) {
    var draftMode by remember(mode) { mutableStateOf(mode) }
    var draftValue by remember(value) { mutableStateOf(value?.toString() ?: "") }
    var menuOpen by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    // Skips the very first LaunchedEffect firing below (loading the saved
    // value into state on open, not a user edit) — same guard as
    // InternetAccessSection's `hasLoaded`.
    var hasLoaded by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { hasLoaded = true }

    Text(label, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
    Spacer(Modifier.height(6.dp))

    ExposedDropdownMenuBox(expanded = menuOpen, onExpandedChange = { menuOpen = it }) {
        OutlinedTextField(
            value = RETENTION_MODES.firstOrNull { it.first == draftMode }?.second ?: "Keep everything",
            onValueChange = {},
            readOnly = true,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = menuOpen) },
            modifier = Modifier.fillMaxWidth().menuAnchor(),
        )
        ExposedDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            RETENTION_MODES.forEach { (v, l) ->
                DropdownMenuItem(
                    text = { Text(l) },
                    onClick = {
                        draftMode = v
                        menuOpen = false
                        val n = draftValue.toIntOrNull()
                        when {
                            v == "off" -> { status = "Saving…"; onSave("off", null) }
                            // Switching count<->days with a number already
                            // typed saves right away; switching off "off"
                            // with nothing typed yet waits for the field below.
                            n != null && n > 0 -> { status = "Saving…"; onSave(v, n) }
                        }
                    },
                )
            }
        }
    }

    if (draftMode != "off") {
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = draftValue,
            onValueChange = { draftValue = it.filter(Char::isDigit).take(6) },
            singleLine = true,
            label = { Text(if (draftMode == "count") "How many $unitWord" else "How many days") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )
        // Debounced auto-save, same pattern as InternetAccessSection's URL/key fields.
        LaunchedEffect(draftValue, draftMode) {
            if (!hasLoaded) return@LaunchedEffect
            val n = draftValue.toIntOrNull() ?: return@LaunchedEffect
            if (n <= 0) return@LaunchedEffect
            delay(700)
            status = "Saving…"
            onSave(draftMode, n)
        }
    }

    Spacer(Modifier.height(4.dp))
    Text(
        status ?: when (mode) {
            "count" -> value?.let { "Keeping the last $it $unitWord." } ?: "Pick a number above to turn this on."
            "days" -> value?.let { "Keeping the last $it days." } ?: "Pick a number above to turn this on."
            else -> "Keeping everything — no automatic cleanup."
        },
        style = MaterialTheme.typography.bodySmall,
        color = AppAccents.textSecondary,
    )
}

/**
 * Settings → "Watch companion". `connectedNodeName` is queried directly from
 * [Wearable]'s NodeClient rather than plumbed through [AppViewModel] — this
 * is purely "is a Wear OS device paired and nearby right now", a fact this
 * screen alone cares about, so it's fetched inline the same way the
 * notification/location permission checks above already read `LocalContext`
 * directly. It's Bluetooth connectivity, not app-level pairing: a companion
 * app doesn't need to be signed in (or even opened yet) on the watch side
 * for this to say "connected" — see the enabled toggle's own description for
 * what that connection can actually do.
 */
@Composable
private fun WatchCompanionSection(enabled: Boolean, onSetEnabled: (Boolean) -> Unit) {
    val context = LocalContext.current
    var connectedNodeName by remember { mutableStateOf<String?>(null) }
    var checked by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val nodes = runCatching { Wearable.getNodeClient(context).connectedNodes.await() }.getOrNull()
        connectedNodeName = nodes?.firstOrNull()?.displayName
        checked = true
    }

    SectionLabel("Watch companion")
    Spacer(Modifier.height(4.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(
            when {
                !checked -> AppAccents.textSecondary
                connectedNodeName != null -> AppAccents.success
                else -> AppAccents.textSecondary
            }
        )
        Spacer(Modifier.width(10.dp))
        Text(
            when {
                !checked -> "Checking…"
                connectedNodeName != null -> "Connected · $connectedNodeName"
                else -> "No watch connected"
            },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
    Spacer(Modifier.height(12.dp))
    Row(verticalAlignment = Alignment.CenterVertically) {
        Switch(checked = enabled, onCheckedChange = onSetEnabled)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                "Allow watch access",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
            )
            Text(
                "Lets a paired Wear OS watch open your chat sessions and send messages, relayed " +
                    "through this phone — the watch never talks to the server directly. Off = the " +
                    "watch app shows a turned-off message instead.",
                style = MaterialTheme.typography.bodySmall,
                color = AppAccents.textSecondary,
            )
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun ConnectionStatusRow(connection: ConnectionStatus) {
    val (label, dot) = when (connection) {
        is ConnectionStatus.Connecting -> "Connecting…" to AppAccents.warning
        is ConnectionStatus.Connected -> "Connected · local · ${connection.model}" to AppAccents.success
        is ConnectionStatus.Unreachable -> "Unreachable: ${connection.message}" to MaterialTheme.colorScheme.error
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(dot)
        Spacer(Modifier.width(10.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
    }
}
