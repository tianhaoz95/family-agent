package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.familyagent.android.ConnectionStatus
import app.familyagent.android.ui.theme.AppAccents

@Composable
fun SettingsScreen(
    serverUrl: String,
    connection: ConnectionStatus,
    onSave: (String) -> Unit,
) {
    var draft by remember(serverUrl) { mutableStateOf(serverUrl) }

    ScreenScaffold(
        title = "Settings",
        subtitle = "Point this at the Family Agent desktop app on your home network.",
    ) {
        AppCard {
            ConnectionStatusRow(connection)
        }

        Spacer(Modifier.height(18.dp))
        SectionLabel("Desktop server address")
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

        Spacer(Modifier.height(24.dp))
        Text(
            "Direct LAN address only for now — Tailscale / relay discovery is future work " +
                "(see docs/DECISIONS.md).",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
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
