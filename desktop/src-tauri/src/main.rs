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
    std::thread::sleep(std::time::Duration::from_millis(600));
    for &pid in &pids {
        // Still alive? escalate. `kill(pid, 0)` returns 0 while the pid exists.
        if unsafe { libc::kill(pid, 0) } == 0 {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
    // Give the OS a beat to release the socket before we spawn a replacement.
    std::thread::sleep(std::time::Duration::from_millis(200));
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
