// Lets a phone (iOS/Android) trigger an update-and-restart of the desktop
// app that's hosting this server, without anyone touching the laptop. This
// module only holds the ephemeral hand-off state between the two sides —
// the actual update mechanics (Tauri's updater plugin, downloadAndInstall,
// relaunch) only exist in the desktop frontend's webview, which agent-core
// has no handle on. So the flow is a plain poll:
//
//   1. A phone calls POST /system/update-request (admin-only — this
//      restarts the shared server for the whole household).
//   2. The desktop frontend polls GET /system/update-status every few
//      seconds; on seeing "requested" it runs the SAME check → download →
//      install → relaunch sequence its own manual "Check for updates"
//      button uses (see desktop/src/main.ts's performUpdateInstall), and
//      reports progress back via POST /system/update-report.
//   3. Every client (including the one that triggered it) can poll GET
//      /system/update-status to show progress, right up until the process
//      restarts out from under the connection — at that point the normal
//      "reconnecting" UI takes over, same as any other server restart.
//
// In-memory only, process-wide (like ToolSupervisor / RoutineScheduler) —
// there's nothing to persist across a restart, since the restart is the
// point, and a fresh process naturally comes back up "idle".
export interface DesktopUpdateStatus {
  state: "idle" | "requested" | "checking" | "no-update" | "downloading" | "installing" | "restarting" | "error";
  /** Human-readable detail — a version string, an error message, etc. */
  message?: string;
  /** Download progress 0-100, when known. */
  percent?: number;
  requestedAt?: string;
  requestedBy?: string;
}

let current: DesktopUpdateStatus = { state: "idle" };

export function getDesktopUpdateStatus(): DesktopUpdateStatus {
  return current;
}

/** Only the trigger is privileged — reading/reporting status leaks nothing
 * sensitive, and gating them to admin would break reporting on a shared
 * desktop currently signed in as a non-admin family member. */
export function requestDesktopUpdate(requestedBy: string): DesktopUpdateStatus {
  current = { state: "requested", requestedAt: new Date().toISOString(), requestedBy };
  return current;
}

export function reportDesktopUpdateStatus(patch: Omit<DesktopUpdateStatus, "requestedAt" | "requestedBy">): DesktopUpdateStatus {
  // Keep requestedAt/requestedBy around through the whole run so a client
  // that starts polling mid-flight still sees who asked for this.
  current = { ...patch, requestedAt: current.requestedAt, requestedBy: current.requestedBy };
  return current;
}

/** Test-only: drop back to a clean slate between test cases. */
export function resetDesktopUpdateStatus(): void {
  current = { state: "idle" };
}
