import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Loads the mistralrs-node native addon — mistral.rs embedded as a Rust
// library and called in-process (see native/mistralrs-node/src/lib.rs),
// deliberately NOT a spawned mistralrs-server/CLI process. Same "heavy,
// possibly-missing native piece, load lazily and degrade gracefully" shape
// as onnxruntime-node elsewhere in this codebase — a platform this hasn't
// been built for (see scripts/build-mistralrs-node.sh) just means the
// "mistralrs" model provider reports itself unavailable, nothing crashes.

export interface ToolCallInput {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ChatMessageInput {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  toolCallId?: string;
  toolCalls?: ToolCallInput[];
}

export interface ToolSpecInput {
  name: string;
  description?: string;
  parametersJson: string;
}

export interface ChatCompletionRequestInput {
  messages: ChatMessageInput[];
  tools?: ToolSpecInput[];
  toolChoice?: "auto" | "none";
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionResultOutput {
  content?: string;
  toolCalls: ToolCallInput[];
  promptTokensPerSec?: number;
  completionTokensPerSec?: number;
}

interface MistralRsNativeModule {
  loadModel(opts: { modelId: string; ggufFile?: string; isqBits?: number }): Promise<void>;
  isLoaded(): Promise<boolean>;
  unloadModel(): Promise<void>;
  chatCompletion(req: ChatCompletionRequestInput): Promise<ChatCompletionResultOutput>;
}

let cached: MistralRsNativeModule | null | undefined;
let cachedError: string | undefined;

function addonPath(): string {
  const dir = join(import.meta.dirname, "..", "..", "native", "mistralrs-node", "prebuilds", `${process.platform}-${process.arch}`);
  return join(dir, "mistralrs-node.node");
}

/** Lazily loads the native addon. Never throws — returns null (and records
 *  why) when it isn't available for this platform/build. */
export function loadNativeAddon(): MistralRsNativeModule | null {
  if (cached !== undefined) return cached;
  const path = addonPath();
  if (!existsSync(path)) {
    cachedError = `mistralrs-node addon not built for ${process.platform}-${process.arch} (expected ${path}). Run agent-core/scripts/build-mistralrs-node.sh.`;
    cached = null;
    return cached;
  }
  try {
    const require = createRequire(import.meta.url);
    cached = require(path) as MistralRsNativeModule;
    return cached;
  } catch (err) {
    cachedError = `failed to load mistralrs-node addon: ${err instanceof Error ? err.message : String(err)}`;
    cached = null;
    return cached;
  }
}

export function nativeAddonUnavailableReason(): string | undefined {
  return cachedError;
}
