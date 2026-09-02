package app.familyagent.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Build
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
import app.familyagent.android.ui.ToolWebViewScreen
import app.familyagent.android.ui.ToolsScreen
import app.familyagent.android.ui.theme.FamilyAgentTheme
import kotlinx.coroutines.flow.first

private enum class Destination(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Chat("chat", "Chat", Icons.AutoMirrored.Filled.Chat),
    Tasks("tasks", "Tasks", Icons.Filled.CheckCircle),
    Documents("documents", "Documents", Icons.Filled.Description),
    Tools("tools", "Tools", Icons.Filled.Build),
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
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            // Flat nav bar: same canvas as the rest of the app, a hairline
            // divider on top, and a soft indigo pill behind the active item —
            // matches the desktop rail's active-item treatment.
            Column {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                NavigationBar(
                    containerColor = MaterialTheme.colorScheme.background,
                    tonalElevation = 0.dp,
                ) {
                val backStackEntry by navController.currentBackStackEntryAsState()
                val currentDestination = backStackEntry?.destination
                Destination.entries.forEach { dest ->
                    NavigationBarItem(
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = MaterialTheme.colorScheme.onPrimaryContainer,
                            selectedTextColor = MaterialTheme.colorScheme.onPrimaryContainer,
                            indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                            unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        ),
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
                                Destination.Tools -> viewModel.refreshTools()
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
                DocumentsScreen(
                    documents = state.documents,
                    uploadStatus = state.documentUploadStatus,
                    onIngest = viewModel::ingestDocument,
                    onUpload = viewModel::uploadDocument,
                    onDelete = viewModel::deleteDocument,
                    onRetry = viewModel::retryExtraction,
                )
            }
            composable(Destination.Tools.route) {
                ToolsScreen(
                    tools = state.tools,
                    status = state.toolStatus,
                    toolsBaseUrl = state.toolsBaseUrl,
                    onBuild = viewModel::buildTool,
                    onDelete = viewModel::deleteTool,
                    onOpen = { url -> navController.navigate("toolview/" + android.net.Uri.encode(url)) },
                )
            }
            composable("toolview/{url}") { entry ->
                val url = android.net.Uri.decode(entry.arguments?.getString("url") ?: "")
                ToolWebViewScreen(url = url, onClose = { navController.popBackStack() })
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
