import { config } from "../config.js";
import { loadNativeAddon, nativeAddonUnavailableReason } from "./nativeAddon.js";

// Process-wide load/status singleton for the embedded mistral.rs model —
// same "one, like ToolSupervisor/McpManager/RoutineScheduler" shape as the
// rest of this codebase's process-wide pieces. Loading a model means
// downloading + reading multi-GB weights into THIS process's memory, so it
// can take a long time; this tracks that as an explicit status rather than
// blocking a request, so the Settings page can show real progress instead
// of a hung spinner.

export type MistralRsStatus = "unavailable" | "idle" | "loading" | "ready" | "error";

interface State {
  status: MistralRsStatus;
  modelId?: string;
  error?: string;
  loadStartedAt?: number;
}

const state: State = { status: "idle" };
let inFlight: Promise<void> | null = null;

function currentModelKey(): string {
  return `${config.mistralrsModelId}::${config.mistralrsGgufFile}::${config.mistralrsIsqBits}`;
}

let loadedKey: string | null = null;

export function getMistralRsStatus(): { status: MistralRsStatus; modelId?: string; error?: string } {
  const addon = loadNativeAddon();
  if (!addon) {
    return { status: "unavailable", error: nativeAddonUnavailableReason() };
  }
  return { status: state.status, modelId: state.modelId, error: state.error };
}

/** Idempotent: a no-op if the configured model is already loaded/loading.
 *  Call at startup (when modelProvider === "mistralrs") and again whenever
 *  the mistralrs model settings change while that provider is selected. */
export function ensureMistralRsLoaded(): Promise<void> {
  const addon = loadNativeAddon();
  if (!addon) {
    state.status = "unavailable";
    state.error = nativeAddonUnavailableReason();
    return Promise.resolve();
  }
  const key = currentModelKey();
  if (loadedKey === key && state.status === "ready") return Promise.resolve();
  if (inFlight && loadedKey === key) return inFlight;

  loadedKey = key;
  state.status = "loading";
  state.modelId = config.mistralrsModelId;
  state.error = undefined;
  state.loadStartedAt = Date.now();

  inFlight = addon
    .loadModel({
      modelId: config.mistralrsModelId,
      ggufFile: config.mistralrsGgufFile || undefined,
      isqBits: config.mistralrsIsqBits,
    })
    .then(() => {
      state.status = "ready";
    })
    .catch((err: unknown) => {
      state.status = "error";
      state.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Forces the next ensureMistralRsLoaded() to reload even if the model
 *  config didn't change (e.g. a manual "reload" action from Settings). */
export function invalidateMistralRsModel(): void {
  loadedKey = null;
}
