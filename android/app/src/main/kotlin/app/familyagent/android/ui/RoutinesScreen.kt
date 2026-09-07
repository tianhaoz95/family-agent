package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.Channel
import app.familyagent.android.data.Routine
import app.familyagent.android.data.RoutineAction
import app.familyagent.android.data.RoutineInput
import app.familyagent.android.data.RoutineRun
import app.familyagent.android.data.RoutineTrigger
import app.familyagent.android.data.RoutineTriggerInput
import app.familyagent.android.ui.theme.AppAccents

// The routine logic — cron math, scheduling, execution — all lives in agent-core
// (agent-core/src/routines.ts). This screen is a thin CRUD wrapper over
// GET/POST/PATCH/DELETE /routines: the schedule picker's friendly fields map 1:1
// to the server's RoutineTriggerInput, which does the parsing and validation.

private val AGENT_OPTIONS = listOf(
    "planner" to "The assistant (anything)",
    "task" to "Events only",
    "document" to "Documents only",
    "notes" to "The board only",
    "tools" to "The family tools only",
)

private enum class SchedKind(val label: String) {
    Daily("Every day"), Weekly("Every week"), Monthly("Every month"),
    EveryHours("Every few hours"), Once("Once"), Cron("Advanced (cron)")
}

private val WEEKDAYS = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
private val HOUR_CHOICES = listOf(1, 2, 3, 4, 6, 8, 12)

@Composable
fun RoutinesScreen(
    routines: List<Routine>,
    status: String?,
    runs: Map<String, List<RoutineRun>>,
    channels: List<Channel>,
    onSave: (id: String?, input: RoutineInput, onDone: () -> Unit, onError: (String) -> Unit) -> Unit,
    onSetEnabled: (String, Boolean) -> Unit,
    onRunNow: (String) -> Unit,
    onDelete: (String) -> Unit,
    onLoadRuns: (String) -> Unit,
    onRefresh: () -> Unit,
) {
    LaunchedEffect(Unit) { onRefresh() }
    var sheetFor by remember { mutableStateOf<SheetTarget?>(null) }
    var confirmDelete by remember { mutableStateOf<Routine?>(null) }

    ScreenScaffold(
        title = "Routines",
        subtitle = "A saved instruction the assistant runs on a schedule — a morning briefing, a bill reminder, a weekly review.",
    ) {
        Button(
            onClick = { sheetFor = SheetTarget.New },
            shape = MaterialTheme.shapes.medium,
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 12.dp),
        ) { Text("New routine") }

        status?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
        }

        Spacer(Modifier.height(16.dp))

        if (routines.isEmpty()) {
            EmptyState(
                text = "No routines yet. Add one, or ask in Chat — \"every morning summarise my day\".",
                icon = {
                    Icon(
                        Icons.Rounded.Schedule,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(routines, key = { it.id }) { r ->
                    RoutineCard(
                        routine = r,
                        runs = runs[r.id],
                        onToggle = { onSetEnabled(r.id, !r.enabled) },
                        onRunNow = { onRunNow(r.id) },
                        onEdit = { sheetFor = SheetTarget.Edit(r) },
                        onDelete = { confirmDelete = r },
                        onExpandRuns = { onLoadRuns(r.id) },
                    )
                }
            }
        }
    }

    sheetFor?.let { target ->
        val existing = (target as? SheetTarget.Edit)?.routine
        RoutineSheet(
            existing = existing,
            channels = channels,
            onDismiss = { sheetFor = null },
            onSave = { input, onError -> onSave(existing?.id, input, { sheetFor = null }, onError) },
        )
    }

    confirmDelete?.let { r ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("Delete routine?") },
            text = { Text("\"${r.name}\" and its run history will be removed.") },
            confirmButton = {
                TextButton(onClick = { onDelete(r.id); confirmDelete = null }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = null }) { Text("Cancel") } },
        )
    }
}

private sealed interface SheetTarget {
    data object New : SheetTarget
    data class Edit(val routine: Routine) : SheetTarget
}

