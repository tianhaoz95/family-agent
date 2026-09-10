package app.familyagent.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.History
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.ActivityEntry

@Composable
fun ActivityScreen(entries: List<ActivityEntry>) {
    ScreenScaffold(
        title = "Activity",
        subtitle = "Everything the agent has read or changed, newest first.",
    ) {
        if (entries.isEmpty()) {
            EmptyState(
                text = "Nothing has happened yet.",
                icon = {
                    Icon(
                        Icons.Rounded.History,
                        contentDescription = null,
                        modifier = Modifier.size(30.dp),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                },
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                items(entries, key = { it.id }) { entry ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 8.dp),
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Text(
                            entry.ts.substringAfter('T').substringBefore('.'),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                        Surface(
                            color = MaterialTheme.colorScheme.primaryContainer,
                            shape = RoundedCornerShape(999.dp),
                        ) {
                            Text(
                                entry.actor,
                                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer,
                            )
                        }
                        // Clamp long detail lines to 2 rows; reveal a toggle only
                        // when the text actually overflows.
                        var expanded by remember(entry.id) { mutableStateOf(false) }
                        var clampable by remember(entry.id) { mutableStateOf(false) }
                        Column(Modifier.weight(1f)) {
                            Text(
                                entry.detail,
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = if (expanded) Int.MAX_VALUE else 2,
                                overflow = TextOverflow.Ellipsis,
                                onTextLayout = { if (!expanded) clampable = it.hasVisualOverflow },
                                modifier = if (clampable) Modifier.clickable { expanded = !expanded } else Modifier,
                            )
                            if (clampable) {
                                Text(
                                    if (expanded) "Show less" else "Show more",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier
                                        .padding(top = 2.dp)
                                        .clickable { expanded = !expanded },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
