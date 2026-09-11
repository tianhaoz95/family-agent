package app.familyagent.android.ui

import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.familyagent.android.ConnectionStatus
import app.familyagent.android.ReplyNotifications
import app.familyagent.android.data.ServerSettings
import app.familyagent.android.ui.theme.AppAccents

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
    serverSettings: ServerSettings? = null,
    onSetCardsEnabled: (Boolean) -> Unit = {},
    onSetVaultEnabled: (Boolean) -> Unit = {},
    onSetWebAccess: (provider: String, url: String?, apiKey: String?, onDone: () -> Unit, onError: (String) -> Unit) -> Unit = { _, _, _, _, _ -> },
    desktopUpdateStatus: app.familyagent.android.data.DesktopUpdateStatus? = null,
    desktopUpdatePolling: Boolean = false,
    onTriggerDesktopUpdate: () -> Unit = {},
    onSetAutoUpdateEnabled: (Boolean) -> Unit = {},
    onSave: (String) -> Unit,
    onSignOut: () -> Unit,
) {
    var draft by remember(serverUrl) { mutableStateOf(serverUrl) }
    var showAdvanced by remember { mutableStateOf(false) }
    var showUpdateConfirm by remember { mutableStateOf(false) }

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

        if (serverSettings != null) {
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
                DropdownMenuItem(text = { Text(label) }, onClick = { provider = value; menuOpen = false })
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
    }

    Spacer(Modifier.height(10.dp))
    Button(
        onClick = {
            status = "Saving…"
            onSetWebAccess(
                provider,
                if (provider == "searxng") url.trim() else null,
                if ((provider == "tavily" || provider == "brave") && apiKey.isNotBlank()) apiKey.trim() else null,
                { status = if (provider == "none") "Off — no internet access." else "On — searching with $provider." },
                { status = it },
            )
        },
        enabled = editable,
        shape = MaterialTheme.shapes.medium,
    ) { Text("Save") }

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
