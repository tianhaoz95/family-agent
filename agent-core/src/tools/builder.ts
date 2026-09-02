import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOllama } from "@langchain/ollama";
import type { ScopedStore, ToolRecord } from "../db.js";
import { toolsDir } from "../config.js";
import { DEFAULT_HANDLER, HARNESS } from "./harness.js";
import type { ToolSupervisor } from "./supervisor.js";

// Codegen deliberately talks straight to the model (like agents/extraction.ts)
// rather than routing through the planner → subagent delegation: a small model
// cannot reliably transcribe a whole HTML document through a delegated
// "description" string. The planner's builder-agent just hands us the request.

// "Shared state" is a rare need — only when the family explicitly wants the
// tool's data to sync between devices. Default to a local (browser-storage)
// tool. This keyword check is intentionally conservative.
function wantsSharedState(prompt: string): boolean {
  return /\b(shared?|sync|everyone|together|collaborat|both of us|the family can|all of us|multiple (people|devices)|our whole family)\b/i.test(
    prompt
  );
}

// The model's HTML <title> is the friendliest name we get; fall back to a
// cleaned-up version of the request.
function nameFromHtml(html: string, prompt: string): string {
  const t = html.match(/<title>([^<]{2,60})<\/title>/i)?.[1]?.trim();
  if (t && !/^untitled|^document$/i.test(t)) return t;
  return (
    prompt
      .replace(/^(please\s+)?(build|make|create|generate)\s+(me\s+)?(a\s+|an\s+)?/i, "")
      .replace(/\bto help( me)?\b.*/i, "")
      .replace(/[.!?]+$/, "")
      .slice(0, 50)
      .trim() || "New tool"
  );
}

const HTML_SYSTEM = `You write one complete, self-contained HTML document for a small single-purpose web tool. Rules:
- Output ONLY the HTML, starting with <!doctype html>. No explanation, no markdown fences.
- Everything inline: one <style> block, one <script> block. NO external URLs, CDNs, frameworks, fonts, or images.
- Clean, modern, legible. Works offline.
- Persist the user's data. If this tool is LOCAL: use localStorage. If it has SHARED STATE: load with
  fetch('/__state').then(r=>r.json()) and save with fetch('/__state',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(data)}). Treat a null response as "no data yet".
- Keep it focused and functional. No login, no settings pages, no external anything.`;

const HANDLER_SYSTEM = `You write a Deno request handler for a small family tool's backend. Output ONLY TypeScript, no markdown fences. It runs sandboxed (no network, no filesystem beyond the store, no subprocesses). Shape:

export async function handler(request: Request, ctx: { store: { get(key?: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> } }): Promise<Response> {
  const url = new URL(request.url);
  // handle your API routes here; use ctx.store for persistence
  return new Response("not found", { status: 404 });
}

The frontend can also just use the built-in GET/PUT /__state — only write a handler if the tool needs real server-side logic (computing something, enforcing rules). Keep it short.`;

function stripFences(s: string): string {
  return s
    .replace(/^\s*```(?:html|ts|typescript|js|javascript)?\s*\n/i, "")
    .replace(/\n```\s*$/i, "")
    .trim();
}

function looksLikeHtmlDoc(s: string): boolean {
  return /<!doctype html/i.test(s) || (/<html[\s>]/i.test(s) && /<\/html>/i.test(s));
}

