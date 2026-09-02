package app.familyagent.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Menu
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavDestination
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import app.familyagent.android.data.FamilyAgentApi
import app.familyagent.android.data.ServerDiscovery
import app.familyagent.android.data.SettingsStore
import app.familyagent.android.ui.ActivityScreen
import app.familyagent.android.ui.ChatScreen
import app.familyagent.android.ui.DiscoveryScreen
import app.familyagent.android.ui.DocumentsScreen
import app.familyagent.android.ui.LoginScreen
import app.familyagent.android.ui.SettingsScreen
import app.familyagent.android.ui.StatusDot
import app.familyagent.android.ui.TasksScreen
import app.familyagent.android.ui.ToolWebViewScreen
import app.familyagent.android.ui.ToolsScreen
import app.familyagent.android.ui.theme.AppAccents
import app.familyagent.android.ui.theme.FamilyAgentTheme
import kotlinx.coroutines.launch

private enum class Destination(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Chat("chat", "Chat", Icons.AutoMirrored.Rounded.Chat),
    Tasks("tasks", "Tasks", Icons.Rounded.CheckCircle),
    Documents("documents", "Documents", Icons.Rounded.Description),
    Tools("tools", "Tools", Icons.Rounded.Build),
    Activity("activity", "Activity", Icons.Rounded.History),
    Settings("settings", "Settings", Icons.Rounded.Settings),
}

private const val TOOL_VIEW_ROUTE = "toolview/{url}"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val settingsStore = SettingsStore(applicationContext)
        val discovery = ServerDiscovery(applicationContext)
        setContent {
            FamilyAgentTheme {
                val viewModel: AppViewModel = viewModel(
                    factory = AppViewModelFactory(FamilyAgentApi(""), settingsStore),
                )
                val state by viewModel.state.collectAsState()
                when (val auth = state.auth) {
                    is AuthState.Unknown -> Surface(Modifier.fillMaxSize()) {}
                    is AuthState.PickServer ->
                        DiscoveryScreen(
                            discovery = discovery,
                            onPick = viewModel::pickServer,
                        )
                    is AuthState.NeedLogin ->
                        LoginScreen(
                            serverName = auth.serverName,
                            error = auth.error,
                            onSignIn = viewModel::login,
                            onBack = viewModel::backToServerPick,
                        )
                    is AuthState.Authenticated -> FamilyAgentApp(viewModel)
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
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = backStackEntry?.destination
    val onToolView = currentDestination?.route == TOOL_VIEW_ROUTE

    // Freshen the connection reading each time the menu is pulled open — the
    // status pill in the drawer footer is the only place it's surfaced now.
    LaunchedEffect(drawerState.isOpen) {
        if (drawerState.isOpen) viewModel.refreshStatus()
    }

    fun navigateTo(dest: Destination) {
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
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        // The in-app tool WebView is full-bleed and owns its own gestures.
        gesturesEnabled = !onToolView,
        drawerContent = {
            AppDrawer(
                current = currentDestination,
                connection = state.connection,
                onSelect = { dest ->
                    scope.launch { drawerState.close() }
                    val alreadyHere = currentDestination?.hierarchy?.any { it.route == dest.route } == true
                    if (!alreadyHere) navigateTo(dest)
                },
            )
        },
    ) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            topBar = {
                if (!onToolView) {
                    AppTopBar(onMenuClick = { scope.launch { drawerState.open() } })
                }
            },
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
                composable(TOOL_VIEW_ROUTE) { entry ->
                    val url = android.net.Uri.decode(entry.arguments?.getString("url") ?: "")
                    ToolWebViewScreen(url = url, onClose = { navController.popBackStack() })
                }
                composable(Destination.Activity.route) {
                    ActivityScreen(state.activity)
                }
                composable(Destination.Settings.route) {
                    SettingsScreen(
                        serverUrl = state.serverUrl,
                        connection = state.connection,
                        userName = (state.auth as? AuthState.Authenticated)?.user?.displayName ?: "",
                        userRole = (state.auth as? AuthState.Authenticated)?.user?.role ?: "",
                        onSave = viewModel::setServerUrl,
                        onSignOut = viewModel::signOut,
                    )
                }
            }
        }
    }
}

