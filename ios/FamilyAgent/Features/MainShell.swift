import SwiftUI

enum Destination: String, CaseIterable, Identifiable, Hashable {
    case chat, messages, events, board, documents, tools, routines, skills, connections, vault, activity, settings
    var id: String { rawValue }

    var label: String {
        switch self {
        case .chat: "Chat"; case .messages: "Messages"; case .events: "Events"
        case .board: "Board"; case .documents: "Documents"; case .tools: "Tools"
        case .routines: "Routines"; case .skills: "Skills"; case .connections: "Connections"
        case .vault: "Vault"; case .activity: "Activity"; case .settings: "Settings"
        }
    }
    var systemImage: String {
        switch self {
        case .chat: "bubble.left.and.bubble.right"
        case .messages: "text.bubble"
        case .events: "checkmark.circle"
        case .board: "square.grid.2x2"
        case .documents: "doc.text"
        case .tools: "wrench.and.screwdriver"
        case .routines: "clock.arrow.circlepath"
        case .skills: "graduationcap"
        case .connections: "point.3.connected.trianglepath.dotted"
        case .vault: "lock"
        case .activity: "clock"
        case .settings: "gearshape"
        }
    }
}

/// Android-style: Chat is the home surface; a drawer slides in over the content
/// to switch views, then dismisses. Mirrors `MainActivity`'s `ModalNavigationDrawer`
/// (not a master-detail / "main menu" push). A floating menu button opens it;
/// an edge swipe does too.
struct MainShell: View {
    @Environment(AppModel.self) private var model
    @State private var selection: Destination = {
        #if DEBUG
        if let s = ProcessInfo.processInfo.environment["FA_START"],
           let d = Destination(rawValue: s) { return d }
        #endif
        return .chat
    }()
    @State private var drawerOpen = false
    @State private var dragOffset: CGFloat = 0

    private let drawerWidth: CGFloat = 300

    private var visibleDestinations: [Destination] {
        Destination.allCases.filter { d in
            switch d {
            case .routines: return model.routinesEnabled
            case .skills: return model.skillsMode != "off"
            case .connections: return model.mcpMode != "off" && model.isAdmin
            case .vault: return model.vaultMode == "on"
            default: return true
            }
        }
    }

    /// Hidden inside a conversation (its own back control) — matches Android.
    private var showMenuButton: Bool { model.activeChannel == nil }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Atmosphere().ignoresSafeArea()

            // Content — swapped in place, springy slide+fade like Android's NavHost.
            content(selection)
                .id(selection)
                .transition(.asymmetric(
                    insertion: .move(edge: .trailing).combined(with: .opacity),
                    removal: .opacity
                ))
                .animation(.smooth(duration: 0.28), value: selection)

            if showMenuButton {
                menuButton
                    .transition(.opacity)
            }

