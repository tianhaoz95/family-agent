// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

/// Holds the agent-core child process so it can be reaped on shutdown.
///
/// Two wirings, picked at runtime by [`resolve_agent_core`]:
/// - **dev / local build**: `node <repo>/agent-core/dist/server.js` via the
///   compile-time `CARGO_MANIFEST_DIR` path — used whenever that path exists.
/// - **bundled app**: the `node` binary and `agent-core/` tree are shipped as
///   Tauri resources (see `tauri.conf.json` `bundle.resources` +
///   `desktop/scripts/prepare-sidecar.sh`) and resolved under
///   `resource_dir()`, so a distributed `.app`/`.dmg` is self-contained.
struct AgentCoreProcess(Mutex<Option<Child>>);

/// Ports agent-core binds: the HTTP API and the tools server.
const AGENT_CORE_PORTS: [u16; 2] = [4173, 4174];

/// How to launch the agent-core sidecar for this build.
struct AgentCoreLaunch {
    /// The `node` executable (system `node` in dev, the bundled binary in a packaged app).
    node: PathBuf,
    /// `dist/server.js` to run.
    entry: PathBuf,
    /// Working directory for the child (the `agent-core` root).
    cwd: PathBuf,
}

/// Repo checkout path baked in at compile time — present for `tauri dev` and a
/// `tauri build` run from the same checkout, absent in a `.app` copied elsewhere.
fn repo_agent_core_dir() -> PathBuf {
    // desktop/src-tauri -> ../../agent-core
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("agent-core")
}

/// Decide how to launch the sidecar: prefer the bundled resource copy (a real
/// packaged app), fall back to the repo checkout + system `node` (dev).
///
/// `desktop/scripts/prepare-sidecar.sh` stages a production install of
/// agent-core plus a copy of the `node` binary under
/// `desktop/src-tauri/sidecar/`, which `tauri.conf.json` ships as
/// `bundle.resources` — so in a packaged app they land at
/// `<resource_dir>/sidecar/{agent-core,node}`.
fn resolve_agent_core(app: &tauri::App) -> AgentCoreLaunch {
    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled_core = res_dir.join("sidecar").join("agent-core");
        let bundled_entry = bundled_core.join("dist").join("server.js");
        let bundled_node = res_dir.join("sidecar").join("node");
        if bundled_entry.exists() {
            let node = if bundled_node.exists() {
                bundled_node
            } else {
                PathBuf::from("node")
            };
            return AgentCoreLaunch {
                node,
                entry: bundled_entry,
                cwd: bundled_core,
            };
        }
    }
    let repo = repo_agent_core_dir();
    AgentCoreLaunch {
        node: PathBuf::from("node"),
        entry: repo.join("dist").join("server.js"),
        cwd: repo,
    }
}

