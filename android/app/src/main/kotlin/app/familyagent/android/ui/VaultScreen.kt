package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.CreateVaultEntryRequest
import app.familyagent.android.data.UpdateVaultEntryRequest
import app.familyagent.android.data.VaultAccessLogEntry
import app.familyagent.android.data.VaultEntry
import app.familyagent.android.data.VaultEntryDetail
import app.familyagent.android.data.VaultStatus
import app.familyagent.android.ui.theme.AppAccents
import kotlinx.coroutines.delay

// The password vault. All crypto is server-side (agent-core/src/vault); this
// screen just shows the unlock gate, the entry list, and a decrypted detail
// sheet. See android/DESIGN.md and docs/DECISIONS.md → "Password vault".

@Composable
fun VaultScreen(
    enabled: Boolean,
    status: VaultStatus?,
    entries: List<VaultEntry>,
    detail: VaultEntryDetail?,
    accessLog: List<VaultAccessLogEntry>,
    recoveryCode: String?,
    statusMsg: String?,
    isAdmin: Boolean,
    onRefresh: () -> Unit,
    onSetup: (String) -> Unit,
    onUnlock: (String) -> Unit,
    onLock: () -> Unit,
    onRecover: (code: String, password: String) -> Unit,
    onFamilySync: () -> Unit,
    onDismissRecoveryCode: () -> Unit,
    onOpenEntry: (String) -> Unit,
    onCloseEntry: () -> Unit,
    onSave: (id: String?, CreateVaultEntryRequest?, UpdateVaultEntryRequest?, onDone: () -> Unit, onError: (String) -> Unit) -> Unit,
    onDelete: (String) -> Unit,
    onLoadAccessLog: () -> Unit,
    getTotp: suspend (String) -> Pair<String, Int>?,
) {
    LaunchedEffect(Unit) { onRefresh() }

    ScreenScaffold(
        title = "Vault",
        subtitle = "Passwords and two-factor codes for the family — encrypted on the home server. Ask the assistant for one in a private “/vault” chat.",
    ) {
        if (!enabled) {
            EmptyState("The password vault isn't turned on for this server.")
            return@ScreenScaffold
        }
        if (recoveryCode != null) {
            RecoveryCodeCard(recoveryCode, onDismissRecoveryCode)
            return@ScreenScaffold
        }
        val s = status
        if (s == null) {
            Text("Loading…", color = AppAccents.textSecondary)
            return@ScreenScaffold
        }
        when {
            !s.exists -> VaultGate(
                heading = "Set up your vault",
                blurb = "Your vault is encrypted with a key from your account password. Confirm it to create the vault — you'll get a one-time recovery code.",
                actionLabel = "Create vault",
                statusMsg = statusMsg,
                onSubmit = onSetup,
            )
            !s.unlocked -> VaultUnlockGate(statusMsg, onUnlock, onRecover)
            else -> VaultUnlocked(
                status = s,
                entries = entries,
                detail = detail,
                accessLog = accessLog,
                statusMsg = statusMsg,
                isAdmin = isAdmin,
                onLock = onLock,
                onFamilySync = onFamilySync,
                onOpenEntry = onOpenEntry,
                onCloseEntry = onCloseEntry,
                onSave = onSave,
                onDelete = onDelete,
                onLoadAccessLog = onLoadAccessLog,
                getTotp = getTotp,
            )
        }
    }
}

@Composable
private fun RecoveryCodeCard(code: String, onDone: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    AppCard(accent = MaterialTheme.colorScheme.primary) {
        Text("Save your recovery code", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(6.dp))
        Text(
            "If you forget your password (or an admin resets it) this is the ONLY way back into your vault. Write it down now — it isn't shown again.",
            style = MaterialTheme.typography.bodySmall,
            color = AppAccents.textSecondary,
        )
        Spacer(Modifier.height(14.dp))
        Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.small) {
            Text(
                code,
                modifier = Modifier.fillMaxWidth().padding(14.dp),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.titleMedium,
            )
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { clipboard.setText(AnnotatedString(code)) }) { Text("Copy") }
            Button(onClick = onDone) { Text("I've saved it") }
        }
    }
}

