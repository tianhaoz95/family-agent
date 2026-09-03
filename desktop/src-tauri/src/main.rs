// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

/// Holds the agent-core child process so it can be reaped on shutdown.
/// Dev-only wiring: launches `node dist/server.js` directly from the
/// workspace via a compile-time path. Packaging this as a bundled sidecar
/// binary (per docs/architecture "managed download" runtime) is future work
/// — see docs/DECISIONS.md.
struct AgentCoreProcess(Mutex<Option<Child>>);

/// Ports agent-core binds: the HTTP API and the tools server.
const AGENT_CORE_PORTS: [u16; 2] = [4173, 4174];

fn agent_core_dir() -> PathBuf {
    // desktop/src-tauri -> ../../agent-core
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("agent-core")
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
    match std::fs::read(format!("/proc/{pid}/cmdline")) {
        Ok(bytes) => {
            let cmdline = String::from_utf8_lossy(&bytes);
            cmdline.contains("agent-core") || cmdline.contains("server.js")
        }
        // /proc unavailable (macOS): assume it's ours — the port is ours by convention.
        Err(_) => true,
    }
}

#[cfg(not(unix))]
fn kill_stale_agent_core() {}

fn spawn_agent_core() -> std::io::Result<Child> {
    let dir = agent_core_dir();
    let entry = dir.join("dist").join("server.js");
    let mut cmd = Command::new("node");
    cmd.arg(entry)
        .current_dir(&dir)
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
    #[cfg(unix)]
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentCoreProcess(Mutex::new(None)))
        .setup(|app| {
            kill_stale_agent_core();
            match spawn_agent_core() {
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
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state = window.state::<AgentCoreProcess>();
                let mut guard = state.0.lock().unwrap();
                if let Some(mut child) = guard.take() {
                    shutdown_child(&mut child);
                }
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
