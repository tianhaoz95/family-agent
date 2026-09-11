import SwiftUI

enum Destination: String, CaseIterable, Identifiable, Hashable {
    case chat, messages, events, board, documents, tools, artifacts, routines, skills, connections, vault, activity, settings
    var id: String { rawValue }

    var label: String {
        switch self {
        case .chat: "Chat"; case .messages: "Messages"; case .events: "Events"
        case .board: "Board"; case .documents: "Documents"; case .tools: "Tools"
        case .artifacts: "Artifacts"
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
        case .artifacts: "rectangle.on.rectangle.angled"
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
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: Destination = {
        #if DEBUG
        if let s = ProcessInfo.processInfo.environment["FA_START"],
           let d = Destination(rawValue: s) { return d }
        #endif
        return .chat
    }()
    @State private var drawerOpen = false
    @State private var dragOffset: CGFloat = 0
    /// A channel id from a tapped notification, latched here (not just read
    /// off `model.pendingNotificationNav`, which gets cleared as soon as
    /// it's consumed) so MessagesView can seed its own navigation with it.
    @State private var pendingChannelId: String?

    private let drawerWidth: CGFloat = 300

    private var visibleDestinations: [Destination] {
        Destination.allCases.filter { d in
            switch d {
            case .artifacts: return model.artifactsMode == "on"
            case .routines: return model.routinesEnabled
            case .skills: return model.skillsMode != "off"
            case .connections: return model.mcpMode != "off" && model.isAdmin
            case .vault: return model.vaultMode == "on"
            default: return true
            }
        }
    }

    /// Hidden inside a conversation, or a pushed artifact viewer (each has its
    /// own back control) — matches Android.
    private var showMenuButton: Bool { model.activeChannel == nil && !model.artifactViewerPushed }

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

            // Scrim — dims + captures taps whenever the drawer is even partly open.
            Color.black
                .opacity(0.35 * openFraction)
                .ignoresSafeArea()
                .allowsHitTesting(openFraction > 0.01)
                .onTapGesture { close() }

            // Drawer — always mounted, slid off-screen when closed.
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
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .offset(x: -drawerWidth + openFraction * drawerWidth)
        }
        .animation(.snappy(duration: 0.3), value: drawerOpen)
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
        // Feeds AppModel so it can tell, at the moment a reply lands,
        // whether the user is already looking at that exact conversation
        // (Chat — a specific channel is tracked via `model.activeChannel`
        // already) and skip a redundant notification.
        .onChange(of: scenePhase, initial: true) { _, phase in model.isAppForeground = phase == .active }
        .onChange(of: selection, initial: true) { _, d in model.isChatScreenActive = d == .chat }
        // A tapped "reply is ready" notification — jump straight there.
        .onChange(of: model.pendingNotificationNav) { _, nav in
            guard let nav else { return }
            switch nav {
            case .chat(let sessionId):
                model.openChatSession(sessionId)
                selection = .chat
            case .channel(let channelId):
                pendingChannelId = channelId
                selection = .messages
            }
            model.pendingNotificationNav = nil
        }
    }

    // MARK: pieces

