package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.School
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.SaveSkillRequest
import app.familyagent.android.data.Skill
import app.familyagent.android.ui.theme.AppAccents

// A skill is a markdown playbook agent-core stores under <dataDir>/skills/<name>/;
// the assistant loads one into a turn with use_skill. This screen is a thin CRUD
// wrapper over /skills — everyone can read, only admins can edit.

@Composable
fun SkillsScreen(
    skills: List<Skill>,
    status: String?,
    scriptsRunnable: Boolean,
    isAdmin: Boolean,
    onRefresh: () -> Unit,
    onLoadBody: (String, (String) -> Unit) -> Unit,
    onSave: (SaveSkillRequest, onDone: () -> Unit, onError: (String) -> Unit) -> Unit,
    onDraft: (name: String, description: String, onDraft: (String) -> Unit, onError: (String) -> Unit) -> Unit,
    onSetEnabled: (String, Boolean) -> Unit,
    onDelete: (String) -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }
    var sheetFor by remember { mutableStateOf<SkillSheetTarget?>(null) }
    var confirmDelete by remember { mutableStateOf<Skill?>(null) }

    ScreenScaffold(
        title = "Skills",
        subtitle = "Named playbooks you teach the assistant — step-by-step instructions it follows for a recurring family task.",
    ) {
        if (isAdmin) {
            Button(
                onClick = { sheetFor = SkillSheetTarget.New },
                shape = MaterialTheme.shapes.medium,
                contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
            ) { Text("New skill") }
            Spacer(Modifier.height(12.dp))
        }

        status?.let {
            Text(it, style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
            Spacer(Modifier.height(8.dp))
        }

        if (skills.isEmpty()) {
            EmptyState(
                text = if (isAdmin) "No skills yet. Add one to teach the assistant a repeatable task."
                else "No skills yet.",
                icon = {
                    Icon(
                        Icons.Rounded.School,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(skills, key = { it.name }) { s ->
                    SkillCard(
                        skill = s,
                        scriptsRunnable = scriptsRunnable,
                        isAdmin = isAdmin,
                        onToggle = { onSetEnabled(s.name, !s.enabled) },
                        onEdit = { sheetFor = SkillSheetTarget.Edit(s) },
                        onDelete = { confirmDelete = s },
                    )
                }
            }
        }
    }

    sheetFor?.let { target ->
        val existing = (target as? SkillSheetTarget.Edit)?.skill
        SkillSheet(
            existing = existing,
            onLoadBody = onLoadBody,
            onDraft = onDraft,
            onDismiss = { sheetFor = null },
            onSave = { req, onError -> onSave(req, { sheetFor = null }, onError) },
        )
    }

    confirmDelete?.let { s ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete skill?") },
            text = { Text("\"${s.name}\" will be removed.") },
            confirmButton = { TextButton(onClick = { onDelete(s.name); confirmDelete = null }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

private sealed interface SkillSheetTarget {
    data object New : SkillSheetTarget
    data class Edit(val skill: Skill) : SkillSheetTarget
}

@Composable
private fun SkillCard(
    skill: Skill,
    scriptsRunnable: Boolean,
    isAdmin: Boolean,
    onToggle: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    AppCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (isAdmin) {
                Switch(checked = skill.enabled, onCheckedChange = { onToggle() })
                Spacer(Modifier.width(10.dp))
            }
            Text(
                skill.name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (skill.description.isNotBlank()) {
            Spacer(Modifier.height(6.dp))
            Text(skill.description, style = MaterialTheme.typography.bodyMedium)
        }
        skill.whenToUse?.let {
            Spacer(Modifier.height(4.dp))
            Text("Use when: $it", style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
        }
        if (skill.scripts.isNotEmpty()) {
            Spacer(Modifier.height(4.dp))
            Text(
                "Scripts: ${skill.scripts.joinToString(", ")}" +
                    if (scriptsRunnable) "" else " (script runner unavailable on this server)",
                style = MaterialTheme.typography.labelSmall,
                color = AppAccents.textSecondary,
            )
        }
        if (isAdmin) {
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onEdit) { Text("Edit") }
                TextButton(onClick = onDelete) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SkillSheet(
    existing: Skill?,
    onLoadBody: (String, (String) -> Unit) -> Unit,
    onDraft: (name: String, description: String, onDraft: (String) -> Unit, onError: (String) -> Unit) -> Unit,
    onDismiss: () -> Unit,
    onSave: (SaveSkillRequest, onError: (String) -> Unit) -> Unit,
) {
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var description by remember { mutableStateOf(existing?.description ?: "") }
    var whenToUse by remember { mutableStateOf(existing?.whenToUse ?: "") }
    var markdown by remember { mutableStateOf(if (existing == null) "" else "Loading…") }
    var enabled by remember { mutableStateOf(existing?.enabled ?: true) }
    var error by remember { mutableStateOf<String?>(null) }
    var drafting by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }

    LaunchedEffect(existing?.name) {
        if (existing != null) onLoadBody(existing.name) { markdown = it }
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp)
                .heightIn(max = 640.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(if (existing == null) "New skill" else "Edit skill", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.lowercase().filter { c -> c.isLetterOrDigit() || c == '-' } },
                label = { Text("Name") },
                placeholder = { Text("weekly-meal-plan") },
                singleLine = true,
                enabled = existing == null,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text("Short description") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = whenToUse,
                onValueChange = { whenToUse = it },
                label = { Text("When to use it (optional)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(
                onClick = {
                    if (name.isBlank() || description.length < 3) {
                        error = "Fill in the name and description first."
                        return@OutlinedButton
                    }
                    drafting = true
                    error = null
                    onDraft(name.trim(), description.trim(), { markdown = it; drafting = false }, { error = it; drafting = false })
                },
                enabled = !drafting,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(if (drafting) "Drafting…" else "Draft with AI from the description") }
            OutlinedTextField(
                value = markdown,
                onValueChange = { markdown = it },
                label = { Text("Instructions (Markdown)") },
                minLines = 6,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = enabled, onCheckedChange = { enabled = it })
                Spacer(Modifier.width(10.dp))
                Text("Enabled", style = MaterialTheme.typography.bodyMedium)
            }
            error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onDismiss, modifier = Modifier.weight(1f)) { Text("Cancel") }
                Button(
                    onClick = {
                        val n = name.trim()
                        if (!Regex("^[a-z0-9][a-z0-9-]*$").matches(n)) {
                            error = "Name: lowercase letters, digits and hyphens only."
                            return@Button
                        }
                        if (markdown.isBlank() || markdown == "Loading…") {
                            error = "Write some instructions."
                            return@Button
                        }
                        saving = true
                        error = null
                        onSave(
                            SaveSkillRequest(
                                name = n,
                                description = description.trim().ifBlank { null },
                                whenToUse = whenToUse.trim().ifBlank { null },
                                enabled = enabled,
                                markdown = markdown.trim(),
                            ),
                        ) { msg -> saving = false; error = msg }
                    },
                    enabled = !saving,
                    modifier = Modifier.weight(1f),
                ) { Text(if (existing == null) "Create" else "Save") }
            }
        }
    }
}
