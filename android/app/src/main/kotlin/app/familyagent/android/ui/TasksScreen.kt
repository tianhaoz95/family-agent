package app.familyagent.android.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronLeft
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.TaskAlt
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.Task
import app.familyagent.android.ui.theme.AppAccents
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToInt

private val HOUR_H = 56.dp

private fun Task.dayKey(): String? = dueDate?.take(10)
private fun Task.minutesOfDay(): Int? = dueTime?.split(":")?.let {
    runCatching { it[0].toInt() * 60 + it[1].toInt() }.getOrNull()
}

private fun mondayOf(d: LocalDate): LocalDate = d.minusDays(((d.dayOfWeek.value + 6) % 7).toLong())

private fun rangeDays(view: String, anchor: LocalDate): List<LocalDate> = when (view) {
    "day" -> listOf(anchor)
    "3day" -> (0L..2L).map { anchor.plusDays(it) }
    else -> (0L..6L).map { mondayOf(anchor).plusDays(it) } // week
}

private fun fmtMinutes(m: Int): String = "%02d:%02d".format(m / 60, m % 60)

@Composable
fun TasksScreen(
    tasks: List<Task>,
    taskView: String,
    calAnchor: LocalDate,
    onAdd: (title: String, dueDate: String?, dueTime: String?) -> Unit,
    onComplete: (id: String) -> Unit,
    onReschedule: (id: String, dueDate: String?, dueTime: String?) -> Unit,
    onSetTaskView: (String) -> Unit,
    onShiftRange: (forward: Boolean) -> Unit,
    onResetRange: () -> Unit,
) {
    var rescheduleTarget by remember { mutableStateOf<Task?>(null) }
    // day (ISO) + optional "HH:MM" for the quick-add dialog
    var addSlot by remember { mutableStateOf<Pair<String, String?>?>(null) }

    ScreenScaffold(
        title = "Tasks",
        subtitle = "Everything the family agent is tracking for you.",
    ) {
        val modes = listOf(
            "list" to "List", "day" to "Day", "3day" to "3-Day", "week" to "Week", "month" to "Month",
        )
        Row(
            Modifier.horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            modes.forEach { (key, label) ->
                FilterChip(
                    selected = taskView == key,
                    onClick = { onSetTaskView(key) },
                    label = { Text(label) },
                )
            }
        }
        Spacer(Modifier.height(16.dp))

        when (taskView) {
            "list" -> ListView(tasks, onAdd, onComplete)
            "month" -> MonthView(
                tasks, calAnchor, onShiftRange, onResetRange,
                onDayTap = { addSlot = it.toString() to null },
                onTaskTap = { rescheduleTarget = it },
            )
            else -> ScheduleView(
                tasks, taskView, calAnchor, onShiftRange, onResetRange,
                onSlotTap = { day, hhmm -> addSlot = day.toString() to hhmm },
                onTaskTap = { rescheduleTarget = it },
            )
        }
    }

    rescheduleTarget?.let { task ->
        RescheduleDialog(
            task = task,
            onDismiss = { rescheduleTarget = null },
            onSave = { date, time ->
                onReschedule(task.id, date, time)
                rescheduleTarget = null
            },
        )
    }

    addSlot?.let { (day, time) ->
        QuickAddDialog(
            day = day,
            time = time,
            onDismiss = { addSlot = null },
            onConfirm = { title, keepTime ->
                onAdd(title, day, if (keepTime) time else null)
                addSlot = null
            },
        )
    }
}

// ---------------------------------------------------------------- list view