    private var menuButton: some View {
        Button { open() } label: {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.accentInk)
                .frame(width: 42, height: 42)
                .background(.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
                .elevation(Theme.E.pop)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.92))
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
                // Max reading measure. Inert while the app ships iPhone-only (the
                // widest phone is ~440pt), but it's what keeps a wider device from
                // stretching a document summary past 130 characters a line, so it
                // stays here for whenever iPad is claimed again.
                destinationView(d)
                    .frame(maxWidth: 700)
                    .frame(maxWidth: .infinity)
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .tint(Theme.accent)
    }

    @ViewBuilder
    private func destinationView(_ d: Destination) -> some View {
        switch d {
        case .chat:        ChatView()
        case .messages:    MessagesView(initialChannelId: pendingChannelId, onConsumedInitialRoute: { pendingChannelId = nil })
        case .events:      TasksView()
        case .board:       BoardView()
        case .documents:   DocumentsView()
        case .tools:       ToolsView()
        case .artifacts:   ArtifactsView()
        case .routines:    RoutinesView()
        case .skills:      SkillsView()
        case .connections: ConnectionsView()
        case .vault:       VaultView()
        case .activity:    ActivityView()
        case .settings:    SettingsView()
        }
    }

    // MARK: drawer open/close + drag

    /// 0 = fully closed, 1 = fully open. Driven by `drawerOpen`, nudged live by a drag.
    private var openFraction: CGFloat {
        let fromState: CGFloat = drawerOpen ? 1 : 0
        return max(0, min(1, fromState + dragOffset / drawerWidth))
    }

    private func open() { withAnimation(.snappy(duration: 0.3)) { drawerOpen = true; dragOffset = 0 } }
    private func close() { withAnimation(.snappy(duration: 0.3)) { drawerOpen = false; dragOffset = 0 } }

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

    private let clip = UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 0,
                                              bottomTrailingRadius: 28, topTrailingRadius: 28, style: .continuous)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Image("Logo")
                    .resizable().scaledToFit()
                    .frame(width: 36, height: 36)
                    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
                    .elevation(Theme.E.sm)
                Text("Family Agent").font(.inter(19, .semibold)).tracking(-0.4).foregroundStyle(Theme.text)
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .padding(.bottom, 20)

            ScrollView {
                VStack(spacing: 3) {
                    ForEach(destinations) { d in
                        let selected = d == selection
                        Button { onSelect(d) } label: {
                            HStack(spacing: 13) {
                                // One pinned weight + scale for every glyph: at the
                                // default weight the denser symbols (wrench, graduation
                                // cap) read much heavier than the sparse ones (doc, clock).
                                Image(systemName: d.systemImage)
                                    .font(.system(size: 16.5, weight: .medium))
                                    .imageScale(.medium)
                                    .symbolRenderingMode(.monochrome)
                                    .frame(width: 24)
                                Text(d.label).font(.inter(14.5, selected ? .semibold : .medium)).tracking(-0.1)
                                Spacer()
                                if d == .messages && unread > 0 {
                                    Text(unread > 99 ? "99+" : "\(unread)")
                                        .font(.inter(11, .bold)).foregroundStyle(.white)
                                        .padding(.horizontal, 6).padding(.vertical, 2)
                                        .background(Theme.accent, in: Capsule())
                                }
                            }
                            .foregroundStyle(selected ? Theme.accentInk : Theme.textStrong)
                            .padding(.horizontal, 13).padding(.vertical, 11)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background {
                                if selected {
                                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                                        .fill(Theme.accentSoft)
                                        .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous)
                                            .strokeBorder(Theme.accentInk.opacity(0.10), lineWidth: 1))
                                }
                            }
                            // Without this the tap target is only the glyph + text
                            // (an unselected row draws no background) — the padding
                            // and the trailing gap swallow taps, so a row needs a
                            // few tries to hit. Make the whole row hittable.
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(PressScaleStyle(scale: 0.97))
                    }
                }
                .padding(.bottom, 8)
            }
            .scrollIndicators(.hidden)

            ConnectionPill(connection: connection).padding(.top, 10)
        }
        .padding(.horizontal, 14)
        .padding(.top, 24)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            clip.fill(Theme.surface)
        }
        .glass(.chrome, in: clip)
        .overlay(clip.strokeBorder(.white.opacity(0.4), lineWidth: 1))
        .clipShape(clip)
        .shadow(color: Color(hex: 0x2A2420).opacity(0.22), radius: 24, x: 8, y: 0)
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
            Text(label).font(.inter(12.5, .medium)).foregroundStyle(Theme.textMuted).lineLimit(1)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceSunk, in: RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.R.md, style: .continuous).strokeBorder(Theme.border, lineWidth: 1))
    }
}
