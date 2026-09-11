package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.DiscoveredServer
import app.familyagent.android.data.RecentServer
import app.familyagent.android.data.ServerDiscovery
import app.familyagent.android.ui.theme.AppAccents
import kotlinx.coroutines.flow.collectLatest

/**
 * First screen when nobody's signed in: scans the LAN for Family Agent master
 * nodes (mDNS, via [ServerDiscovery]) and lets the user pick one, or type an
 * address by hand.
 */
@Composable
fun DiscoveryScreen(
    discovery: ServerDiscovery,
    recentServers: List<RecentServer> = emptyList(),
    onPick: (String) -> Unit,
) {
    var servers by remember { mutableStateOf<List<DiscoveredServer>>(emptyList()) }
    var manual by remember { mutableStateOf(ServerDiscovery.manualEntryDefault) }
    var showManual by remember { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(true) }
    var tailscaleActive by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        tailscaleActive = ServerDiscovery.tailscaleLikelyActive()
        discovery.discover().collectLatest { servers = it }
    }
    // The scan (mDNS + an active address probe) settles within a few seconds.
    LaunchedEffect(Unit) {
        kotlinx.coroutines.delay(6000)
        scanning = false
    }

    ScreenScaffold(
        title = "Find your home",
        subtitle = "Choose the Family Agent server running on your home laptop.",
        modifier = Modifier.verticalScroll(rememberScrollState()),
        hasMenuButton = false,
    ) {
        // A server this device connected to before — the actual fix for
        // Tailscale/off-LAN addresses, which the scan below can never
        // rediscover on its own (see ServerDiscovery.tailscaleLikelyActive).
        if (recentServers.isNotEmpty()) {
            Text("Recent", style = MaterialTheme.typography.labelLarge, color = AppAccents.textSecondary)
            Spacer(Modifier.height(6.dp))
            recentServers.forEach { server ->
                AppCard(onClick = { onPick(server.url) }) {
                    Text(server.name, style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(2.dp))
                    Text(server.url, style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
                }
                Spacer(Modifier.height(10.dp))
            }
            Spacer(Modifier.height(8.dp))
        }

        if (servers.isEmpty()) {
            AppCard {
                if (scanning) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(12.dp))
                        Text("Looking for your home server…", style = MaterialTheme.typography.bodyMedium)
                    }
                } else {
                    Text(
                        if (tailscaleActive)
                            "Tailscale looks active on this device. Automatic scan only ever sees the Wi-Fi " +
                                "this device is on — it can't find a server that's only reachable over Tailscale, " +
                                "even on the same tailnet. Enter the Tailscale address from the desktop's " +
                                "“Pair a phone” panel below; once it works it's remembered here as “Recent”."
                        else
                            "No server found automatically. If the home laptop is on and running Family Agent, " +
                                "enter its address below — your Wi-Fi may be blocking discovery.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        } else {
            servers.forEach { server ->
                AppCard(onClick = { onPick(server.url) }) {
                    Text(server.name, style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(2.dp))
                    Text(server.url, style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
                }
                Spacer(Modifier.height(10.dp))
            }
        }

        Spacer(Modifier.height(18.dp))
        val manualOpen = showManual || (!scanning && servers.isEmpty())
        TextButton(onClick = { showManual = !manualOpen }) {
            Text(if (manualOpen) "Hide manual entry" else "Enter an address manually")
        }
        if (manualOpen) {
            OutlinedTextField(
                value = manual,
                onValueChange = { manual = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Server address") },
                placeholder = { Text(ServerDiscovery.manualEntryDefault) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                shape = MaterialTheme.shapes.medium,
            )
            Spacer(Modifier.height(10.dp))
            Button(
                onClick = { onPick(manual) },
                enabled = manual.isNotBlank(),
                shape = MaterialTheme.shapes.medium,
            ) { Text("Connect") }
        }
    }
}
