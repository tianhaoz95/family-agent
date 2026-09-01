package app.familyagent.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import app.familyagent.android.data.FamilyAgentApi
import app.familyagent.android.data.SettingsStore
import app.familyagent.android.ui.ActivityScreen
import app.familyagent.android.ui.ChatScreen
import app.familyagent.android.ui.DocumentsScreen
import app.familyagent.android.ui.SettingsScreen
import app.familyagent.android.ui.TasksScreen
import app.familyagent.android.ui.theme.FamilyAgentTheme
import kotlinx.coroutines.flow.first

private enum class Destination(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Chat("chat", "Chat", Icons.AutoMirrored.Filled.Chat),
    Tasks("tasks", "Tasks", Icons.Filled.CheckCircle),
    Documents("documents", "Documents", Icons.Filled.Description),
    Activity("activity", "Activity", Icons.Filled.History),
    Settings("settings", "Settings", Icons.Filled.Settings),
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val settingsStore = SettingsStore(applicationContext)
        setContent {
            FamilyAgentTheme {
                var initialUrl by remember { mutableStateOf<String?>(null) }
                LaunchedEffect(Unit) {
                    initialUrl = settingsStore.serverUrl.first()
                }
                val url = initialUrl
                if (url == null) {
                    Surface(Modifier.fillMaxSize()) {}
                } else {
                    val viewModel: AppViewModel = viewModel(
                        factory = AppViewModelFactory(FamilyAgentApi(url), settingsStore),
                    )
                    FamilyAgentApp(viewModel)
                }
            }
        }
    }
}

class AppViewModelFactory(
    private val api: FamilyAgentApi,
    private val settings: SettingsStore,
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        @Suppress("UNCHECKED_CAST")
        return AppViewModel(api, settings) as T
    }
}

@Composable
fun FamilyAgentApp(viewModel: AppViewModel) {
    val state by viewModel.state.collectAsState()
    val navController = rememberNavController()

    Scaffold(
        bottomBar = {
            NavigationBar {
                val backStackEntry by navController.currentBackStackEntryAsState()
                val currentDestination = backStackEntry?.destination
                Destination.entries.forEach { dest ->
                    NavigationBarItem(
                        selected = currentDestination?.hierarchy?.any { it.route == dest.route } == true,
                        onClick = {
                            navController.navigate(dest.route) {
                                popUpTo(navController.graph.findStartDestination().id) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                            when (dest) {
                                Destination.Tasks -> viewModel.refreshTasks()
                                Destination.Documents -> viewModel.refreshDocuments()
                                Destination.Activity -> viewModel.refreshActivity()
                                else -> {}
                            }
                        },
                        icon = { Icon(dest.icon, contentDescription = dest.label) },
                        label = { Text(dest.label) },
                    )
                }
            }
        }
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Destination.Chat.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(Destination.Chat.route) {
                ChatScreen(state.chatMessages, state.chatSending, onSend = viewModel::sendChat)
            }
            composable(Destination.Tasks.route) {
                TasksScreen(state.tasks, onAdd = viewModel::addTask, onComplete = viewModel::completeTask)
            }
            composable(Destination.Documents.route) {
                DocumentsScreen(state.documents, onIngest = viewModel::ingestDocument)
            }
            composable(Destination.Activity.route) {
                ActivityScreen(state.activity)
            }
            composable(Destination.Settings.route) {
                SettingsScreen(state.serverUrl, state.connection, onSave = viewModel::setServerUrl)
            }
        }
    }
}
