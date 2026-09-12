package app.familyagent.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Group
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.User
import app.familyagent.android.ui.theme.AppAccents

// Admin-only account management — mirrors desktop's #view-family (add a
// member, reset a password, remove an account). Gated on isAdmin at the
// drawer level, same shape as Connections/Vault.

@Composable
fun FamilyScreen(
    accounts: List<User>,
    status: String?,
    selfId: String?,
    onRefresh: () -> Unit,
    onAdd: (username: String, displayName: String, password: String, role: String) -> Unit,
    onResetPassword: (id: String, password: String) -> Unit,
    onRemove: (id: String) -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }
    var showAdd by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<User?>(null) }

    ScreenScaffold(
        title = "Family",
        subtitle = "Accounts on this home server. Each one keeps its own tasks, documents, and history.",
    ) {
        Button(
            onClick = { showAdd = true },
            shape = MaterialTheme.shapes.medium,
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
        ) { Text("Add a family member") }
        Spacer(Modifier.height(12.dp))

        status?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
            Spacer(Modifier.height(8.dp))
        }

        if (accounts.isEmpty()) {
            EmptyState(
                text = "Loading accounts…",
                icon = {
                    Icon(
                        Icons.Rounded.Group,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(accounts, key = { it.id }) { user ->
                    FamilyMemberCard(
                        user = user,
                        isSelf = user.id == selfId,
                        onResetPassword = { pw -> onResetPassword(user.id, pw) },
                        onRemove = { confirmDelete = user },
                    )
                }
            }
        }
    }

    if (showAdd) {
        AddFamilyMemberSheet(
            onDismiss = { showAdd = false },
            onAdd = { username, displayName, password, role ->
                onAdd(username, displayName, password, role)
                showAdd = false
            },
        )
    }

    confirmDelete?.let { u ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Remove ${u.displayName}?") },
            text = { Text("Their events, documents, and history are deleted. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = { onRemove(u.id); confirmDelete = null }) {
                    Text("Remove", color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

private fun initials(name: String): String {
    val parts = name.split(" ").filter { it.isNotBlank() }
    return when {
        parts.isEmpty() -> "?"
        parts.size == 1 -> parts[0].take(2).uppercase()
        else -> "${parts.first().take(1)}${parts.last().take(1)}".uppercase()
    }
}

@Composable
private fun FamilyMemberCard(
    user: User,
    isSelf: Boolean,
    onResetPassword: (String) -> Unit,
    onRemove: () -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }
    var showReset by remember { mutableStateOf(false) }

    AppCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    initials(user.displayName),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(user.displayName, style = MaterialTheme.typography.titleMedium)
                    if (isSelf) {
                        Spacer(Modifier.width(6.dp))
                        AssistChip(onClick = {}, label = { Text("You") }, enabled = false)
                    }
                    Spacer(Modifier.width(6.dp))
                    AssistChip(onClick = {}, label = { Text(if (user.role == "admin") "Admin" else "Member") }, enabled = false)
                }
                Text("@${user.username}", style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
            }
            if (!isSelf) {
                Box {
                    IconButton(onClick = { showMenu = true }) {
                        Icon(Icons.Rounded.MoreVert, contentDescription = "Options")
                    }
                    DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                        DropdownMenuItem(
                            text = { Text("Reset password") },
                            onClick = { showMenu = false; showReset = true },
                        )
                        DropdownMenuItem(
                            text = { Text("Remove", color = MaterialTheme.colorScheme.error) },
                            onClick = { showMenu = false; onRemove() },
                        )
                    }
                }
            }
        }
    }

    if (showReset) {
        var newPassword by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { showReset = false },
            title = { Text("New password for ${user.displayName}") },
            text = {
                Column {
                    Text("They'll need this the next time they sign in.", style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = newPassword,
                        onValueChange = { newPassword = it },
                        label = { Text("6+ characters") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (newPassword.length >= 6) onResetPassword(newPassword)
                        showReset = false
                    },
                ) { Text("Reset") }
            },
            dismissButton = { TextButton(onClick = { showReset = false }) { Text("Cancel") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddFamilyMemberSheet(
    onDismiss: () -> Unit,
    onAdd: (username: String, displayName: String, password: String, role: String) -> Unit,
) {
    var displayName by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var role by remember { mutableStateOf("member") }
    var error by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("Add family member", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                value = displayName,
                onValueChange = { displayName = it },
                label = { Text("Name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("Username") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("Temporary password (6+ chars)") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                listOf("member" to "Member", "admin" to "Admin").forEachIndexed { i, (value, label) ->
                    SegmentedButton(
                        selected = role == value,
                        onClick = { role = value },
                        shape = SegmentedButtonDefaults.itemShape(i, 2),
                    ) { Text(label) }
                }
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onDismiss, modifier = Modifier.weight(1f)) { Text("Cancel") }
                Button(
                    onClick = {
                        val name = displayName.trim()
                        val uname = username.trim()
                        if (name.isEmpty() || uname.isEmpty() || password.length < 6) {
                            error = "Name, username, and a 6+ character password are all required."
                            return@Button
                        }
                        onAdd(uname, name, password, role)
                    },
                    modifier = Modifier.weight(1f),
                ) { Text("Add") }
            }
        }
    }
}
