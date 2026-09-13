// Lets a phone (iOS/Android) trigger an update-and-restart — or a PLAIN
// restart, no update involved — of the desktop app that's hosting this
// server, without anyone touching the laptop. This module only holds the
// ephemeral hand-off state between the two sides — the actual mechanics
// (Tauri's updater plugin, downloadAndInstall, relaunch) only exist in the
// desktop frontend's webview, which agent-core has no handle on. So the
// flow is a plain poll:
//
//   1. A phone calls POST /system/update-request or /system/restart-request
//      (admin-only — either one restarts the shared server for the whole
//      household). Both just set `requestedMode` on the same shared state;
//      see desktop/src/main.ts's pollRemoteUpdateRequest for how it branches.
//   2. The desktop frontend polls GET /system/update-status every few
//      seconds; on seeing "requested" with mode "update" it runs the SAME
//      check → download → install → relaunch sequence its own manual
//      "Check for updates" button uses (performUpdateInstall). Mode
//      "restart" skips straight to relaunching — there's no update to
//      check for, this is for when the app itself is wedged (see
//      docs/DECISIONS.md → "Remote restart, not just remote update" for
//      the report that prompted this: a stuck client-side operation with
//      no update available left the phone-side trigger unable to do
//      anything at all). Either way progress is reported back via
//      POST /system/update-report.
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
  /** "update" (default, back-compat with a client that never sends this):
   *  check for a new version, install it if found, then relaunch. "restart":
   *  skip the check entirely and just relaunch — for a desktop that's stuck
   *  in a bad state and just needs a fresh process, update or not. */
  requestedMode?: "update" | "restart";
}

let current: DesktopUpdateStatus = { state: "idle" };

export function getDesktopUpdateStatus(): DesktopUpdateStatus {
  return current;
}

/** Only the trigger is privileged — reading/reporting status leaks nothing
 * sensitive, and gating them to admin would break reporting on a shared
 * desktop currently signed in as a non-admin family member. */
export function requestDesktopUpdate(requestedBy: string, mode: "update" | "restart" = "update"): DesktopUpdateStatus {
  current = { state: "requested", requestedAt: new Date().toISOString(), requestedBy, requestedMode: mode };
  return current;
}

export function reportDesktopUpdateStatus(
  patch: Omit<DesktopUpdateStatus, "requestedAt" | "requestedBy" | "requestedMode">
): DesktopUpdateStatus {
  // Keep requestedAt/requestedBy/requestedMode around through the whole run
  // so a client that starts polling mid-flight still sees who asked for
  // this, and which kind of request it was.
  current = {
    ...patch,
    requestedAt: current.requestedAt,
    requestedBy: current.requestedBy,
    requestedMode: current.requestedMode,
  };
  return current;
}

/** Test-only: drop back to a clean slate between test cases. */
export function resetDesktopUpdateStatus(): void {
  current = { state: "idle" };
}
