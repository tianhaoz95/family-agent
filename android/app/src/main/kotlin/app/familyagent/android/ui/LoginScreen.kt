package app.familyagent.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp

/** Sign in to the chosen home server. */
@Composable
fun LoginScreen(
    serverName: String,
    error: String?,
    remembered: Pair<String, String>?,
    onSignIn: (username: String, password: String, remember: Boolean) -> Unit,
    onBack: () -> Unit,
) {
    var username by remember(remembered) { mutableStateOf(remembered?.first ?: "") }
    var password by remember(remembered) { mutableStateOf(remembered?.second ?: "") }
    var rememberMe by remember(remembered) { mutableStateOf(true) }
    val canSubmit = username.isNotBlank() && password.isNotBlank()

    ScreenScaffold(
        title = if (serverName.isBlank()) "Sign in" else serverName,
        subtitle = "Sign in to your account. Everyone's things stay separate.",
        hasMenuButton = false,
    ) {
        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Username") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, imeAction = ImeAction.Next),
            shape = MaterialTheme.shapes.medium,
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            shape = MaterialTheme.shapes.medium,
        )
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = rememberMe, onCheckedChange = { rememberMe = it })
            Spacer(Modifier.width(10.dp))
            Text("Remember me", style = MaterialTheme.typography.bodyMedium)
        }
        if (error != null) {
            Spacer(Modifier.height(10.dp))
            Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(16.dp))
        Button(
            onClick = { onSignIn(username, password, rememberMe) },
            enabled = canSubmit,
            modifier = Modifier.fillMaxWidth(),
            shape = MaterialTheme.shapes.medium,
        ) { Text("Sign in") }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = onBack) { Text("Choose a different server") }
    }
}