@Composable
private fun RoutineCard(
    routine: Routine,
    runs: List<RoutineRun>?,
    onToggle: () -> Unit,
    onRunNow: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onExpandRuns: () -> Unit,
) {
    var showRuns by remember { mutableStateOf(false) }
    val agentLabel = AGENT_OPTIONS.firstOrNull { it.first == routine.action.agent }?.second ?: routine.action.agent

    AppCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = routine.enabled, onCheckedChange = { onToggle() })
            Spacer(Modifier.width(10.dp))
            Text(
                routine.name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(
            "${routine.triggerText} · $agentLabel",
            style = MaterialTheme.typography.bodySmall,
            color = AppAccents.textSecondary,
        )
        Spacer(Modifier.height(4.dp))
        Text(routine.action.instruction, style = MaterialTheme.typography.bodyMedium)

        Spacer(Modifier.height(8.dp))
        val nextLine = when {
            !routine.enabled -> "Paused"
            routine.nextRunAt != null -> "Next: ${shortWhen(routine.nextRunAt)}"
            else -> "Next: —"
        }
        val lastLine = routine.lastRunAt?.let { last ->
            val verb = if (routine.lastStatus == "ok") "ran" else routine.lastStatus ?: "ran"
            "Last $verb ${shortWhen(last)}"
        }
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(nextLine, style = MaterialTheme.typography.labelSmall, color = AppAccents.textSecondary)
            if (lastLine != null) {
                Text(
                    lastLine,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (routine.lastStatus == "error") MaterialTheme.colorScheme.error else AppAccents.textSecondary,
                )
            }
        }

        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(
                onClick = onRunNow,
                shape = MaterialTheme.shapes.medium,
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
            ) { Text("Run now") }
            TextButton(onClick = onEdit) { Text("Edit") }
            TextButton(onClick = onDelete) { Text("Delete", color = MaterialTheme.colorScheme.error) }
        }

        TextButton(
            onClick = {
                showRuns = !showRuns
                if (showRuns) onExpandRuns()
            },
            contentPadding = PaddingValues(0.dp),
        ) { Text(if (showRuns) "Hide runs" else "Recent runs", style = MaterialTheme.typography.labelMedium) }

        if (showRuns) {
            when {
                runs == null -> Text("Loading…", style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
                runs.isEmpty() -> Text("No runs yet.", style = MaterialTheme.typography.bodySmall, color = AppAccents.textSecondary)
                else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    runs.forEach { run -> RoutineRunRow(run) }
                }
            }
        }
    }
}

