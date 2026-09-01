package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.familyagent.android.data.Document

@Composable
fun DocumentsScreen(
    documents: List<Document>,
    onIngest: (filename: String, text: String) -> Unit,
) {
    var filename by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().padding(16.dp)) {
        Text("Documents", style = MaterialTheme.typography.titleLarge)
        Text(
            "Paste document text below. Dropping files directly is available " +
                "from the desktop app's watched folder, not yet from here.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        OutlinedTextField(
            value = filename,
            onValueChange = { filename = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("Filename, e.g. electric-bill.txt") },
            singleLine = true,
        )
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth().height(96.dp),
            placeholder = { Text("Paste the document text here") },
        )
        Spacer(Modifier.height(8.dp))
        Button(
            onClick = {
                if (filename.isNotBlank() && text.isNotBlank()) {
                    onIngest(filename, text)
                    filename = ""
                    text = ""
                }
            },
            modifier = Modifier.align(Alignment.End),
        ) { Text("Ingest") }

        Spacer(Modifier.height(12.dp))

        if (documents.isEmpty()) {
            EmptyState("No documents ingested yet.")
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(documents, key = { it.id }) { doc ->
                    ElevatedCard {
                        Column(Modifier.padding(12.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    doc.filename,
                                    style = MaterialTheme.typography.titleMedium,
                                    modifier = Modifier.weight(1f),
                                )
                                doc.extracted?.category?.let { category ->
                                    Surface(
                                        color = MaterialTheme.colorScheme.secondary.copy(alpha = 0.14f),
                                        shape = RoundedCornerShape(999.dp),
                                    ) {
                                        Text(
                                            category.uppercase(),
                                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.secondary,
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(
                                doc.extracted?.summary ?: "Extracting…",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
