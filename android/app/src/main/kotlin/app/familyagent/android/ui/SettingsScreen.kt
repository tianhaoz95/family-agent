package app.familyagent.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.familyagent.android.ConnectionStatus

@Composable
fun SettingsScreen(
    serverUrl: String,
    connection: ConnectionStatus,
    onSave: (String) -> Unit,
) {
    var draft by remember(serverUrl) { mutableStateOf(serverUrl) }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Settings", style = MaterialTheme.typography.titleLarge)
        Text(
            "Point this at the Family Agent desktop app on your home network.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))

        Text("Desktop server address", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("http://192.168.1.2:4173") },
            singleLine = true,
        )
        Spacer(Modifier.height(8.dp))
        Button(onClick = { onSave(draft) }, enabled = draft.isNotBlank()) { Text("Save & reconnect") }

        Spacer(Modifier.height(20.dp))
        ConnectionStatusRow(connection)

        Spacer(Modifier.height(20.dp))
        Text(
            "Direct LAN address only for now — Tailscale/relay discovery is future work " +
                "(see docs/DECISIONS.md).",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ConnectionStatusRow(connection: ConnectionStatus) {
    val (label, color) = when (connection) {
        is ConnectionStatus.Connecting -> "Connecting…" to MaterialTheme.colorScheme.onSurfaceVariant
        is ConnectionStatus.Connected -> "Connected · local · ${connection.model}" to MaterialTheme.colorScheme.tertiary
        is ConnectionStatus.Unreachable -> "Unreachable: ${connection.message}" to MaterialTheme.colorScheme.error
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(color, shape = CircleShape))
        Spacer(Modifier.width(8.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = color)
    }
}