@Composable
private fun VaultGate(
    heading: String,
    blurb: String,
    actionLabel: String,
    statusMsg: String?,
    onSubmit: (String) -> Unit,
) {
    var pw by remember { mutableStateOf("") }
    AppCard {
        Icon(Icons.Rounded.Lock, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.height(8.dp))
        Text(heading, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(6.dp))
        Text(blurb, style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = pw,
            onValueChange = { pw = it },
            label = { Text("Your account password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        statusMsg?.let {
            Spacer(Modifier.height(6.dp))
            Text(it, style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
        }
        Spacer(Modifier.height(12.dp))
        Button(onClick = { onSubmit(pw) }, enabled = pw.isNotBlank()) { Text(actionLabel) }
    }
}

@Composable
private fun VaultUnlockGate(
    statusMsg: String?,
    onUnlock: (String) -> Unit,
    onRecover: (String, String) -> Unit,
) {
    var recovering by remember { mutableStateOf(false) }
    if (!recovering) {
        Column {
            VaultGate(
                heading = "Vault locked",
                blurb = "Enter your account password to unlock the vault for this session. It re-locks after 15 minutes idle.",
                actionLabel = "Unlock",
                statusMsg = statusMsg,
                onSubmit = onUnlock,
            )
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = { recovering = true }) { Text("Use a recovery code instead") }
        }
    } else {
        var code by remember { mutableStateOf("") }
        var pw by remember { mutableStateOf("") }
        AppCard {
            Text("Recover your vault", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(6.dp))
            Text(
                "Enter your recovery code and current account password. The vault re-secures under that password and you get a fresh code.",
                style = MaterialTheme.typography.bodySmall,
                color = AppAccents.textSecondary,
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(code, { code = it }, label = { Text("Recovery code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                pw, { pw = it }, label = { Text("Account password") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                modifier = Modifier.fillMaxWidth(),
            )
            statusMsg?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { recovering = false }) { Text("Back") }
                Button(onClick = { onRecover(code, pw) }, enabled = code.isNotBlank() && pw.isNotBlank()) { Text("Recover") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VaultUnlocked(
    status: VaultStatus,
    entries: List<VaultEntry>,
    detail: VaultEntryDetail?,
    accessLog: List<VaultAccessLogEntry>,
    statusMsg: String?,
    isAdmin: Boolean,
    onLock: () -> Unit,
    onFamilySync: () -> Unit,
    onOpenEntry: (String) -> Unit,
    onCloseEntry: () -> Unit,
    onSave: (id: String?, CreateVaultEntryRequest?, UpdateVaultEntryRequest?, onDone: () -> Unit, onError: (String) -> Unit) -> Unit,
    onDelete: (String) -> Unit,
    onLoadAccessLog: () -> Unit,
    getTotp: suspend (String) -> Pair<String, Int>?,
) {
    var query by remember { mutableStateOf("") }
    var editorFor by remember { mutableStateOf<EditorTarget?>(null) }
    var showLog by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf<VaultEntryDetail?>(null) }

    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = { editorFor = EditorTarget.New }, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp)) {
            Text("New entry")
        }
        OutlinedButton(onClick = onLock, contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp)) { Text("Lock") }
        TextButton(onClick = { showLog = true; onLoadAccessLog() }) { Text("Access log") }
    }
    if (isAdmin && status.familyVaultInitialised) {
        TextButton(onClick = onFamilySync) { Text("Grant shared-vault access to everyone") }
    }
    if (!status.hasSharedAccess) {
        Text(
            if (isAdmin) "You don't have shared-vault access yet — tap “Grant shared access”."
            else "You don't have shared-vault access yet — ask a family admin.",
            style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary,
        )
    }
    statusMsg?.let {
        Spacer(Modifier.height(4.dp))
        Text(it, style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
    }
    Spacer(Modifier.height(10.dp))
    OutlinedTextField(
        query, { query = it }, label = { Text("Search entries") }, singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(10.dp))

    val shown = remember(entries, query) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) entries
        else entries.filter {
            listOf(it.title, it.username ?: "", it.url ?: "", it.folder ?: "").any { f -> f.lowercase().contains(q) }
        }
    }

    if (shown.isEmpty()) {
        EmptyState(if (entries.isEmpty()) "No entries yet. Add your first with “New entry”." else "Nothing matches that search.")
    } else {
        Column(
            Modifier.verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            for (e in shown) {
                AppCard(onClick = { onOpenEntry(e.id) }) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(e.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val sub = e.username ?: e.url ?: ""
                            if (sub.isNotBlank()) {
                                Text(sub, style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        if (e.scope == "shared") Chip("shared")
                        if (e.hasTotp) {
                            Spacer(Modifier.width(4.dp))
                            Chip("2FA")
                        }
                    }
                }
            }
            Spacer(Modifier.height(40.dp))
        }
    }

    if (detail != null) {
        VaultDetailSheet(
            detail = detail,
            onDismiss = onCloseEntry,
            onEdit = { editorFor = EditorTarget.Edit(detail) },
            onDelete = { confirmDelete = detail },
            getTotp = getTotp,
        )
    }

    editorFor?.let { target ->
        VaultEditorSheet(
            existing = (target as? EditorTarget.Edit)?.entry,
            canShare = status.hasSharedAccess,
            onDismiss = { editorFor = null },
            onSave = onSave,
        )
    }

    confirmDelete?.let { d ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete “${d.title}”?") },
            text = { Text("This can't be undone.") },
            confirmButton = {
                TextButton(onClick = { onDelete(d.id); confirmDelete = null }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }

    if (showLog) {
        VaultAccessLogSheet(accessLog) { showLog = false }
    }
}

private sealed interface EditorTarget {
    data object New : EditorTarget
    data class Edit(val entry: VaultEntryDetail) : EditorTarget
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VaultDetailSheet(
    detail: VaultEntryDetail,
    onDismiss: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    getTotp: suspend (String) -> Pair<String, Int>?,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp).verticalScroll(rememberScrollState())) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(detail.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                if (detail.scope == "shared") Chip("shared")
            }
            Spacer(Modifier.height(12.dp))
            detail.folder?.let { VaultFieldRow("Folder", it) }
            detail.username?.let { VaultFieldRow("Username", it, copyable = true) }
            detail.url?.let { VaultFieldRow("Website", it, copyable = true) }
            detail.secret.password?.let { VaultFieldRow("Password", it, secret = true, copyable = true) }
            if (detail.hasTotp) {
                var totp by remember { mutableStateOf<Pair<String, Int>?>(null) }
                LaunchedEffect(detail.id) {
                    while (true) {
                        totp = getTotp(detail.id)
                        delay(1000)
                    }
                }
                VaultFieldRow(
                    "2FA code",
                    totp?.let { "${it.first}   (${it.second}s)" } ?: "······",
                    copyable = totp != null,
                    copyText = totp?.first,
                )
            }
            detail.secret.notes?.let { VaultFieldRow("Notes", it) }
            for (f in detail.secret.fields) VaultFieldRow(f.label, f.value, secret = f.secret, copyable = true)
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onEdit) { Text("Edit") }
                TextButton(onClick = onDelete) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

@Composable
private fun VaultFieldRow(
    label: String,
    value: String,
    secret: Boolean = false,
    copyable: Boolean = false,
    copyText: String? = null,
) {
    val clipboard = LocalClipboardManager.current
    var revealed by remember { mutableStateOf(!secret) }
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label.uppercase(), style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
            Text(
                if (revealed) value else "•".repeat(10),
                style = MaterialTheme.typography.bodyMedium,
                fontFamily = if (secret || label == "2FA code") FontFamily.Monospace else FontFamily.Default,
            )
        }
        if (secret) {
            TextButton(onClick = { revealed = !revealed }) { Text(if (revealed) "Hide" else "Show") }
        }
        if (copyable) {
            TextButton(onClick = { clipboard.setText(AnnotatedString(copyText ?: value)) }) { Text("Copy") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VaultEditorSheet(
    existing: VaultEntryDetail?,
    canShare: Boolean,
    onDismiss: () -> Unit,
    onSave: (id: String?, CreateVaultEntryRequest?, UpdateVaultEntryRequest?, onDone: () -> Unit, onError: (String) -> Unit) -> Unit,
) {
    var title by remember { mutableStateOf(existing?.title ?: "") }
    var folder by remember { mutableStateOf(existing?.folder ?: "") }
    var username by remember { mutableStateOf(existing?.username ?: "") }
    var url by remember { mutableStateOf(existing?.url ?: "") }
    var password by remember { mutableStateOf(existing?.secret?.password ?: "") }
    var totpInput by remember { mutableStateOf("") }
    var clearTotp by remember { mutableStateOf(false) }
    var notes by remember { mutableStateOf(existing?.secret?.notes ?: "") }
    var shared by remember { mutableStateOf(existing?.scope == "shared") }
    var error by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(if (existing == null) "New entry" else "Edit entry", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(title, { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(folder, { folder = it }, label = { Text("Folder (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(username, { username = it }, label = { Text("Username / email") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(url, { url = it }, label = { Text("Website") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(password, { password = it }, label = { Text("Password") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(
                totpInput, { totpInput = it },
                label = { Text(if (existing?.hasTotp == true) "Replace 2FA (otpauth:// or secret)" else "2FA setup (otpauth:// or secret)") },
                singleLine = true, modifier = Modifier.fillMaxWidth(),
            )
            if (existing?.hasTotp == true) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(clearTotp, { clearTotp = it })
                    Text("Remove the existing 2FA code")
                }
            }
            OutlinedTextField(notes, { notes = it }, label = { Text("Notes") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            if (existing == null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(shared, { shared = it }, enabled = canShare)
                    Text("Shared with the whole family" + if (!canShare) " (no access yet)" else "")
                }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onDismiss) { Text("Cancel") }
                Button(
                    enabled = title.isNotBlank(),
                    onClick = {
                        error = null
                        fun nn(s: String) = s.trim().ifBlank { null }
                        if (existing == null) {
                            onSave(
                                null,
                                CreateVaultEntryRequest(
                                    scope = if (shared) "shared" else "private",
                                    title = title.trim(),
                                    folder = nn(folder), username = nn(username), url = nn(url),
                                    password = nn(password), totpInput = nn(totpInput), notes = nn(notes),
                                ),
                                null, onDismiss, { error = it },
                            )
                        } else {
                            onSave(
                                existing.id, null,
                                UpdateVaultEntryRequest(
                                    title = title.trim(),
                                    folder = folder.trim(), username = username.trim(), url = url.trim(),
                                    password = password.trim(),
                                    totpInput = nn(totpInput),
                                    clearTotp = if (clearTotp) true else null,
                                    notes = notes.trim(),
                                ),
                                onDismiss, { error = it },
                            )
                        }
                    },
                ) { Text("Save") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VaultAccessLogSheet(entries: List<VaultAccessLogEntry>, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp).verticalScroll(rememberScrollState())) {
            Text("Access log", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(6.dp))
            Text(
                "Every time a password or 2FA code was read — by you or by the assistant.",
                style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary,
            )
            Spacer(Modifier.height(12.dp))
            if (entries.isEmpty()) {
                Text("Nothing yet.", color = AppAccents.textSecondary)
            } else {
                for (e in entries) {
                    val who = if (e.actor == "vault-agent") "Assistant" else "You"
                    val verb = when (e.action) {
                        "reveal_password" -> "revealed the password for"
                        "reveal_totp" -> "read the 2FA code for"
                        "create" -> "added"
                        "update" -> "edited"
                        "delete" -> "removed"
                        else -> e.action
                    }
                    Text(
                        "$who $verb “${e.entryTitle}”",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(vertical = 4.dp),
                    )
                }
            }
        }
    }
}
