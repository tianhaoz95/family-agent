import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";

// Captures every tool call the agent makes during a turn — the tool name, the
// arguments it was given, and what it returned — so the chat UI can show, live
// and after the fact, exactly what happened under the hood. See the `/chat`
// route wiring in server.ts and docs/DECISIONS.md → "Tool-call visibility".
//
// A LangChain BaseCallbackHandler passed as `{ callbacks: [recorder] }` to
// `agent.invoke`. `handleToolStart` / `handleToolEnd` fire for the planner's
// own tools AND for the tools a subagent uses (the `task` delegation call and
// the subagent's calls both surface). We keep it a flat, chronological list —
// a `task` step (labelled with its `subagent_type`) then that subagent's
// calls, in the order they ran, reads clearly without a tree.

export type StepPhase = "running" | "done" | "error";

export interface AgentStep {
  /** The tool run id (stable across start → end). */
  id: string;
  /** Tool name, e.g. "search_documents", "run_code", "task", "get_password". */
  tool: string;
  /** For a `task` delegation call: the subagent it was handed to. */
  subagent?: string;
  phase: StepPhase;
  /** The arguments the tool was called with (parsed from JSON when it arrives as a string). */
  input: unknown;
  /** The tool's result, as text, clamped. Absent while running. */
  output?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
}

const MAX_STEPS = 60;
const MAX_INPUT_CHARS = 2000;
const MAX_OUTPUT_CHARS = 4000;

function clamp(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Tool inputs arrive as a JSON string or an object depending on the tool — normalise to a value. */
function parseToolInput(input: string | Record<string, unknown>): unknown {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through */
    }
  }
  return input;
}

/** Tool outputs come back as a plain string, a serialized ToolMessage, or a
 *  deepagents `Command` — dig out the human-meaningful text. */
function extractToolOutput(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  const o = output as Record<string, any>;
  if (o.kwargs?.content != null) return stringify(o.kwargs.content);
  if (o.content != null) return stringify(o.content);
  if (Array.isArray(o.update?.messages) && o.update.messages.length) {
    const last = o.update.messages.at(-1);
    if (last?.kwargs?.content != null) return stringify(last.kwargs.content);
  }
  if (o.lg_name === "Command" || o.name === "Command") return "(control handed back to the planner)";
  return stringify(o);
}

export class StepRecorder extends BaseCallbackHandler {
  name = "family-step-recorder";
  // Don't make the graph wait on our bookkeeping.
  awaitHandlers = false;
  ignoreLLM = true;
  ignoreChain = true;
  ignoreRetriever = true;

  steps: AgentStep[] = [];
  private byRun = new Map<string, AgentStep>();

  constructor(private readonly onUpdate?: (steps: AgentStep[]) => void) {
    super();
  }

  /** Clear captured steps — `askFamilyAgent` calls this before each retry so the
   *  final list reflects the attempt that actually answered. */
  reset(): void {
    this.steps = [];
    this.byRun.clear();
    this.onUpdate?.(this.steps);
  }

  private emit(): void {
    this.onUpdate?.(this.steps);
  }

  override handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string
  ): void {
    if (this.steps.length >= MAX_STEPS) return;
    const parsed = parseToolInput(input as unknown as string | Record<string, unknown>);
    const name =
      runName ||
      (tool as unknown as { name?: string }).name ||
      (Array.isArray((tool as unknown as { id?: string[] }).id)
        ? (tool as unknown as { id: string[] }).id.at(-1)
        : undefined) ||
      "tool";
    const step: AgentStep = {
      id: runId,
      tool: name,
      phase: "running",
      input:
        typeof parsed === "string" ? clamp(parsed, MAX_INPUT_CHARS) : parsed,
      startedAt: new Date().toISOString(),
    };
    // A delegation: pull the target subagent onto the step so the UI can label it.
    if (name === "task" && parsed && typeof parsed === "object" && "subagent_type" in parsed) {
      step.subagent = String((parsed as Record<string, unknown>).subagent_type ?? "");
    }
    this.byRun.set(runId, step);
    this.steps.push(step);
    this.emit();
  }

  override handleToolEnd(output: unknown, runId: string): void {
    const step = this.byRun.get(runId);
    if (!step) return;
    step.output = clamp(extractToolOutput(output), MAX_OUTPUT_CHARS);
    step.phase = "done";
    step.endedAt = new Date().toISOString();
    step.durationMs = Date.parse(step.endedAt) - Date.parse(step.startedAt);
    this.emit();
  }

  override handleToolError(err: unknown, runId: string): void {
    const step = this.byRun.get(runId);
    if (!step) return;
    step.error = err instanceof Error ? err.message : String(err);
    step.phase = "error";
    step.endedAt = new Date().toISOString();
    step.durationMs = Date.parse(step.endedAt) - Date.parse(step.startedAt);
    this.emit();
  }
}
