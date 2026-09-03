import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOllama } from "@langchain/ollama";
import type { ScopedStore, ToolRecord } from "../db.js";
import { toolsDir } from "../config.js";
import { DEFAULT_OPERATIONS, HARNESS } from "./harness.js";
import type { ToolSupervisor } from "./supervisor.js";
import { refreshManifest } from "./toolMcp.js";

// Codegen deliberately talks straight to the model (like agents/extraction.ts)
// rather than routing through the planner → subagent delegation: a small model
// cannot reliably transcribe a whole HTML document through a delegated
// "description" string. The planner's builder-agent just hands us the request.

// A "server" tool gets a sandboxed Deno backend, a private SQLite database, and
// an MCP endpoint the chat assistant can call. A "static" tool is just an HTML
// page with the browser-storage-backed /__state blob. Pick server when the tool
// is about *keeping a collection of things* the family (or the assistant) will
// query and update over time — a tracker, inventory, log, catalog, registry,
// roster — or when they explicitly want it shared / assistant-accessible.
// Otherwise static (a calculator, a one-off checklist, a countdown).
function wantsBackend(prompt: string): boolean {
  return /\b(shared?|sync|everyone|together|collaborat|both of us|the family can|all of us|multiple (people|devices)|our whole family|track(er|ing)?|inventor(y|ies)|catalog(ue)?|registr(y|ies)|roster|ledger|log(book)?|database|records?|collection|directory|where (is|are|did|we|i)|look ?up|borrow|check(ed)? out|assistant can|ask (you|the assistant))\b/i.test(
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
- Persist the user's data with the built-in state API. Use the RELATIVE path "__state" (no leading slash):
  load with fetch('__state').then(r=>r.json()) (treat a null response as "no data yet") and save with
  fetch('__state',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).
  This is disk-backed and survives restarts. Do NOT rely on localStorage for anything that must be kept —
  the tool runs in a sandboxed frame whose localStorage is not durable. Use a distinct key per dataset
  with fetch('__state?key=NAME', ...) if you have more than one.
- Keep it focused and functional. No login, no settings pages, no external anything.`;

// For server tools: the frontend talks to the SAME backend the operations use,
// so the UI and the chat assistant see one shared dataset.
const HTML_WITH_OPS_SYSTEM = `You write one complete, self-contained HTML document for a small single-purpose web tool. Rules:
- Output ONLY the HTML, starting with <!doctype html>. No explanation, no markdown fences.
- Everything inline: one <style> block, one <script> block. NO external URLs, CDNs, frameworks, fonts, or images.
- Clean, modern, legible.
- This tool has a backend. Its operations are listed below. Call them with:
    fetch('api/<operation_name>', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(input) })
      .then(r => r.json())
  (relative path "api/...", no leading slash). Read operations also accept GET with the params as a query string.
  Every operation returns JSON. Use ONLY these operations for data — do NOT use "__state" or localStorage, so the
  page and the assistant stay in sync.
- Keep it focused and functional. No login, no settings pages, no external anything.`;

const OPERATIONS_SYSTEM = `You write operations.ts — the backend for a small family tool. Output ONLY TypeScript, no markdown fences, no explanation.

It runs sandboxed (no network, no filesystem, no subprocesses) with one private SQLite database. Export a single \`operations\` array. Each entry:

{
  name: string,          // snake_case verb_noun, e.g. "find_item", "add_item", "list_rooms"
  description: string,    // one line — what it does, from the caller's point of view
  access: "read" | "write",   // "read" only looks things up; "write" changes stored data
  inputSchema: {         // JSON Schema for the input object
    type: "object",
    properties: { query: { type: "string", description: "..." } },
    required: ["query"],
  },
  async run(input, ctx) {  // input matches inputSchema; return any JSON-serialisable value
    // ctx.db  — a real SQLite database (node:sqlite DatabaseSync), private to THIS tool
    // ctx.store — a simple key/value store: get(key?), set(key, value)
    return ctx.db.prepare("SELECT * FROM items WHERE name LIKE ?").all("%" + input.query + "%");
  },
}

Rules:
- Run your CREATE TABLE IF NOT EXISTS statements at the top of EVERY run() (cheap, safe).
- Cover the whole job: at least one "read" operation to look things up and, unless the tool is read-only, "write" operations to add / update / remove. The chat assistant can only do what the operations allow.
- Keep operation names and parameters simple and predictable — they are what the assistant calls by name.
- Use ctx.db for anything with multiple records; ctx.store only for one small blob of settings.
- No auth, no HTTP, no Response objects — just return the data.

Example for an item-location tracker:

export const operations = [
  {
    name: "find_item",
    description: "Find where an item is stored",
    access: "read",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "item name or keyword" } }, required: ["query"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, notes TEXT)");
      return ctx.db.prepare("SELECT name, location, notes FROM items WHERE name LIKE ? OR location LIKE ?").all("%"+input.query+"%", "%"+input.query+"%");
    },
  },
  {
    name: "list_items",
    description: "List every stored item and where it is",
    access: "read",
    inputSchema: { type: "object", properties: {} },
    async run(_input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, notes TEXT)");
      return ctx.db.prepare("SELECT name, location, notes FROM items ORDER BY name").all();
    },
  },
  {
    name: "save_item",
    description: "Add an item or update where it is stored",
    access: "write",
    inputSchema: { type: "object", properties: { name: { type: "string" }, location: { type: "string" }, notes: { type: "string" } }, required: ["name", "location"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, notes TEXT)");
      const existing = ctx.db.prepare("SELECT id FROM items WHERE name = ?").get(input.name);
      if (existing) ctx.db.prepare("UPDATE items SET location = ?, notes = ? WHERE name = ?").run(input.location, input.notes ?? null, input.name);
      else ctx.db.prepare("INSERT INTO items (name, location, notes) VALUES (?, ?, ?)").run(input.name, input.location, input.notes ?? null);
      return { ok: true, name: input.name, location: input.location };
    },
  },
  {
    name: "remove_item",
    description: "Delete an item from the tracker",
    access: "write",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, notes TEXT)");
      const info = ctx.db.prepare("DELETE FROM items WHERE name = ?").run(input.name);
      return { ok: true, removed: info.changes };
    },
  },
];`;

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

/** A compact summary of the generated operations, fed into the HTML prompt so
 *  the frontend calls the same backend the assistant does. */
function describeOperations(operationsCode: string): string {
  const found: string[] = [];
  // Best-effort scrape of `name:` / `description:` pairs — the frontend prompt
  // only needs the names and rough shapes, not a real parse.
  const re = /name\s*:\s*["'`]([a-z0-9_]+)["'`][\s\S]{0,400}?description\s*:\s*["'`]([^"'`]{1,120})["'`]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(operationsCode)) && found.length < 12) found.push(`- ${m[1]}: ${m[2]}`);
  return found.join("\n");
}

async function generateHtml(
  model: ChatOllama,
  prompt: string,
  kind: "static" | "server",
  operationsCode?: string
): Promise<string> {
  const useOps = kind === "server" && operationsCode && describeOperations(operationsCode).length > 0;
  const system = useOps ? HTML_WITH_OPS_SYSTEM : HTML_SYSTEM;
  const context = useOps
    ? `This tool's backend operations (call as fetch('api/<name>', {method:'POST', ...})):\n${describeOperations(
        operationsCode!
      )}`
    : kind === "server"
      ? "This tool has SHARED STATE across devices — load/save with fetch('__state')."
      : "Persist with fetch('__state') as described above — it is disk-backed and survives restarts.";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await model.invoke([
      new SystemMessage(system),
      new HumanMessage(`${context}\n\nBuild this: ${prompt}\n\nWrite the full HTML document now.`),
    ]);
    const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const html = stripFences(raw);
    if (html.length > 80 && html.includes("<") && /<\/(body|html|div|main|section)>/i.test(html)) {
      return looksLikeHtmlDoc(html) ? html : wrapFragment(nameFromHtml("", prompt), html);
    }
  }
  throw new Error("the model did not produce a usable HTML document");
}

