import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolsDir } from "../config.js";
import type { ToolSupervisor } from "./supervisor.js";

// agent-core is the MCP *client* for every server-kind tool. Each tool's Deno
// backend runs a minimal MCP server at POST /mcp (see tools/harness.ts); this
// module speaks JSON-RPC 2.0 to it over the supervisor's loopback port.
//
// The server is stateless, so there is no session to hold — every call is a
// fresh `initialize` (cheap, loopback) followed by the real request. The
// operation list is also cached to `<toolDir>/mcp.json` at build time so the
// planner can enumerate a family's tools without booting every backend.

const CACHE_FILE = "mcp.json";
/** Cap a tool result before it goes back into the planner's context. */
const MAX_RESULT_CHARS = 8_000;
const MAX_RESULT_ITEMS = 100;

export interface ToolOperation {
  name: string;
  title?: string;
  description: string;
  access: "read" | "write";
  inputSchema: JsonSchema;
}

export interface ToolManifest {
  toolId: string;
  name: string;
  operations: ToolOperation[];
}

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
};

function cachePath(toolId: string): string {
  return join(toolsDir(), toolId, CACHE_FILE);
}

/** The last cached operation list for a tool, or null if it has none. */
export function readManifestCache(toolId: string): ToolManifest | null {
  const p = cachePath(toolId);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as ToolManifest;
    if (!Array.isArray(parsed.operations)) return null;
    return { ...parsed, toolId };
  } catch {
    return null;
  }
}

let rpcSeq = 0;

async function rpc(port: number, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcSeq, method, params }),
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`tool MCP transport error: ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (body.error) throw new Error(`tool MCP error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

async function initialize(port: number): Promise<void> {
  await rpc(port, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "family-agent", version: "1" },
  });
}

interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: { readOnlyHint?: boolean };
}

function toOperation(t: McpToolDef): ToolOperation {
  return {
    name: t.name,
    title: t.title,
    description: t.description || t.name,
    access: t.annotations?.readOnlyHint ? "read" : "write",
    inputSchema: t.inputSchema || { type: "object", properties: {} },
  };
}

/**
 * Boot the tool's backend (if not already up), pull its `tools/list`, and
 * write the result to the on-disk cache. Returns null when the tool exposes no
 * operations or the backend can't be reached — callers treat that as "this
 * tool has no agent API".
 */
export async function refreshManifest(
  toolId: string,
  toolName: string,
  supervisor: ToolSupervisor,
): Promise<ToolManifest | null> {
  let port: number;
  try {
    port = await supervisor.portFor(toolId);
  } catch {
    return null;
  }
  try {
    await initialize(port);
    const listed = (await rpc(port, "tools/list", {})) as { tools?: McpToolDef[] };
    const operations = (listed.tools ?? []).map(toOperation);
    const manifest: ToolManifest = { toolId, name: toolName, operations };
    try {
      writeFileSync(cachePath(toolId), JSON.stringify({ name: toolName, operations }, null, 2));
    } catch {
      /* cache is best-effort */
    }
    return operations.length ? manifest : null;
  } catch {
    return null;
  }
}

export interface CallResult {
  ok: boolean;
  /** Parsed operation result on success. */
  value?: unknown;
  /** Human-readable message on failure. */
  error?: string;
}

/** Clamp an operation result so a chatty tool can't blow the planner context. */
export function clampResult(value: unknown): { value: unknown; truncated: boolean } {
  let truncated = false;
  let v = value;
  if (Array.isArray(v) && v.length > MAX_RESULT_ITEMS) {
    v = v.slice(0, MAX_RESULT_ITEMS);
    truncated = true;
  }
  let text = JSON.stringify(v);
  if (text && text.length > MAX_RESULT_CHARS) {
    text = text.slice(0, MAX_RESULT_CHARS);
    truncated = true;
    // Hand back the truncated JSON as a string — the planner only needs to
    // read it, not parse it.
    return { value: text + "…(truncated)", truncated };
  }
  return { value: v, truncated };
}

/** Call one operation on a tool via MCP `tools/call`. Never throws. */
export async function callOperation(
  toolId: string,
  operation: string,
  args: Record<string, unknown>,
  supervisor: ToolSupervisor,
): Promise<CallResult> {
  let port: number;
  try {
    port = await supervisor.portFor(toolId);
  } catch (e) {
    return { ok: false, error: `the tool's backend could not start: ${e instanceof Error ? e.message : e}` };
  }
  try {
    await initialize(port);
    const res = (await rpc(port, "tools/call", { name: operation, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = res.content?.find((c) => c.type === "text")?.text ?? "";
    if (res.isError) return { ok: false, error: text || "the operation reported an error" };
    let value: unknown = res.structuredContent;
    if (value === undefined) {
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    return { ok: true, value: clampResult(value).value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