@Composable
private fun RoutineRunRow(run: RoutineRun) {
    val mark = when (run.status) {
        "ok" -> "✓"; "error" -> "⚠"; "running" -> "…"; else -> "–"
    }
    val body = when (run.status) {
        "error" -> run.error ?: "failed"
        "running" -> "running…"
        else -> (run.output ?: "").take(400).ifBlank { "(no output)" }
    }
    Column {
        Text(
            "$mark ${shortWhen(run.finishedAt ?: run.startedAt)}",
            style = MaterialTheme.typography.labelSmall,
            color = AppAccents.textSecondary,
        )
        Text(body, style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoutineSheet(
    existing: Routine?,
    channels: List<Channel>,
    onDismiss: () -> Unit,
    onSave: (RoutineInput, onError: (String) -> Unit) -> Unit,
) {
    val start = remember(existing) { decompose(existing) }
    var name by remember { mutableStateOf(existing?.name ?: "") }
    var instruction by remember { mutableStateOf(existing?.action?.instruction ?: "") }
    var agent by remember { mutableStateOf(existing?.action?.agent ?: "planner") }
    var kind by remember { mutableStateOf(start.kind) }
    var time by remember { mutableStateOf(start.time) }
    var weekday by remember { mutableStateOf(start.weekday) }
    var monthDay by remember { mutableStateOf(start.monthDay) }
    var hours by remember { mutableStateOf(start.hours) }
    var onceAt by remember { mutableStateOf(start.onceAt) }
    var cron by remember { mutableStateOf(start.cron) }
    var deliverChannelId by remember { mutableStateOf(existing?.deliverChannelId) }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp)
                .heightIn(max = 620.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                if (existing == null) "New routine" else "Edit routine",
                style = MaterialTheme.typography.titleLarge,
            )
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Name") },
                placeholder = { Text("Morning briefing") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = instruction,
                onValueChange = { instruction = it },
                label = { Text("Instruction") },
                placeholder = { Text("Summarise today's events, anything overdue, and any bills due in the next week.") },
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
            )
            Dropdown("Run", AGENT_OPTIONS.firstOrNull { it.first == agent }?.second ?: agent) { close ->
                AGENT_OPTIONS.forEach { (value, label) ->
                    DropdownMenuItem(text = { Text(label) }, onClick = { agent = value; close() })
                }
            }

            Dropdown("Schedule", kind.label) { close ->
                SchedKind.entries.forEach { k ->
                    DropdownMenuItem(text = { Text(k.label) }, onClick = { kind = k; close() })
                }
            }
            when (kind) {
                SchedKind.Daily -> TimeField(time) { time = it }
                SchedKind.Weekly -> {
                    Dropdown("On", WEEKDAYS[weekday]) { close ->
                        WEEKDAYS.forEachIndexed { i, d ->
                            DropdownMenuItem(text = { Text(d) }, onClick = { weekday = i; close() })
                        }
                    }
                    TimeField(time) { time = it }
                }
                SchedKind.Monthly -> {
                    OutlinedTextField(
                        value = monthDay,
                        onValueChange = { monthDay = it.filter(Char::isDigit).take(2) },
                        label = { Text("Day of month (1–28)") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    TimeField(time) { time = it }
                }
                SchedKind.EveryHours -> Dropdown("Every", "$hours hour${if (hours == 1) "" else "s"}") { close ->
                    HOUR_CHOICES.forEach { h ->
                        DropdownMenuItem(text = { Text("$h hour${if (h == 1) "" else "s"}") }, onClick = { hours = h; close() })
                    }
                }
                SchedKind.Once -> OutlinedTextField(
                    value = onceAt,
                    onValueChange = { onceAt = it },
                    label = { Text("Date & time") },
                    placeholder = { Text("2026-09-08T09:00") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                SchedKind.Cron -> OutlinedTextField(
                    value = cron,
                    onValueChange = { cron = it },
                    label = { Text("Cron expression") },
                    placeholder = { Text("0 7 * * 1-5") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            val deliverLabel = channels.firstOrNull { it.id == deliverChannelId }?.title ?: "— nowhere (just the Routines screen) —"
            Dropdown("Also post the result to", deliverLabel) { close ->
                DropdownMenuItem(text = { Text("— nowhere —") }, onClick = { deliverChannelId = null; close() })
                channels.forEach { c ->
                    DropdownMenuItem(text = { Text(c.title.ifBlank { c.name ?: "conversation" }) }, onClick = { deliverChannelId = c.id; close() })
                }
            }

            error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = onDismiss, modifier = Modifier.weight(1f)) { Text("Cancel") }
                Button(
                    onClick = {
                        val trimmedName = name.trim()
                        if (trimmedName.isEmpty() || instruction.isBlank()) {
                            error = "Give it a name and an instruction."
                            return@Button
                        }
                        saving = true
                        error = null
                        onSave(
                            RoutineInput(
                                name = trimmedName,
                                trigger = buildTrigger(kind, time, weekday, monthDay, hours, onceAt, cron),
                                action = RoutineAction(agent = agent, instruction = instruction.trim()),
                                deliverChannelId = deliverChannelId,
                            ),
                        ) { msg ->
                            saving = false
                            error = msg
                        }
                    },
                    enabled = !saving,
                    modifier = Modifier.weight(1f),
                ) { Text(if (existing == null) "Create" else "Save") }
            }
        }
    }
}

@Composable
private fun TimeField(value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text("At (HH:MM, 24-hour)") },
        placeholder = { Text("07:00") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Dropdown(label: String, selected: String, menu: @Composable (close: () -> Unit) -> Unit) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        OutlinedTextField(
            value = selected,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.fillMaxWidth().menuAnchor(),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            menu { open = false }
        }
    }
}

// ---- friendly trigger <-> form fields ----

private data class FormStart(
    val kind: SchedKind,
    val time: String,
    val weekday: Int,
    val monthDay: String,
    val hours: Int,
    val onceAt: String,
    val cron: String,
)

private fun decompose(routine: Routine?): FormStart {
    val default = FormStart(SchedKind.Daily, "07:00", 1, "1", 3, "", "0 7 * * 1-5")
    val t = routine?.trigger ?: return default
    return when (t.kind) {
        "once" -> default.copy(kind = SchedKind.Once, onceAt = (t.at ?: "").take(16))
        "every" -> {
            val m = t.minutes ?: 180
            if (m % 60 == 0 && (m / 60) in HOUR_CHOICES) default.copy(kind = SchedKind.EveryHours, hours = m / 60)
            else default.copy(kind = SchedKind.Cron, cron = "*/$m * * * *")
        }
        "cron" -> {
            val p = (t.expr ?: "").trim().split(Regex("\\s+"))
            if (p.size == 5 && p[0].toIntOrNull() != null && p[1].toIntOrNull() != null) {
                val hhmm = "%02d:%02d".format(p[1].toInt(), p[0].toInt())
                when {
                    p[2] == "*" && p[4] == "*" -> default.copy(kind = SchedKind.Daily, time = hhmm)
                    p[2] == "*" && p[4].toIntOrNull() in 0..6 ->
                        default.copy(kind = SchedKind.Weekly, time = hhmm, weekday = p[4].toInt())
                    p[2].toIntOrNull() != null && p[4] == "*" ->
                        default.copy(kind = SchedKind.Monthly, time = hhmm, monthDay = p[2])
                    else -> default.copy(kind = SchedKind.Cron, cron = t.expr ?: "")
                }
            } else default.copy(kind = SchedKind.Cron, cron = t.expr ?: "")
        }
        else -> default
    }
}

private fun buildTrigger(
    kind: SchedKind,
    time: String,
    weekday: Int,
    monthDay: String,
    hours: Int,
    onceAt: String,
    cron: String,
): RoutineTriggerInput = when (kind) {
    SchedKind.Daily -> RoutineTriggerInput(dailyAt = time.trim())
    SchedKind.Weekly -> RoutineTriggerInput(weeklyOn = WEEKDAYS[weekday], weeklyAt = time.trim())
    SchedKind.Monthly -> RoutineTriggerInput(monthlyDay = monthDay.toIntOrNull() ?: 1, monthlyAt = time.trim())
    SchedKind.EveryHours -> RoutineTriggerInput(everyMinutes = hours * 60)
    SchedKind.Once -> RoutineTriggerInput(onceAt = onceAt.trim())
    SchedKind.Cron -> RoutineTriggerInput(cron = cron.trim())
}

/** An ISO timestamp → a short, human "Sep 8 · 7:00 AM" (best-effort; the raw
 *  string is fine if parsing fails — no locale library needed). */
private fun shortWhen(iso: String): String = runCatching {
    val d = java.time.OffsetDateTime.parse(iso)
    val local = d.atZoneSameInstant(java.time.ZoneId.systemDefault())
    local.format(java.time.format.DateTimeFormatter.ofPattern("MMM d · h:mm a"))
}.getOrElse {
    runCatching {
        val ldt = java.time.LocalDateTime.parse(iso.take(16))
        ldt.format(java.time.format.DateTimeFormatter.ofPattern("MMM d · h:mm a"))
    }.getOrDefault(iso)
}
