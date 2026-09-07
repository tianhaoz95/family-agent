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
    userName: String,
    userRole: String,
    ttsEnabled: Boolean = false,
    autoRead: Boolean = false,
    onSetAutoRead: (Boolean) -> Unit = {},
    onSave: (String) -> Unit,
    onSignOut: () -> Unit,
) {
    var draft by remember(serverUrl) { mutableStateOf(serverUrl) }
    var showAdvanced by remember { mutableStateOf(false) }

    ScreenScaffold(
        title = "Settings",
        subtitle = "Your account and this device's connection.",
    ) {
        AppCard {
            ConnectionStatusRow(connection)
        }

        if (ttsEnabled) {
            Spacer(Modifier.height(18.dp))
            SectionLabel("Voice")
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