async function generateOperations(model: ChatOllama, prompt: string): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await model.invoke([
        new SystemMessage(OPERATIONS_SYSTEM),
        new HumanMessage(`The tool: ${prompt}\n\nWrite operations.ts now.`),
      ]);
      const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      const code = stripFences(raw);
      // Must export an operations array with at least one named operation.
      if (
        /export\s+const\s+operations\s*(?::[^=]+)?=\s*\[/.test(code) &&
        /name\s*:\s*["'`][a-z0-9_]+["'`]/i.test(code) &&
        /\brun\s*(?::|\()/.test(code) &&
        code.length < 12000
      ) {
        return code;
      }
    } catch {
      /* retry */
    }
  }
  return DEFAULT_OPERATIONS; // the built-in /__state API still covers the frontend
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

  if (kind !== "server") {
    const html = await generateHtml(model, prompt, kind);
    await writeFile(join(dir, "index.html"), html, "utf8");
    store.renameTool(id, nameFromHtml(html, prompt), prompt.slice(0, 180), kind);
    return "";
  }

  if (!supervisor.denoAvailable()) {
    throw new Error("this tool needs a backend, which requires the Deno runtime (not found on this machine)");
  }

  // Backend first — it defines the data model and the API the frontend calls.
  const operations = await generateOperations(model, prompt);
  await writeFile(join(dir, "operations.ts"), operations, "utf8");
  await writeFile(join(dir, "server.ts"), HARNESS, "utf8");

  let operationsCode = operations;
  let note = "";
  try {
    await supervisor.start(id);
  } catch {
    // The generated operations wouldn't run — fall back to no operations. The
    // frontend then needs to fall back to /__state too, so regenerate it.
    operationsCode = DEFAULT_OPERATIONS;
    await writeFile(join(dir, "operations.ts"), operationsCode, "utf8");
    await supervisor.start(id);
    note = " (the generated backend code failed to run — the tool still works, but the assistant can't use it)";
  }

  const html = await generateHtml(model, prompt, kind, operationsCode);
  await writeFile(join(dir, "index.html"), html, "utf8");
  store.renameTool(id, nameFromHtml(html, prompt), prompt.slice(0, 180), kind);

  // Cache the tool's MCP operation list so tools-agent can see it right away.
  await refreshManifest(id, store.getTool(id)?.name ?? "tool", supervisor).catch(() => {});
  supervisor.stop(id);
  return note;
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
  // A server tool needs the Deno runtime for its backend; without it, fall
  // back to a static (browser-storage) tool rather than failing the build.
  const kind: "static" | "server" =
    wantsBackend(prompt) && supervisor.denoAvailable() ? "server" : "static";
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
