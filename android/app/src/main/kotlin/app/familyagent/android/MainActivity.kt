package app.familyagent.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Hub
import androidx.compose.material.icons.rounded.Menu
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.School
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
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
import app.familyagent.android.ui.AtmosphereBackground
import app.familyagent.android.ui.BoardScreen
import app.familyagent.android.ui.ChatScreen
import app.familyagent.android.ui.ChatSessionsScreen
import app.familyagent.android.ui.ConnectionsScreen
import app.familyagent.android.ui.DetailSheet
import app.familyagent.android.ui.ConversationScreen
import app.familyagent.android.ui.DiscoveryScreen
import app.familyagent.android.ui.DocumentsScreen
import app.familyagent.android.ui.LoginScreen
import app.familyagent.android.ui.MessagesScreen
import app.familyagent.android.ui.RoutinesScreen
import app.familyagent.android.ui.SettingsScreen
import app.familyagent.android.ui.SkillsScreen
import app.familyagent.android.ui.StatusDot
import app.familyagent.android.ui.TasksScreen
import app.familyagent.android.ui.ToolWebViewScreen
import app.familyagent.android.ui.ToolsScreen
import app.familyagent.android.ui.theme.AppAccents
import app.familyagent.android.ui.theme.FamilyAgentTheme
import kotlinx.coroutines.launch

private enum class Destination(val route: String, val label: String, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    Chat("chat", "Chat", Icons.AutoMirrored.Rounded.Chat),
    Messages("messages", "Messages", Icons.Rounded.Forum),
    Events("tasks", "Events", Icons.Rounded.CheckCircle),
    Board("board", "Board", Icons.Rounded.GridView),
    Documents("documents", "Documents", Icons.Rounded.Description),
    Tools("tools", "Tools", Icons.Rounded.Build),
    Routines("routines", "Routines", Icons.Rounded.Schedule),
    Skills("skills", "Skills", Icons.Rounded.School),
    Connections("connections", "Connections", Icons.Rounded.Hub),
    Activity("activity", "Activity", Icons.Rounded.History),
    Settings("settings", "Settings", Icons.Rounded.Settings),
}