@Composable
private fun ListView(
    tasks: List<Task>,
    onAdd: (title: String, dueDate: String?, dueTime: String?) -> Unit,
    onComplete: (id: String) -> Unit,
) {
    var title by remember { mutableStateOf("") }
    var due by remember { mutableStateOf("") }
    var time by remember { mutableStateOf("") }

    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            modifier = Modifier.weight(1f),
            placeholder = { Text("New task") },
            singleLine = true,
            shape = MaterialTheme.shapes.medium,
        )
        Button(
            onClick = {
                if (title.isNotBlank()) {
                    onAdd(title, due.ifBlank { null }, time.ifBlank { null })
                    title = ""; due = ""; time = ""
                }
            },
            shape = MaterialTheme.shapes.medium,
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 14.dp),
        ) { Text("Add") }
    }
    Spacer(Modifier.height(8.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = due,
            onValueChange = { due = it },
            modifier = Modifier.weight(1f),
            placeholder = { Text("Due date — 2026-11-01") },
            singleLine = true,
            shape = MaterialTheme.shapes.medium,
        )
        OutlinedTextField(
            value = time,
            onValueChange = { time = it },
            modifier = Modifier.width(120.dp),
            placeholder = { Text("14:30") },
            singleLine = true,
            shape = MaterialTheme.shapes.medium,
        )
    }

    Spacer(Modifier.height(16.dp))

    if (tasks.isEmpty()) {
        EmptyState(
            text = "No tasks yet. Add one above or ask in Chat.",
            icon = {
                Icon(
                    Icons.Rounded.TaskAlt,
                    contentDescription = null,
                    modifier = Modifier.size(30.dp),
                    tint = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            },
        )
    } else {
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(tasks, key = { it.id }) { task ->
                val done = task.status == "done"
                AppCard {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = done,
                            onCheckedChange = { if (!done) onComplete(task.id) },
                            enabled = !done,
                            colors = CheckboxDefaults.colors(
                                disabledCheckedColor = MaterialTheme.colorScheme.primary,
                            ),
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(
                            task.title,
                            modifier = Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyLarge,
                            textDecoration = if (done) TextDecoration.LineThrough else null,
                            color = animateColorAsState(
                                if (done) MaterialTheme.colorScheme.onSurfaceVariant
                                else MaterialTheme.colorScheme.onSurface,
                                label = "taskColor",
                            ).value,
                        )
                        task.dueDate?.let {
                            Spacer(Modifier.width(8.dp))
                            Surface(
                                color = MaterialTheme.colorScheme.surfaceVariant,
                                shape = RoundedCornerShape(999.dp),
                            ) {
                                Text(
                                    if (task.dueTime != null) "$it ${task.dueTime}" else it,
                                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 3.dp),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------- shared header

@Composable
private fun CalendarHeader(
    label: String,
    onShiftRange: (Boolean) -> Unit,
    onResetRange: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { onShiftRange(false) }) {
            Icon(Icons.Rounded.ChevronLeft, contentDescription = "Previous")
        }
        Text(
            label,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
        IconButton(onClick = { onShiftRange(true) }) {
            Icon(Icons.Rounded.ChevronRight, contentDescription = "Next")
        }
        TextButton(onClick = onResetRange) { Text("Today") }
    }
}

// ------------------------------------------------------------- month view

@Composable
private fun MonthView(
    tasks: List<Task>,
    anchor: LocalDate,
    onShiftRange: (Boolean) -> Unit,
    onResetRange: () -> Unit,
    onDayTap: (LocalDate) -> Unit,
    onTaskTap: (Task) -> Unit,
) {
    val first = anchor.withDayOfMonth(1)
    val byDay = tasks.groupBy { it.dayKey() }
    val today = LocalDate.now()
    val gridStart = mondayOf(first)

    Column(Modifier.verticalScroll(rememberScrollState())) {
        CalendarHeader(
            "${first.month.getDisplayName(TextStyle.FULL, Locale.getDefault())} ${first.year}",
            onShiftRange, onResetRange,
        )
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth()) {
            listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun").forEach {
                Text(
                    it,
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    color = AppAccents.textSecondary,
                    textAlign = TextAlign.Center,
                )
            }
        }
        Spacer(Modifier.height(4.dp))
        for (week in 0 until 6) {
            Row(Modifier.fillMaxWidth().height(76.dp)) {
                for (dow in 0 until 7) {
                    val day = gridStart.plusDays((week * 7 + dow).toLong())
                    MonthDayCell(
                        day = day,
                        inMonth = day.month == first.month,
                        isToday = day == today,
                        dayTasks = byDay[day.toString()].orEmpty(),
                        onEmptyTap = { onDayTap(day) },
                        onTaskTap = onTaskTap,
                        modifier = Modifier.weight(1f).fillMaxHeight(),
                    )
                }
            }
        }
    }
}

@Composable
private fun MonthDayCell(
    day: LocalDate,
    inMonth: Boolean,
    isToday: Boolean,
    dayTasks: List<Task>,
    onEmptyTap: () -> Unit,
    onTaskTap: (Task) -> Unit,
    modifier: Modifier = Modifier,
) {
    val bg = when {
        isToday -> MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)
        inMonth -> MaterialTheme.colorScheme.surface
        else -> MaterialTheme.colorScheme.background
    }
    Column(
        modifier
            .padding(1.dp)
            .background(bg, RoundedCornerShape(6.dp))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(6.dp))
            .clickable(onClick = onEmptyTap)
            .padding(2.dp),
    ) {
        Text(
            day.dayOfMonth.toString(),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal,
            color = when {
                isToday -> MaterialTheme.colorScheme.primary
                inMonth -> MaterialTheme.colorScheme.onSurface
                else -> AppAccents.textSecondary
            },
        )
        val ordered = dayTasks.sortedBy { it.minutesOfDay() ?: -1 }
        ordered.take(2).forEach { task ->
            Text(
                task.dueTime?.let { "$it ${task.title}" } ?: task.title,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 1.dp)
                    .background(
                        if (task.status == "done") MaterialTheme.colorScheme.surfaceVariant
                        else MaterialTheme.colorScheme.primaryContainer,
                        RoundedCornerShape(3.dp),
                    )
                    .clickable { onTaskTap(task) }
                    .padding(horizontal = 3.dp, vertical = 1.dp),
                style = MaterialTheme.typography.labelSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textDecoration = if (task.status == "done") TextDecoration.LineThrough else null,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
        if (ordered.size > 2) {
            Text(
                "+${ordered.size - 2}",
                style = MaterialTheme.typography.labelSmall,
                color = AppAccents.textSecondary,
            )
        }
    }
}

// -------------------------------------------------- day / 3-day / week grid

@Composable
private fun ScheduleView(
    tasks: List<Task>,
    view: String,
    anchor: LocalDate,
    onShiftRange: (Boolean) -> Unit,
    onResetRange: () -> Unit,
    onSlotTap: (LocalDate, String) -> Unit,
    onTaskTap: (Task) -> Unit,
) {
    val days = rangeDays(view, anchor)
    val byDay = tasks.groupBy { it.dayKey() }
    val today = LocalDate.now()

    val label = if (days.size == 1) {
        days[0].format(java.time.format.DateTimeFormatter.ofPattern("EEEE, MMM d"))
    } else {
        "${days.first().format(java.time.format.DateTimeFormatter.ofPattern("MMM d"))} – " +
            days.last().format(java.time.format.DateTimeFormatter.ofPattern("MMM d"))
    }

    val density = LocalDensity.current
    val hourPx = with(density) { HOUR_H.toPx() }
    val scroll = rememberScrollState()
    LaunchedEffect(Unit) { scroll.scrollTo(with(density) { (HOUR_H * 7).roundToPx() }) }

    Column(Modifier.fillMaxSize()) {
        CalendarHeader(label, onShiftRange, onResetRange)
        Spacer(Modifier.height(8.dp))

        // Day-name header
        Row(Modifier.fillMaxWidth()) {
            Spacer(Modifier.width(44.dp))
            days.forEach { d ->
                Text(
                    d.format(java.time.format.DateTimeFormatter.ofPattern("EEE d")),
                    modifier = Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = if (d == today) FontWeight.Bold else FontWeight.Normal,
                    color = if (d == today) MaterialTheme.colorScheme.primary else AppAccents.textSecondary,
                    textAlign = TextAlign.Center,
                )
            }
        }

        // All-day row
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 30.dp)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Text(
                "all-day",
                Modifier.width(44.dp).padding(2.dp),
                style = MaterialTheme.typography.labelSmall,
                color = AppAccents.textSecondary,
            )
            days.forEach { d ->
                Column(Modifier.weight(1f).padding(1.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    byDay[d.toString()].orEmpty().filter { it.dueTime == null }.forEach { t ->
                        MiniChip(t) { onTaskTap(t) }
                    }
                }
            }
        }

        // Hours body
        Column(Modifier.verticalScroll(scroll)) {
            Row(Modifier.height(HOUR_H * 24)) {
                // time gutter
                Column(Modifier.width(44.dp)) {
                    for (h in 0 until 24) {
                        Box(Modifier.height(HOUR_H)) {
                            if (h != 0) Text(
                                "%02d:00".format(h),
                                Modifier.align(Alignment.TopEnd).padding(end = 4.dp).offset(y = (-7).dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = AppAccents.textSecondary,
                            )
                        }
                    }
                }
                val lineColor = MaterialTheme.colorScheme.outlineVariant
                days.forEach { d ->
                    val timed = byDay[d.toString()].orEmpty().filter { it.minutesOfDay() != null }
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .background(
                                if (d == today) MaterialTheme.colorScheme.primary.copy(alpha = 0.06f)
                                else MaterialTheme.colorScheme.surface,
                            )
                            .drawBehind {
                                for (h in 0..24) {
                                    val y = h * hourPx
                                    drawLine(lineColor, Offset(0f, y), Offset(size.width, y), 1f)
                                }
                            }
                            .pointerInput(d) {
                                detectTapGestures { off ->
                                    val mins = ((off.y / hourPx) * 60f).roundToInt()
                                        .coerceIn(0, 24 * 60 - 30)
                                    val snapped = (mins / 30) * 30
                                    onSlotTap(d, fmtMinutes(snapped))
                                }
                            },
                    ) {
                        timed.forEach { t ->
                            val mins = t.minutesOfDay()!!
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 1.dp)
                                    .offset(y = with(density) { (mins / 60f * hourPx).toDp() })
                                    .height(HOUR_H - 2.dp)
                                    .background(
                                        if (t.status == "done") MaterialTheme.colorScheme.surfaceVariant
                                        else MaterialTheme.colorScheme.primaryContainer,
                                        RoundedCornerShape(4.dp),
                                    )
                                    .clickable { onTaskTap(t) }
                                    .padding(horizontal = 4.dp, vertical = 1.dp),
                            ) {
                                Text(
                                    "${t.dueTime} ${t.title}",
                                    style = MaterialTheme.typography.labelSmall,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                    textDecoration = if (t.status == "done") TextDecoration.LineThrough else null,
                                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MiniChip(task: Task, onClick: () -> Unit) {
    Text(
        task.title,
        modifier = Modifier
            .fillMaxWidth()
            .background(
                if (task.status == "done") MaterialTheme.colorScheme.surfaceVariant
                else MaterialTheme.colorScheme.primaryContainer,
                RoundedCornerShape(3.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 3.dp, vertical = 1.dp),
        style = MaterialTheme.typography.labelSmall,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textDecoration = if (task.status == "done") TextDecoration.LineThrough else null,
        color = MaterialTheme.colorScheme.onPrimaryContainer,
    )
}

// ------------------------------------------------------------------ dialogs

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RescheduleDialog(
    task: Task,
    onDismiss: () -> Unit,
    onSave: (dueDate: String?, dueTime: String?) -> Unit,
) {
    val initialDate = task.dayKey()?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: LocalDate.now()
    val dateState = rememberDatePickerState(
        initialSelectedDateMillis = initialDate.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
    )
    val initialMin = task.minutesOfDay()
    var timed by remember { mutableStateOf(initialMin != null) }
    val timeState = rememberTimePickerState(
        initialHour = (initialMin ?: 540) / 60,
        initialMinute = (initialMin ?: 540) % 60,
        is24Hour = true,
    )

    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                val iso = dateState.selectedDateMillis?.let {
                    Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString()
                }
                onSave(iso, if (timed) fmtMinutes(timeState.hour * 60 + timeState.minute) else null)
            }) { Text("Save") }
        },
        dismissButton = {
            Row {
                TextButton(onClick = { onSave(null, null) }) { Text("Clear date") }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    ) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            Text(
                "Reschedule “${task.title}”",
                Modifier.padding(start = 24.dp, end = 12.dp, top = 16.dp),
                style = MaterialTheme.typography.labelLarge,
            )
            DatePicker(state = dateState, title = null, showModeToggle = false)
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = timed, onCheckedChange = { timed = it })
                Text("Specific time", style = MaterialTheme.typography.bodyMedium)
            }
            if (timed) {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    TimeInput(state = timeState)
                }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun QuickAddDialog(
    day: String,
    time: String?,
    onDismiss: () -> Unit,
    onConfirm: (title: String, keepTime: Boolean) -> Unit,
) {
    var title by remember { mutableStateOf("") }
    var keepTime by remember { mutableStateOf(true) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (time != null) "New task · $day $time" else "New task · $day") },
        text = {
            Column {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    placeholder = { Text("Task title") },
                    singleLine = true,
                )
                if (time != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = keepTime, onCheckedChange = { keepTime = it })
                        Text("At $time", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { if (title.isNotBlank()) onConfirm(title.trim(), keepTime) },
                enabled = title.isNotBlank(),
            ) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