/// Kill any agent-core left listening on our ports from a previous run.
///
/// `tauri:dev` rebuilds respawn this process without always tearing the Node
/// child down cleanly (PR_SET_PDEATHSIG can be skipped on an abrupt exit, and
/// the child then gets reparented to init/systemd and keeps holding the port).
/// A fresh agent-core would then race — or lose — the bind and the app would
/// silently talk to stale code. Clearing the ports first makes startup
/// deterministic. Best-effort and Unix-only; failures are ignored.
#[cfg(unix)]
fn kill_stale_agent_core() {
    // `-a` ANDs the selectors: LISTEN sockets AND (port 4173 OR 4174). Without
    // `-a` / `-sTCP:LISTEN` lsof also matches those numbers as ephemeral *source*
    // ports on unrelated connections.
    let mut args = vec!["-ti".to_string(), "-a".to_string(), "-sTCP:LISTEN".to_string()];
    args.extend(AGENT_CORE_PORTS.iter().map(|p| format!("-itcp:{p}")));
    let Ok(out) = Command::new("lsof").args(&args).output() else {
        return;
    };
    let pids: Vec<i32> = String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .filter_map(|s| s.parse::<i32>().ok())
        .filter(|&pid| pid > 1 && pid != std::process::id() as i32)
        .filter(is_agent_core_pid)
        .collect();
    if pids.is_empty() {
        return;
    }
    for &pid in &pids {
        eprintln!("family-agent-desktop: reaping stale agent-core (pid {pid})");
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    // Wait for a graceful exit (agent-core's SIGTERM handler tears down the Deno
    // tool supervisor and inbox watchers, which takes a moment), then escalate.
    let pid_alive = |pid: i32| unsafe { libc::kill(pid, 0) } == 0;
    for _ in 0..30 {
        if !pids.iter().any(|&p| pid_alive(p)) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    for &pid in &pids {
        if pid_alive(pid) {
            eprintln!("family-agent-desktop: stale agent-core (pid {pid}) didn't exit — SIGKILL");
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
    // The kernel can hold the listening sockets briefly after the process dies
    // (no SO_REUSEADDR on the Node side). agent-core exits(1) if its tools
    // server can't bind config.toolsPort — which surfaced as a permanently
    // blank window — so wait until *both* ports actually accept a bind before
    // spawning the replacement.
    for _ in 0..50 {
        if AGENT_CORE_PORTS
            .iter()
            .all(|&p| std::net::TcpListener::bind(("0.0.0.0", p)).is_ok())
        {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    eprintln!("family-agent-desktop: agent-core ports still busy after cleanup — starting anyway");
}

/// Guard against killing an unrelated process that happens to hold the port:
/// only reap it if its cmdline actually looks like our sidecar.
#[cfg(unix)]
fn is_agent_core_pid(pid: &i32) -> bool {
    // Linux: read /proc directly.
    #[cfg(target_os = "linux")]
    {
        return match std::fs::read(format!("/proc/{pid}/cmdline")) {
            Ok(bytes) => {
                let cmdline = String::from_utf8_lossy(&bytes);
                cmdline.contains("agent-core") || cmdline.contains("server.js")
            }
            Err(_) => false,
        };
    }
    // macOS: no /proc — ask `ps` for the full command line.
    #[cfg(target_os = "macos")]
    {
        return match Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
        {
            Ok(out) => {
                let cmdline = String::from_utf8_lossy(&out.stdout);
                cmdline.contains("agent-core") || cmdline.contains("server.js")
            }
            Err(_) => false,
        };
    }
    // Other unix: be conservative and don't signal an unknown process.
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        false
    }
}

#[cfg(not(unix))]
fn kill_stale_agent_core() {}

fn spawn_agent_core(launch: &AgentCoreLaunch) -> std::io::Result<Child> {
    let mut cmd = Command::new(&launch.node);
    cmd.arg(&launch.entry)
        .current_dir(&launch.cwd)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    // The graceful path (on_window_event below) only runs when Tauri's own
    // event loop gets to shut down cleanly. A `kill -9` or crash on this
    // process skips that entirely and orphans the Node child — confirmed by
    // hand while testing (see docs/BUILD_LOG.md). PR_SET_PDEATHSIG makes the
    // kernel send SIGTERM to the child the moment *this* process dies, by
    // any means, so there is no path that leaks the sidecar. Belt-and-braces
    // with kill_stale_agent_core() above, which cleans up anything that still
    // slipped through from an earlier run.
    //
    // Linux-only: `PR_SET_PDEATHSIG` is a Linux prctl (not in the `libc` crate
    // on macOS). On macOS the graceful shutdown handlers plus
    // `kill_stale_agent_core()` at next launch cover sidecar cleanup.
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }

    cmd.spawn()
}

/// SIGTERM first so agent-core's own handler can stop the Deno tool supervisor
/// and close the inbox watcher, then SIGKILL as a fallback. `Child::kill()`
/// alone is a bare SIGKILL, which can leave the supervisor's subprocesses
/// behind.
fn shutdown_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe { libc::kill(pid, libc::SIGTERM) };
        for _ in 0..20 {
            match child.try_wait() {
                Ok(Some(_)) => return,
                _ => std::thread::sleep(std::time::Duration::from_millis(50)),
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Grant the WebKitGTK webview permission for `getUserMedia` (the microphone,
/// used by Chat's voice-input button).
///
/// Unlike a browser, WebKitGTK does **not** show an interactive permission
/// prompt — its default `permission-request` handler flatly denies media
/// capture, so without this the mic button can never work on Linux (it works
/// out of the box on macOS/Windows and in the `npm run dev` browser build).
/// The webview only ever loads our own bundled `dist/` assets and talks to
/// localhost, and the user has to click the mic button to trigger a request,
/// so auto-approving is consistent with how the rest of the app treats local
/// device access.
#[cfg(target_os = "linux")]
fn grant_webview_media_permission(app: &tauri::App) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        eprintln!("family-agent-desktop: no 'main' webview — voice input permission not wired");
        return;
    };
    let result = window.with_webview(|webview| {
        use webkit2gtk::{PermissionRequestExt, WebViewExt};
        webview.inner().connect_permission_request(|_webview, request| {
            request.allow();
            true
        });
    });
    if let Err(err) = result {
        eprintln!("family-agent-desktop: could not reach the webview for mic permission: {err}");
    }
}

/// Best-effort system tray icon: Open / status / Quit. Not load-bearing for
/// correctness — if it fails to build (missing tray host, older Linux setup
/// with no libayatana-appindicator, etc.) the app still works fully via the
/// two safety nets that don't depend on it: relaunching the app (see the
/// single-instance plugin below) and the in-app "Quit Family Agent" button
/// in Settings. See docs/DECISIONS.md.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let open_item = MenuItem::with_id(app, "open", "Open Family Agent", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &separator, &quit_item])?;

    let builder = TrayIconBuilder::new()
        // Embedded at compile time (not app.default_window_icon(), which
        // doesn't reliably resolve to the real app icon under `cargo run`/
        // `tauri dev` — confirmed by hand: it showed a generic icon there).
        // Works identically in dev and in a bundled build either way.
        .icon(tauri::include_image!("icons/128x128.png"))
        .tooltip("Family Agent")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    builder.build(app)?;
    Ok(())
}

/// Called from the frontend's Settings "Quit Family Agent" button — the
/// in-app escape hatch that fully stops the app (and, via RunEvent::Exit,
/// agent-core with it) without depending on a visible tray menu.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        // Must be the first plugin registered (Tauri's own requirement).
        // Without it, launching the app a second time while it's hidden in
        // the tray would just spawn a second instance instead of surfacing
        // the existing window — the universal "get my window back" path
        // that doesn't depend on the tray icon being visible (see
        // build_tray above and docs/DECISIONS.md).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        // Updater. The frontend drives it (Settings > "Check for updates"), so
        // there is nothing to configure here beyond registering the plugin;
        // endpoint and public key live in tauri.conf.json. `process` is what
        // relaunches the app after an update installs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![quit_app])
        .manage(AgentCoreProcess(Mutex::new(None)))
        .setup(|app| {
            kill_stale_agent_core();
            let launch = resolve_agent_core(app);
            eprintln!(
                "family-agent-desktop: launching agent-core: {} {}",
                launch.node.display(),
                launch.entry.display()
            );
            match spawn_agent_core(&launch) {
                Ok(child) => {
                    let state = app.state::<AgentCoreProcess>();
                    *state.0.lock().unwrap() = Some(child);
                }
                Err(err) => {
                    eprintln!(
                        "family-agent-desktop: failed to launch agent-core ({err}). \
                         Is Node.js installed and has `npm run build` been run in agent-core/?"
                    );
                }
            }
            #[cfg(target_os = "linux")]
            grant_webview_media_permission(app);
            if let Err(err) = build_tray(app) {
                eprintln!(
                    "family-agent-desktop: could not create a tray icon ({err}) — \
                     the app still works; use the in-app Quit button in Settings to stop it."
                );
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // A normal close hides the window instead of destroying it, so
            // agent-core keeps running for other devices on the network —
            // see docs/DECISIONS.md. Destroyed is kept as a defensive
            // fallback (harmless if it fires after the child was already
            // reaped elsewhere: `guard.take()` is a no-op the second time).
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Destroyed => {
                    let state = window.state::<AgentCoreProcess>();
                    let mut guard = state.0.lock().unwrap();
                    if let Some(mut child) = guard.take() {
                        shutdown_child(&mut child);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running family-agent-desktop")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AgentCoreProcess>();
                let mut guard = state.0.lock().unwrap();
                if let Some(mut child) = guard.take() {
                    shutdown_child(&mut child);
                }
            }
        });
}
