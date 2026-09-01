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

fn agent_core_dir() -> PathBuf {
    // desktop/src-tauri -> ../../agent-core
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("agent-core")
}

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
    // any means, so there is no path that leaks the sidecar.
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

fn main() {
    tauri::Builder::default()
        .manage(AgentCoreProcess(Mutex::new(None)))
        .setup(|app| {
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
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running family-agent-desktop");
}