private const val TOOL_VIEW_ROUTE = "toolview/{url}"
private const val CONVERSATION_ROUTE = "conversation/{id}"
private const val CHAT_SESSIONS_ROUTE = "chatsessions"

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
                // The animated gradient canvas sits behind every screen — the
                // Android counterpart of the desktop's body::before bloom layers.
                AtmosphereBackground {
                    when (val auth = state.auth) {
                        is AuthState.Unknown -> Box(Modifier.fillMaxSize())
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
            Destination.Events -> viewModel.refreshTasks()
            Destination.Messages -> viewModel.refreshChannels()
            Destination.Board -> viewModel.refreshNotes()
            Destination.Documents -> viewModel.refreshDocuments()
            Destination.Tools -> viewModel.refreshTools()
            Destination.Routines -> viewModel.refreshRoutines()
            Destination.Skills -> viewModel.refreshSkills()
            Destination.Connections -> viewModel.refreshConnections()
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
                unread = state.totalUnread,
                routinesEnabled = state.routinesEnabled,
                skillsEnabled = state.skillsMode != "off",
                connectionsEnabled = state.mcpMode != "off" &&
                    (state.auth as? AuthState.Authenticated)?.user?.role == "admin",
                onSelect = { dest ->
                    scope.launch { drawerState.close() }
                    val alreadyHere = currentDestination?.hierarchy?.any { it.route == dest.route } == true
                    if (!alreadyHere) navigateTo(dest)
                },
            )
        },
    ) {
        // No app bar — a floating menu button (bottom of this block) opens the
        // drawer, reclaiming the space the bar used to take. Hidden on the tool
        // WebView and inside a conversation (both have their own top-left nav).
        val showMenuButton = !onToolView && currentDestination?.route != CONVERSATION_ROUTE
        Scaffold(
            containerColor = Color.Transparent,
        ) { padding ->
          Box(Modifier.fillMaxSize()) {
            NavHost(
                navController = navController,
                startDestination = Destination.Chat.route,
                modifier = Modifier.padding(padding),
                enterTransition = {
                    slideInHorizontally(tween(280)) { it / 12 } + fadeIn(tween(220))
                },
                exitTransition = { fadeOut(tween(140)) },
                popEnterTransition = {
                    slideInHorizontally(tween(280)) { -it / 12 } + fadeIn(tween(220))
                },
                popExitTransition = {
                    slideOutHorizontally(tween(200)) { it / 10 } + fadeOut(tween(160))
                },
            ) {
                composable(Destination.Chat.route) {
                    ChatScreen(
                        messages = state.chatMessages,
                        sending = state.chatSending,
                        voiceEnabled = state.voiceEnabled,
                        transcribing = state.chatTranscribing,
                        onSend = viewModel::sendChat,
                        onTranscribe = viewModel::transcribeVoice,
                        onReferenceClick = viewModel::openReferenceDetail,
                        onNewChat = viewModel::startNewChatSession,
                        onOpenHistory = { navController.navigate(CHAT_SESSIONS_ROUTE) },
                        tools = state.tools,
                        onRefreshTools = viewModel::refreshTools,
                    )
                }
                composable(CHAT_SESSIONS_ROUTE) {
                    ChatSessionsScreen(
                        sessions = state.chatSessions,
                        onRefresh = viewModel::refreshChatSessions,
                        onOpen = { id ->
                            viewModel.openChatSession(id)
                            navController.popBackStack()
                        },
                        onDelete = viewModel::deleteChatSession,
                    )
                }
                composable(Destination.Messages.route) {
                    MessagesScreen(
                        channels = state.channels,
                        familyMembers = state.familyMembers,
                        currentUserId = (state.auth as? AuthState.Authenticated)?.user?.id ?: "",
                        onOpenChannel = { id -> navController.navigate("conversation/$id") },
                        onStartConversation = { memberIds, name ->
                            viewModel.startConversation(memberIds, name) { id ->
                                navController.navigate("conversation/$id")
                            }
                        },
                        onRefresh = viewModel::refreshChannels,
                    )
                }
                composable(CONVERSATION_ROUTE) { entry ->
                    val id = entry.arguments?.getString("id") ?: ""
                    DisposableEffect(id) {
                        viewModel.openChannel(id)
                        onDispose { viewModel.closeChannel() }
                    }
                    ConversationScreen(
                        channel = state.activeChannel,
                        messages = state.channelMessages,
                        sending = state.channelSending,
                        currentUserId = (state.auth as? AuthState.Authenticated)?.user?.id ?: "",
                        onSend = viewModel::sendChannelMessage,
                        onDelete = {
                            viewModel.deleteChannel(id) { navController.popBackStack() }
                        },
                        onBack = {
                            viewModel.closeChannel()
                            navController.popBackStack()
                        },
                    )
                }
                composable(Destination.Board.route) {
                    BoardScreen(
                        notes = state.notes,
                        scope = state.noteScope,
                        onScope = viewModel::setNoteScope,
                        onAddBlank = viewModel::addBlankNote,
                        onEdit = viewModel::editNote,
                        onMove = viewModel::moveNote,
                        onDelete = viewModel::deleteNote,
                        onRefresh = { viewModel.refreshNotes() },
                    )
                }
                composable(Destination.Events.route) {
                    TasksScreen(
                        tasks = state.tasks,
                        taskView = state.taskView,
                        calAnchor = state.calAnchor,
                        onAdd = viewModel::addTask,
                        onComplete = viewModel::completeTask,
                        onReschedule = viewModel::rescheduleTask,
                        onSetTaskView = viewModel::setTaskView,
                        onShiftRange = viewModel::shiftCalRange,
                        onResetRange = viewModel::resetCalRange,
                    )
                }
                composable(Destination.Documents.route) {
                    DocumentsScreen(
                        documents = state.documents,
                        uploadStatus = state.documentUploadStatus,
                        searchQuery = state.documentSearchQuery,
                        searchMode = state.documentSearchMode,
                        searchResults = state.documentSearchResults,
                        searching = state.documentSearching,
                        semanticEnabled = state.semanticSearchEnabled,
                        onSearchChange = viewModel::setDocumentSearch,
                        onIngest = viewModel::ingestDocument,
                        onUpload = viewModel::uploadDocument,
                        onDelete = viewModel::deleteDocument,
                        onRetry = viewModel::retryExtraction,
                        onPreview = viewModel::openDocumentDetail,
                        onRename = viewModel::renameDocument,
                        onSuggestName = viewModel::suggestDocumentName,
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
                composable(Destination.Routines.route) {
                    RoutinesScreen(
                        routines = state.routines,
                        status = state.routineStatus,
                        runs = state.routineRuns,
                        channels = state.channels,
                        onSave = viewModel::saveRoutine,
                        onSetEnabled = viewModel::setRoutineEnabled,
                        onRunNow = viewModel::runRoutineNow,
                        onDelete = viewModel::deleteRoutine,
                        onLoadRuns = viewModel::loadRoutineRuns,
                        onRefresh = viewModel::refreshRoutines,
                    )
                }
                composable(Destination.Skills.route) {
                    SkillsScreen(
                        skills = state.skills,
                        status = state.skillStatus,
                        scriptsRunnable = state.skillScriptsRunnable,
                        isAdmin = (state.auth as? AuthState.Authenticated)?.user?.role == "admin",
                        onRefresh = viewModel::refreshSkills,
                        onLoadBody = viewModel::loadSkillBody,
                        onSave = viewModel::saveSkill,
                        onDraft = viewModel::draftSkill,
                        onSetEnabled = viewModel::setSkillEnabled,
                        onDelete = viewModel::deleteSkill,
                    )
                }
                composable(Destination.Connections.route) {
                    ConnectionsScreen(
                        servers = state.mcpServers,
                        status = state.mcpStatus,
                        onRefresh = viewModel::refreshConnections,
                        onSave = viewModel::saveMcpServer,
                        onSetEnabled = viewModel::setMcpServerEnabled,
                        onProbe = viewModel::probeMcpServer,
                        onDelete = viewModel::deleteMcpServer,
                    )
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

            if (showMenuButton) {
                Box(
                    Modifier
                        .align(Alignment.TopStart)
                        .statusBarsPadding()
                        .padding(start = 12.dp, top = 6.dp)
                        .shadow(5.dp, RoundedCornerShape(13.dp))
                        .clip(RoundedCornerShape(13.dp))
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.9f))
                        .clickable { scope.launch { drawerState.open() } }
                        .size(42.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Rounded.Menu,
                        contentDescription = "Open menu",
                        tint = MaterialTheme.colorScheme.primary,
                    )
                }
            }
          }
        }
    }

    state.detail?.let { detail ->
        DetailSheet(content = detail, onDismiss = viewModel::closeDetail)
    }
}

/** The project logo — a family "huddle" of circles with the assistant (accent
 *  blue) nestled among them. Same image as the desktop app and the launcher
 *  icon; see docs/DECISIONS.md. */
@Composable
private fun BrandMark(size: Int = 30) {
    Image(
        painter = painterResource(R.drawable.logo),
        contentDescription = null,
        modifier = Modifier.size(size.dp).clip(RoundedCornerShape((size * 0.32f).dp)),
    )
}

/**
 * The collapsible sidebar: brand mark + wordmark, nav items with an accent-soft
 * pill behind the active one, and a connection pill pinned to the footer.
 */
@Composable
private fun AppDrawer(
    current: NavDestination?,
    connection: ConnectionStatus,
    unread: Int,
    routinesEnabled: Boolean,
    skillsEnabled: Boolean,
    connectionsEnabled: Boolean,
    onSelect: (Destination) -> Unit,
) {
    ModalDrawerSheet(
        drawerContainerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f),
        drawerShape = RoundedCornerShape(topEnd = 26.dp, bottomEnd = 26.dp),
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
                if (dest == Destination.Routines && !routinesEnabled) return@forEach
                if (dest == Destination.Skills && !skillsEnabled) return@forEach
                if (dest == Destination.Connections && !connectionsEnabled) return@forEach
                val selected = current?.hierarchy?.any { it.route == dest.route } == true
                NavigationDrawerItem(
                    label = {
                        Text(
                            dest.label,
                            style = MaterialTheme.typography.titleSmall,
                        )
                    },
                    badge = {
                        if (dest == Destination.Messages && unread > 0) {
                            Badge { Text(if (unread > 99) "99+" else unread.toString()) }
                        }
                    },
                    icon = { Icon(dest.icon, contentDescription = null, modifier = Modifier.size(22.dp)) },
                    selected = selected,
                    onClick = { onSelect(dest) },
                    shape = RoundedCornerShape(14.dp),
                    colors = NavigationDrawerItemDefaults.colors(
                        selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                        unselectedContainerColor = Color.Transparent,
                        selectedIconColor = MaterialTheme.colorScheme.primary,
                        unselectedIconColor = AppAccents.textSecondary,
                        selectedTextColor = MaterialTheme.colorScheme.primary,
                        unselectedTextColor = MaterialTheme.colorScheme.onBackground,
                    ),
                    modifier = Modifier.padding(vertical = 2.dp),
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