/** A rounded indigo→pink gradient tile — the app's brand mark (DESIGN.md §2). */
@Composable
private fun BrandMark(size: Int = 30) {
    Box(
        Modifier
            .size(size.dp)
            .clip(RoundedCornerShape((size * 0.32f).dp))
            .background(
                Brush.linearGradient(
                    listOf(MaterialTheme.colorScheme.primary, AppAccents.pink),
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text("n", style = MaterialTheme.typography.titleMedium, color = Color.White)
    }
}

/**
 * Top chrome: the menu toggle, the brand mark and wordmark. Sits on the page
 * canvas with a hairline divider under it (DESIGN.md §7 — a colored header is
 * allowed; this one stays calm so the content leads).
 */
@Composable
private fun AppTopBar(onMenuClick: () -> Unit) {
    Column(Modifier.background(MaterialTheme.colorScheme.background)) {
        Row(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(start = 6.dp, end = 12.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FilledIconButton(
                onClick = onMenuClick,
                shape = RoundedCornerShape(14.dp),
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                ),
            ) {
                Icon(Icons.Rounded.Menu, contentDescription = "Open menu")
            }
            Spacer(Modifier.width(12.dp))
            BrandMark(size = 26)
            Spacer(Modifier.width(9.dp))
            Text(
                "Family Agent",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onBackground,
            )
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    }
}

/**
 * The collapsible sidebar: gradient brand mark, nav items with a filled
 * indigo pill behind the active one and rounded icons, and a connection pill
 * pinned to the footer.
 */
@Composable
private fun AppDrawer(
    current: NavDestination?,
    connection: ConnectionStatus,
    onSelect: (Destination) -> Unit,
) {
    ModalDrawerSheet(
        drawerContainerColor = MaterialTheme.colorScheme.background,
        drawerShape = RoundedCornerShape(topEnd = 28.dp, bottomEnd = 28.dp),
        modifier = Modifier.fillMaxWidth(0.84f),
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .padding(horizontal = 14.dp)
                .padding(top = 20.dp, bottom = 16.dp),
        ) {
            Row(
                Modifier.padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 22.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandMark(size = 34)
                Spacer(Modifier.width(12.dp))
                Text(
                    "Family Agent",
                    style = MaterialTheme.typography.titleLarge,
                    color = MaterialTheme.colorScheme.onBackground,
                )
            }

            Destination.entries.forEach { dest ->
                val selected = current?.hierarchy?.any { it.route == dest.route } == true
                NavigationDrawerItem(
                    label = {
                        Text(
                            dest.label,
                            style = MaterialTheme.typography.titleSmall,
                        )
                    },
                    icon = { Icon(dest.icon, contentDescription = null, modifier = Modifier.size(22.dp)) },
                    selected = selected,
                    onClick = { onSelect(dest) },
                    shape = RoundedCornerShape(16.dp),
                    colors = NavigationDrawerItemDefaults.colors(
                        selectedContainerColor = MaterialTheme.colorScheme.primary,
                        unselectedContainerColor = Color.Transparent,
                        selectedIconColor = MaterialTheme.colorScheme.onPrimary,
                        unselectedIconColor = AppAccents.textSecondary,
                        selectedTextColor = MaterialTheme.colorScheme.onPrimary,
                        unselectedTextColor = MaterialTheme.colorScheme.onBackground,
                    ),
                    modifier = Modifier.padding(vertical = 3.dp),
                )
            }

            Spacer(Modifier.weight(1f))
            ConnectionPill(connection)
        }
    }
}

@Composable
private fun ConnectionPill(connection: ConnectionStatus) {
    val (label, dotColor) = when (connection) {
        is ConnectionStatus.Connecting -> "Connecting…" to AppAccents.warning
        is ConnectionStatus.Connected -> "Connected · local · ${connection.model}" to AppAccents.success
        is ConnectionStatus.Unreachable -> "Offline — check Settings" to MaterialTheme.colorScheme.error
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(16.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(dotColor)
            Spacer(Modifier.width(10.dp))
            Text(
                label,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