function wrapFragment(name: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name.replace(/[<>&]/g, "")}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;line-height:1.5}</style>
</head>
<body>
${body}
</body>
</html>`;
}

async function generateHtml(model: ChatOllama, prompt: string, kind: "static" | "server"): Promise<string> {
  const scope =
    kind === "server"
      ? "This tool has SHARED STATE — load/save with fetch('/__state')."
      : "This tool is LOCAL — save with localStorage.";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await model.invoke([
      new SystemMessage(HTML_SYSTEM),
      new HumanMessage(`${scope}\n\nBuild this: ${prompt}\n\nWrite the full HTML document now.`),
    ]);
    const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const html = stripFences(raw);
    if (html.length > 80 && html.includes("<") && /<\/(body|html|div|main|section)>/i.test(html)) {
      return looksLikeHtmlDoc(html) ? html : wrapFragment(nameFromHtml("", prompt), html);
    }
  }
  throw new Error("the model did not produce a usable HTML document");
}

async function generateHandler(model: ChatOllama, prompt: string): Promise<string> {
  try {
    const res = await model.invoke([
      new SystemMessage(HANDLER_SYSTEM),
      new HumanMessage(`The tool: ${prompt}\n\nWrite handler.ts now (or a minimal stub if it doesn't need server logic).`),
    ]);
    const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const code = stripFences(raw);
    if (/export\s+(async\s+)?function\s+handler\s*\(/.test(code) && code.length < 8000) return code;
  } catch {
    /* fall through */
  }
  return DEFAULT_HANDLER; // the built-in /__state API still covers most needs
}

export interface BuildResult {
  tool: ToolRecord;
  ok: boolean;
  note: string;
}

async function generateAndWrite(
  model: ChatOllama,
  store: ScopedStore,
  supervisor: ToolSupervisor,
  prompt: string,
  kind: "static" | "server",
  id: string,
  dir: string
): Promise<string> {
  await mkdir(join(dir, "data"), { recursive: true });
  const html = await generateHtml(model, prompt, kind);
  await writeFile(join(dir, "index.html"), html, "utf8");
  store.renameTool(id, nameFromHtml(html, prompt), prompt.slice(0, 180), kind);

  if (kind !== "server") return "";

  const handler = await generateHandler(model, prompt);
  await writeFile(join(dir, "handler.ts"), handler, "utf8");
  await writeFile(join(dir, "server.ts"), HARNESS, "utf8");
  if (!supervisor.denoAvailable()) {
    throw new Error("this tool needs a shared backend, which requires the Deno runtime (not found on this machine)");
  }
  try {
    await supervisor.start(id);
    return "";
  } catch {
    // Backend wouldn't start — retry once with the safe default handler so the
    // frontend + built-in /__state persistence still work.
    await writeFile(join(dir, "handler.ts"), DEFAULT_HANDLER, "utf8");
    await supervisor.start(id);
    return " (custom backend code failed to run — using built-in persistence instead)";
  }
}

/**
 * Generate, write, and (for server tools) launch a tool. Never throws — a
 * failure is recorded on the ToolRecord (status "failed") and returned. The
 * record is created immediately (status "building", name derived from the
 * prompt) so the UI can show it while the slow codegen runs.
 */
// A codegen run that never returns (model hung) would sit at "building"
// forever — bound it.
const BUILD_TIMEOUT_MS = Number(process.env.FAMILY_AGENT_TOOL_BUILD_MS ?? 8 * 60_000);

export async function buildTool(
  model: ChatOllama,
  store: ScopedStore,
  supervisor: ToolSupervisor,
  prompt: string
): Promise<BuildResult> {
  const kind: "static" | "server" = wantsSharedState(prompt) ? "server" : "static";
  const tool = store.createTool({
    name: nameFromHtml("", prompt),
    description: prompt.slice(0, 180),
    prompt,
    kind,
  });
  const dir = join(toolsDir(), tool.id);

  try {
    const note = await Promise.race([
      generateAndWrite(model, store, supervisor, prompt, kind, tool.id, dir),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`build timed out after ${BUILD_TIMEOUT_MS / 1000}s`)), BUILD_TIMEOUT_MS)
      ),
    ]);
    store.setToolStatus(tool.id, "ready");
    const done = store.getTool(tool.id)!;
    return { tool: done, ok: true, note: `Built "${done.name}".${note}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    store.setToolStatus(tool.id, "failed", msg);
    const failed = store.getTool(tool.id)!;
    return { tool: failed, ok: false, note: `Could not build "${failed.name}": ${msg}` };
  }
}