            // Scrim + drawer overlay.
            if drawerOpen || dragOffset != 0 {
                Color.black
                    .opacity(0.35 * openFraction)
                    .ignoresSafeArea()
                    .onTapGesture { close() }

                AppDrawer(
                    destinations: visibleDestinations,
                    selection: selection,
                    connection: model.connection,
                    unread: model.totalUnread,
                    onSelect: { d in
                        if d != selection { selection = d }
                        close()
                    }
                )
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity)
                .offset(x: drawerOpenX)
                .transition(.identity)
            }
        }
        .animation(.snappy(duration: 0.28), value: drawerOpen)
        .gesture(edgeSwipe)
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.environment["FA_DRAWER"] == "1" {
                try? await Task.sleep(for: .milliseconds(400))
                open()
            }
            #endif
        }
        .task { await model.refreshStatus() }
        .task {
            while !Task.isCancelled {
                await model.refreshChannels()
                try? await Task.sleep(for: .seconds(8))
            }
        }
        .overlay(alignment: .bottom) { errorBanner }
    }

    // MARK: pieces

    private var menuButton: some View {
        Button { open() } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.accent)
                .frame(width: 42, height: 42)
        }
        .background(.white, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        .padding(.leading, 12)
        .padding(.top, 6)
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let err = model.lastError {
            Text(err)
                .appBodySmall()
                .padding(10)
                .background(Theme.dangerSoft, in: Capsule())
                .foregroundStyle(Theme.dangerInk)
                .padding(.bottom, 24)
                .task {
                    try? await Task.sleep(for: .seconds(4))
                    model.lastError = nil
                }
        }
    }

    @ViewBuilder
    private func content(_ d: Destination) -> some View {
        // Each screen is its own NavigationStack so per-screen sheets /
        // `navigationDestination` (Messages → Conversation) keep working; the
        // nav bar is hidden so the floating menu button + ScreenScaffold titles
        // carry the chrome, exactly like Android's no-app-bar layout.
        NavigationStack {
            ZStack {
                Atmosphere().ignoresSafeArea()
                destinationView(d)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .tint(Theme.accent)
    }

    @ViewBuilder
    private func destinationView(_ d: Destination) -> some View {
        switch d {
        case .chat:        ChatView()
        case .messages:    MessagesView()
        case .events:      TasksView()
        case .board:       BoardView()
        case .documents:   DocumentsView()
        case .tools:       ToolsView()
        case .routines:    RoutinesView()
        case .skills:      SkillsView()
        case .connections: ConnectionsView()
        case .vault:       VaultView()
        case .activity:    ActivityView()
        case .settings:    SettingsView()
        }
    }

    // MARK: drawer open/close + drag

    private var openFraction: CGFloat {
        if drawerOpen { return 1 }
        return max(0, min(1, dragOffset / drawerWidth))
    }
    private var drawerOpenX: CGFloat {
        let base: CGFloat = drawerOpen ? 0 : -drawerWidth
        return base + (drawerOpen ? min(0, dragOffset) : max(0, dragOffset))
    }

    private func open() { withAnimation(.snappy(duration: 0.28)) { drawerOpen = true; dragOffset = 0 } }
    private func close() { withAnimation(.snappy(duration: 0.28)) { drawerOpen = false; dragOffset = 0 } }

    private var edgeSwipe: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { v in
                guard showMenuButton else { return }
                if drawerOpen {
                    dragOffset = v.translation.width      // negative closes
                } else if v.startLocation.x < 24 && v.translation.width > 0 {
                    dragOffset = v.translation.width      // positive opens
                }
            }
            .onEnded { v in
                guard showMenuButton else { return }
                let shouldOpen = drawerOpen
                    ? v.translation.width > -drawerWidth / 3
                    : (v.startLocation.x < 24 && v.translation.width > drawerWidth / 3)
                if shouldOpen { open() } else { close() }
            }
    }
}

// MARK: - Drawer

private struct AppDrawer: View {
    let destinations: [Destination]
    let selection: Destination
    let connection: ConnectionStatus
    let unread: Int
    let onSelect: (Destination) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image("Logo")
                    .resizable().scaledToFit()
                    .frame(width: 34, height: 34)
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                Text("Family Agent").appTitle().foregroundStyle(Theme.text)
            }
            .padding(.horizontal, 8)
            .padding(.top, 8)
            .padding(.bottom, 22)

            ScrollView {
                VStack(spacing: 2) {
                    ForEach(destinations) { d in
                        Button { onSelect(d) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: d.systemImage)
                                    .font(.system(size: 18))
                                    .frame(width: 24)
                                Text(d.label).appTitleSmall()
                                Spacer()
                                if d == .messages && unread > 0 {
                                    Text(unread > 99 ? "99+" : "\(unread)")
                                        .font(.inter(11, .bold)).foregroundStyle(.white)
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(Theme.accent, in: Capsule())
                                }
                            }
                            .foregroundStyle(d == selection ? Theme.accent : Theme.text)
                            .padding(.horizontal, 12).padding(.vertical, 11)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                d == selection ? Theme.accentSoft : Color.clear,
                                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .scrollIndicators(.hidden)

            ConnectionPill(connection: connection)
                .padding(.top, 10)
        }
        .padding(.horizontal, 14)
        .padding(.top, 24)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            // Glass on iOS 26, opaque surface below (no cheap blur — matches Android's call).
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(Theme.surface)
        }
        .glass(.chrome, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .clipShape(
            .rect(topLeadingRadius: 0, bottomLeadingRadius: 0, bottomTrailingRadius: 26, topTrailingRadius: 26)
        )
        .shadow(color: .black.opacity(0.18), radius: 18, x: 6, y: 0)
        .ignoresSafeArea(edges: .bottom)
    }
}

private struct ConnectionPill: View {
    let connection: ConnectionStatus
    var body: some View {
        let (label, color): (String, Color) = {
            switch connection {
            case .connecting: return ("Connecting…", Theme.warn)
            case .connected(let m): return ("Connected · local · \(m)", Theme.ok)
            case .unreachable: return ("Offline — check Settings", Theme.danger)
            }
        }()
        HStack(spacing: 10) {
            StatusDot(color: color)
            Text(label).appLabelSmall().foregroundStyle(Theme.textMuted).lineLimit(1)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceSunk, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
