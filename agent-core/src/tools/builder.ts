import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOllama } from "@langchain/ollama";
import type { ScopedStore, ToolKind, ToolRecord } from "../db.js";
import { toolsDir } from "../config.js";
import { DEFAULT_OPERATIONS, HARNESS } from "./harness.js";
import type { ToolSupervisor } from "./supervisor.js";
import { refreshManifest, readManifestCache } from "./toolMcp.js";
import * as dbInspect from "./dbInspect.js";

// Codegen deliberately talks straight to the model (like agents/extraction.ts)
// rather than routing through the planner → subagent delegation: a small model
// cannot reliably transcribe a whole HTML document through a delegated
// "description" string. The planner's builder-agent just hands us the request.
//
// A tool is generated once, then *improved* in place by iterateTool: the model
// gets its own prior output + the change asked for, regenerates, and the new
// backend is smoke-tested on a scratch port before it replaces the running one
// (a bad improve never takes a working tool offline). The previous version is
// snapshotted to `<toolDir>/prev/` so revertTool can undo one step.

// A "server" tool gets a sandboxed Deno backend, a private SQLite database, and
// an MCP endpoint the chat assistant can call. A "static" tool is just an HTML
// page with the browser-storage-backed /__state blob. Pick server when the tool
// is about *keeping a collection of things* the family (or the assistant) will
// query and update over time — a tracker, inventory, log, catalog, registry,
// roster, or any "…book / …list" of the user's own entries — or when they
// explicitly want it shared / assistant-accessible. Otherwise static (a
// calculator, a one-off checklist, a countdown).
function wantsBackend(prompt: string): boolean {
  return (
    /\b(shared?|sync|everyone|together|collaborat|both of us|the family can|all of us|multiple (people|devices)|our whole family|track(er|ing)?|inventor(y|ies)|catalog(ue)?|registr(y|ies)|roster|ledger|log(book)?|database|records?|collection|directory|where (is|are|did|we|i)|look ?up|borrow|check(ed)? out|assistant can|ask (you|the assistant))\b/i.test(
      prompt
    ) ||
    // "cookbook", "address book", "shopping list", "wishlist", "guest list", …
    /\b(cook ?book|address book|recipe box|\w+ ?list\b|wish ?list)\b/i.test(prompt) ||
    // an explicit ask to keep the user's own entries around
    /\b(save|store|keep track|keep a list|my own|our own|add (my|our|a|another|new)\b.*\b(recipe|item|entry|book|contact|note)|remember (my|our|the)|persist)\b/i.test(
      prompt
    )
  );
}

// On an *improve*, be more liberal: an ask to save / manage the user's own
// entries should turn a display-only tool into one with real storage. If the
// model then generates no operations (the change didn't actually need a
// backend), iterateTool downgrades it back to static — so this can err toward
// "try server".
function improveWantsBackend(instruction: string): boolean {
  return (
    wantsBackend(instruction) ||
    /\b(sav(e|ing)|stor(e|ing)|persist|editable|my own|our own|keep (a |an |my |our |track |a list))\b/i.test(instruction) ||
    /\b(let me|so (i|we) can|able to|want to|i want to) (add|enter|save|store|edit|manage|keep|record|log)\b/i.test(instruction) ||
    /\badd (my|our|new|custom|more|another|the user)\b/i.test(instruction)
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

// The tool renders in an <iframe> inside the desktop app, so it must look like it
// belongs there — the "Notion warm paper notebook" system from the repo's
// DESIGN.md (warm #f6f5f4 canvas, white cards with hairline borders + soft
// floating shadows, a single #0075de blue accent, system sans, 11-16px rounded
// corners, 200ms ease motion). Small models don't reproduce this from a
// description, so hand them a ready-to-paste base and tell them to build on it.
// No webfonts allowed (offline, no external URLs) — Inter degrades to system-ui.
const HOUSE_STYLE = `Match the host app's visual style — it is the "warm paper notebook" look. Start your <style> block with this base VERBATIM, then add only tool-specific rules on top of it:

:root{
  --bg:#f6f5f4; --surface:#fff; --border:rgba(0,0,0,.08); --border-strong:rgba(0,0,0,.16);
  --text:#000; --text-muted:rgba(0,0,0,.6); --text-body:#615d59;
  --accent:#0075de; --accent-hover:#0068c4; --accent-soft:#e6f3fe; --danger:#e32d14;
  --r-sm:6px; --r-md:11px; --r-lg:16px; --r-pill:9999px;
  --shadow-sm:0 1px 2px rgba(38,32,26,.04),0 10px 30px -14px rgba(38,32,26,.16);
  --font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;padding:28px 32px;background:var(--bg);color:var(--text-body);
  font:15px/1.5 var(--font-sans);-webkit-font-smoothing:antialiased}
h1,h2,h3{color:var(--text);letter-spacing:-.014em;margin:0 0 .5em}
h1{font-size:1.35rem;font-weight:600}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);
  box-shadow:var(--shadow-sm);padding:18px}
button{font:inherit;font-weight:500;cursor:pointer;border-radius:var(--r-md);
  padding:8px 14px;border:1px solid transparent;background:var(--accent);color:#fff;
  transition:background .2s ease}
button:hover{background:var(--accent-hover)}
button.secondary{background:var(--accent-soft);color:var(--accent);border-color:transparent}
button.ghost{background:transparent;color:var(--text-muted);border-color:var(--border)}
input,select,textarea{font:inherit;color:var(--text);background:var(--surface);
  border:1px solid var(--border-strong);border-radius:var(--r-md);padding:8px 11px;width:100%}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-ring,rgba(0,117,222,.25))}
label{display:block;font-size:.82rem;color:var(--text-muted);margin-bottom:4px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border)}
th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)}

Design rules: warm canvas, white cards floated with the hairline border + soft shadow, ONE blue accent used only for the primary action (secondary actions use .secondary/.ghost), plenty of whitespace, rounded corners, 200ms ease transitions. No dark mode, no heavy borders, no gradients, no drop shadows on text. Keep it calm and uncluttered.`;

const HTML_SYSTEM = `You write one complete, self-contained HTML document for a small single-purpose web tool. Rules:
- Output ONLY the HTML, starting with <!doctype html>. No explanation, no markdown fences.
- Everything inline: one <style> block, one <script> block. NO external URLs, CDNs, frameworks, fonts, or images.
- Clean, modern, legible. Works offline.
- ${HOUSE_STYLE}
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
- ${HOUSE_STYLE}
- This tool has a backend. Its operations are listed below. Call them with:
    fetch('api/<operation_name>', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(input) })
      .then(r => r.json())
  (relative path "api/...", no leading slash). Read operations also accept GET with the params as a query string.
  Every operation returns JSON. Use ONLY these operations for data — do NOT use "__state" or localStorage, so the
  page and the assistant stay in sync.
- Keep it focused and functional. No login, no settings pages, no external anything.`;

// A quick planning pass BEFORE codegen: decide whether the tool keeps data
// people add to / look up over time, and sketch the operations the chat
// assistant (and the tool's own page) should have. This is what makes "a
// recipe picker" expose add_recipe / find_recipe / list_recipes rather than
// being a dead-end display page.
const PLAN_SYSTEM = `You decide what a small family "tool" the user asked for should be able to DO. Output ONLY a JSON object — no prose, no markdown fences:

{
  "needsBackend": true or false,
  "operations": [ { "name": "add_recipe", "summary": "Add a recipe with ingredients and steps", "access": "write" }, ... ]
}

"needsBackend" is TRUE when the tool keeps a COLLECTION of things people add to and look up over time — a list, log, tracker, inventory, catalogue, box, book, roster, or a set of recipes / contacts / books / chores / expenses / gifts / passwords / plants / anything. It is FALSE only for a pure calculator, unit converter, timer, countdown, dice roller, or a one-off display with nothing to store.

When needsBackend is true, "operations" is the small API. Think end to end:
- how does data get IN (an "add" / "record" / "save" write op — ALWAYS include one)
- how is one thing FOUND ("find" / "get" by name or keyword — a read op)
- how is EVERYTHING listed ("list_all" — a read op)
- how is a thing CHANGED or REMOVED ("update" / "remove" write ops), if that makes sense
- any tool-specific action (e.g. "random_recipe", "mark_returned", "total_owed")

Rules:
- 3 to 6 operations. snake_case verb_noun names. No settings/admin operations.
- Even a tool phrased as "random X picker" or "X of the day" needs add + list — the family will want their own entries.
- When needsBackend is false, "operations" is [].

Examples:
- "a recipe box" → {"needsBackend":true,"operations":[{"name":"add_recipe","summary":"Add a recipe","access":"write"},{"name":"find_recipe","summary":"Find recipes by name or ingredient","access":"read"},{"name":"list_recipes","summary":"List every recipe","access":"read"},{"name":"remove_recipe","summary":"Delete a recipe","access":"write"}]}
- "a random dinner picker" → {"needsBackend":true,"operations":[{"name":"add_recipe","summary":"Add a dinner idea","access":"write"},{"name":"list_recipes","summary":"List all dinner ideas","access":"read"},{"name":"random_recipe","summary":"Pick a random dinner","access":"read"},{"name":"remove_recipe","summary":"Delete a dinner idea","access":"write"}]}
- "a tip calculator" → {"needsBackend":false,"operations":[]}
- "a shared expense splitter" → {"needsBackend":true,"operations":[{"name":"add_expense","summary":"Record who paid for what","access":"write"},{"name":"list_expenses","summary":"List all expenses","access":"read"},{"name":"balances","summary":"Show who owes whom","access":"read"},{"name":"settle_up","summary":"Mark a debt as paid","access":"write"}]}
- "a countdown to our trip" → {"needsBackend":false,"operations":[]}`;

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
- If a list of operations is given below, implement EXACTLY those (fill in each inputSchema and run body) — the names and read/write split are already decided.
- Otherwise cover the whole job end to end: a "write" op to add data, a "read" op to find one thing, a "read" op to list everything, and "write" ops to update / remove where it makes sense. The chat assistant can only do what the operations allow — a tool with no "add" op is a dead end.
- Keep operation names and parameters simple and predictable — they are what the assistant calls by name.
- Use ctx.db for anything with multiple records; ctx.store only for one small blob of settings.
- No auth, no HTTP, no Response objects — just return the data.

Example for a recipe box (add / find / list / random / remove):

export const operations = [
  {
    name: "add_recipe",
    description: "Add a recipe with its ingredients and steps",
    access: "write",
    inputSchema: { type: "object", properties: { name: { type: "string" }, ingredients: { type: "string" }, steps: { type: "string" }, tags: { type: "string", description: "comma-separated, e.g. 'vegetarian, quick'" } }, required: ["name"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ingredients TEXT, steps TEXT, tags TEXT)");
      ctx.db.prepare("INSERT INTO recipes (name, ingredients, steps, tags) VALUES (?, ?, ?, ?)").run(input.name, input.ingredients ?? null, input.steps ?? null, input.tags ?? null);
      return { ok: true, name: input.name };
    },
  },
  {
    name: "find_recipe",
    description: "Find recipes by name, ingredient, or tag",
    access: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ingredients TEXT, steps TEXT, tags TEXT)");
      const q = "%" + input.query + "%";
      return ctx.db.prepare("SELECT name, ingredients, steps, tags FROM recipes WHERE name LIKE ? OR ingredients LIKE ? OR tags LIKE ?").all(q, q, q);
    },
  },
  {
    name: "list_recipes",
    description: "List every saved recipe",
    access: "read",
    inputSchema: { type: "object", properties: {} },
    async run(_input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ingredients TEXT, steps TEXT, tags TEXT)");
      return ctx.db.prepare("SELECT name, tags FROM recipes ORDER BY name").all();
    },
  },
  {
    name: "random_recipe",
    description: "Pick a random recipe",
    access: "read",
    inputSchema: { type: "object", properties: {} },
    async run(_input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ingredients TEXT, steps TEXT, tags TEXT)");
      return ctx.db.prepare("SELECT name, ingredients, steps FROM recipes ORDER BY RANDOM() LIMIT 1").get() ?? { note: "no recipes yet" };
    },
  },
  {
    name: "remove_recipe",
    description: "Delete a recipe by name",
    access: "write",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, ingredients TEXT, steps TEXT, tags TEXT)");
      const info = ctx.db.prepare("DELETE FROM recipes WHERE name = ?").run(input.name);
      return { ok: true, removed: info.changes };
    },
  },
];

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

const ITERATE_RULES = `You are CHANGING an existing tool, not rebuilding it. Rules for the change:
- Make the SMALLEST edit that satisfies the request. Keep every operation, field, and behaviour the request doesn't touch.
- Output the COMPLETE new file (not a diff) — same format as before.
- The tool ALREADY HAS DATA in its SQLite database. Schema changes must be ADDITIVE and self-healing:
  - For a NEW column, put "try { ctx.db.exec('ALTER TABLE <t> ADD COLUMN <c> <type>'); } catch (_e) {}" at the VERY TOP of EVERY run() that touches that table — read operations included — right after CREATE TABLE IF NOT EXISTS and BEFORE any SELECT/INSERT/UPDATE. (An operation that SELECTs a column it never ADDs will crash on the existing database.)
  - For a NEW table, "CREATE TABLE IF NOT EXISTS ..." at the top of each run() that uses it.
  - NEVER drop or rename an existing table or column. NEVER delete rows you weren't explicitly asked to. Existing rows keep their old values (a new column is NULL for them) — that is fine.`;

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
<style>body{font-family:"Inter",ui-sans-serif,system-ui,-apple-system,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;line-height:1.5;background:#f6f5f4;color:#615d59}h1,h2,h3{color:#000;letter-spacing:-.014em}a{color:#0075de}</style>
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
  const re = /name\s*:\s*["'`]([a-z0-9_]+)["'`][\s\S]{0,400}?description\s*:\s*["'`]([^"'`]{1,120})["'`]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(operationsCode)) && found.length < 12) found.push(`- ${m[1]}: ${m[2]}`);
  return found.join("\n");
}

function looksLikeOperations(code: string): boolean {
  return (
    /export\s+const\s+operations\s*(?::[^=]+)?=\s*\[/.test(code) &&
    /name\s*:\s*["'`][a-z0-9_]+["'`]/i.test(code) &&
    /\brun\s*(?::|\()/.test(code) &&
    code.length < 14000
  );
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

export interface PlannedOperation {
  name: string;
  summary: string;
  access: "read" | "write";
}
export interface ToolPlan {
  needsBackend: boolean;
  operations: PlannedOperation[];
}

interface GenContext {
  originalPrompt: string;
  /** Set for an improve: what to change, plus the current code as context. */
  instruction?: string;
  priorOperations?: string;
  priorHtml?: string;
  /** Set for an improve of a server tool: the live SQLite schema. */
  currentSchema?: string;
  /** The pre-codegen plan of which operations to expose (fresh build / upgrade). */
  plannedOperations?: PlannedOperation[];
}

/** Decide backend-or-not and sketch the operations, before any codegen. Best
 *  effort — a null return means "fall back to the keyword heuristic". */
export async function planTool(model: ChatOllama, prompt: string): Promise<ToolPlan | null> {
  try {
    const res = await model.invoke([
      new SystemMessage(PLAN_SYSTEM),
      new HumanMessage(`The tool the user asked for: ${prompt}\n\nDecide now — output only the JSON object.`),
    ]);
    const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const m = stripFences(raw).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { needsBackend?: unknown; operations?: unknown };
    if (typeof parsed.needsBackend !== "boolean") return null;
    const operations: PlannedOperation[] = Array.isArray(parsed.operations)
      ? (parsed.operations as Record<string, unknown>[])
          .filter((o) => o && typeof o.name === "string")
          .slice(0, 8)
          .map((o) => ({
            name: String(o.name).replace(/[^a-z0-9_]/gi, "_").toLowerCase().slice(0, 40),
            summary: String(o.summary ?? o.description ?? o.name).slice(0, 140),
            access: o.access === "write" ? "write" : "read",
          }))
      : [];
    return { needsBackend: parsed.needsBackend, operations };
  } catch {
    return null;
  }
}

function renderPlannedOps(ops: PlannedOperation[]): string {
  return ops.map((o) => `- ${o.name} [${o.access}] — ${o.summary}`).join("\n");
}

async function generateOperations(model: ChatOllama, ctx: GenContext): Promise<string> {
  const spec = ctx.plannedOperations?.length
    ? `\nImplement EXACTLY these operations — the names and read/write split are decided; fill in each inputSchema and run:\n${renderPlannedOps(
        ctx.plannedOperations
      )}\n`
    : "";
  const human = ctx.instruction
    ? [
        ITERATE_RULES,
        "",
        `The tool: ${ctx.originalPrompt}`,
        "",
        ctx.currentSchema ? `Its current database schema:\n${ctx.currentSchema}\n` : "",
        `Its current operations.ts:\n\n${ctx.priorOperations ?? "(none)"}\n`,
        spec,
        `The change to make: ${ctx.instruction}`,
        "",
        "Write the full updated operations.ts now.",
      ].join("\n")
    : `The tool: ${ctx.originalPrompt}\n${spec}\nWrite operations.ts now.`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await model.invoke([new SystemMessage(OPERATIONS_SYSTEM), new HumanMessage(human)]);
      const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      const code = stripFences(raw);
      if (looksLikeOperations(code)) return code;
    } catch {
      /* retry */
    }
  }
  // On an improve we must not silently drop the tool's operations — keep what
  // works and let the caller report the failure.
  if (ctx.instruction && ctx.priorOperations) throw new Error("the model didn't produce a usable operations.ts");
  return DEFAULT_OPERATIONS;
}

async function repairOperations(model: ChatOllama, ctx: GenContext, broken: string, error: string): Promise<string> {
  const human = [
    `This operations.ts failed to run. Fix it and output the COMPLETE corrected file.`,
    "",
    `The tool: ${ctx.originalPrompt}`,
    ctx.currentSchema ? `\nCurrent database schema:\n${ctx.currentSchema}\n` : "",
    `\nThe error:\n${error}\n`,
    `\nThe file:\n\n${broken}`,
  ].join("\n");
  try {
    const res = await model.invoke([new SystemMessage(OPERATIONS_SYSTEM), new HumanMessage(human)]);
    const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const code = stripFences(raw);
    if (looksLikeOperations(code)) return code;
  } catch {
    /* fall through */
  }
  return broken;
}

async function generateHtml(
  model: ChatOllama,
  kind: ToolKind,
  ctx: GenContext,
  operationsCode?: string
): Promise<string> {
  const useOps = kind === "server" && operationsCode && describeOperations(operationsCode).length > 0;
  const system = useOps ? HTML_WITH_OPS_SYSTEM : HTML_SYSTEM;

  let body: string;
  if (ctx.instruction) {
    body = [
      "You are CHANGING an existing tool's page. Make the smallest edit that satisfies the request; keep everything else. Output the COMPLETE new HTML document.",
      "",
      useOps
        ? `Backend operations (call as fetch('api/<name>', {method:'POST', ...})):\n${describeOperations(operationsCode!)}`
        : "",
      `\nThe tool: ${ctx.originalPrompt}`,
      `\nIts current page:\n\n${ctx.priorHtml ?? "(none)"}\n`,
      `\nThe change to make: ${ctx.instruction}`,
      "\nWrite the full updated HTML document now.",
    ].join("\n");
  } else {
    const context = useOps
      ? `This tool's backend operations (call as fetch('api/<name>', {method:'POST', ...})):\n${describeOperations(operationsCode!)}`
      : kind === "server"
        ? "This tool has SHARED STATE across devices — load/save with fetch('__state')."
        : "Persist with fetch('__state') as described above — it is disk-backed and survives restarts.";
    body = `${context}\n\nBuild this: ${ctx.originalPrompt}\n\nWrite the full HTML document now.`;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await model.invoke([new SystemMessage(system), new HumanMessage(body)]);
    const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    const html = stripFences(raw);
    if (html.length > 80 && html.includes("<") && /<\/(body|html|div|main|section)>/i.test(html)) {
      return looksLikeHtmlDoc(html) ? html : wrapFragment(nameFromHtml("", ctx.originalPrompt), html);
    }
  }
  throw new Error("the model did not produce a usable HTML document");
}

// ---------------------------------------------------------------------------
// staging: validate a server backend before it goes live
// ---------------------------------------------------------------------------

const STAGE = ".next";
const PREV = "prev";

/** Detail the model can act on, from a deno-check or boot failure. */
function looksLikeCodeBug(msg: string): boolean {
  return /is not a function|no such (table|column)|SyntaxError|is not defined|Cannot read|unexpected|TS\d{3,}/i.test(msg);
}

/**
 * Write the operations to a staging dir, type-check + boot-test them, and one
 * repair pass if they fail. Returns the code that passed (or the best effort +
 * a note). Throws only when told to (an improve that must keep the old version).
 */
// tool.db plus its WAL sidecars — copied together so a snapshot recovers cleanly.
const DB_FILES = ["tool.db", "tool.db-wal", "tool.db-shm"] as const;

/** Copy a tool's SQLite files from one `data/` dir to another. Returns false if
 *  there's nothing to copy (a tool that has never stored anything). */
async function copyDbFiles(fromDataDir: string, toDataDir: string): Promise<boolean> {
  if (!existsSync(join(fromDataDir, "tool.db"))) return false;
  await mkdir(toDataDir, { recursive: true });
  for (const f of DB_FILES) {
    const src = join(fromDataDir, f);
    if (existsSync(src)) await cp(src, join(toDataDir, f));
  }
  return true;
}

/** table -> its column names, for the tables the tool itself created (not _kv). */
function readSchema(dbPath: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!existsSync(dbPath)) return out;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_kv'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as { name: string }[];
      out.set(name, new Set(cols.map((c) => c.name)));
    }
  } catch {
    /* unreadable — treat as empty */
  } finally {
    db?.close();
  }
  return out;
}

/** True if `after` no longer has a table or column that `before` had — i.e. the
 *  improve was destructive, not purely additive. */
function schemaLostSomething(before: Map<string, Set<string>>, after: Map<string, Set<string>>): boolean {
  for (const [table, cols] of before) {
    const now = after.get(table);
    if (!now) return true;
    for (const c of cols) if (!now.has(c)) return true;
  }
  return false;
}

async function validateOperations(
  model: ChatOllama,
  supervisor: ToolSupervisor,
  stageDir: string,
  ctx: GenContext,
  firstCut: string,
  mustSucceed: boolean,
  /** For an improve: the live tool dir, so the smoke test runs read operations
   *  against a COPY of the real data + its real (old) schema. That's what
   *  catches a migration bug — e.g. an op that SELECTs a new column but forgot
   *  to ALTER it in — before the new backend replaces the working one. */
  seedFromDir?: string
): Promise<{ operations: string; note: string; expectedOps: string[] }> {
  await mkdir(stageDir, { recursive: true });
  await writeFile(join(stageDir, "server.ts"), HARNESS, "utf8");

  let code = firstCut;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    await writeFile(join(stageDir, "operations.ts"), code, "utf8");

    // Fresh copy of the real data each attempt: the smoke test's read ops run
    // ALTER TABLE against it, so a re-check must start from the old schema again.
    await rm(join(stageDir, "data"), { recursive: true, force: true });
    await mkdir(join(stageDir, "data"), { recursive: true });
    if (seedFromDir) {
      await copyDbFiles(join(seedFromDir, "data"), join(stageDir, "data")).catch(() => {});
    }

    const check = await supervisor.denoCheck(stageDir);
    const smoke = await supervisor.smokeTest(stageDir);

    if (smoke.ok && check.ok) {
      return { operations: code, note: "", expectedOps: smoke.operations ?? [] };
    }
    lastError = [!check.ok ? `type check:\n${check.output}` : "", !smoke.ok ? `boot: ${smoke.error}` : ""]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 1600);

    // A clean boot but a type-check nit that `deno run` tolerates — accept it.
    if (smoke.ok && !looksLikeCodeBug(check.output)) {
      return { operations: code, note: "", expectedOps: smoke.operations ?? [] };
    }
    if (attempt < 2) code = await repairOperations(model, ctx, code, lastError);
  }

  if (mustSucceed) throw new Error(`the change wouldn't run — ${lastError.split("\n")[0]}`);

  // Fresh build: keep the frontend working with no backend rather than fail.
  return {
    operations: DEFAULT_OPERATIONS,
    note: " (the generated backend didn't run — the tool works, but the assistant can't use it yet)",
    expectedOps: [],
  };
}

// ---------------------------------------------------------------------------
// versioning
// ---------------------------------------------------------------------------

const SNAPSHOT_FILES = ["operations.ts", "index.html", "server.ts", "mcp.json"] as const;

async function snapshotPrev(dir: string, tool: ToolRecord): Promise<void> {
  const prev = join(dir, PREV);
  await rm(prev, { recursive: true, force: true });
  await mkdir(prev, { recursive: true });
  for (const f of SNAPSHOT_FILES) {
    if (existsSync(join(dir, f))) await cp(join(dir, f), join(prev, f));
  }
  // Snapshot the database too — revert restores it only if the improve turns
  // out to have dropped something (see revertTool).
  await copyDbFiles(join(dir, "data"), join(prev, "data")).catch(() => {});
  await writeFile(
    join(prev, "meta.json"),
    JSON.stringify({ name: tool.name, description: tool.description, kind: tool.kind, at: new Date().toISOString() }),
    "utf8"
  );
}

export function toolHasPreviousVersion(toolId: string): boolean {
  const prev = join(toolsDir(), toolId, PREV);
  return existsSync(join(prev, "meta.json"));
}

export interface RevertResult {
  ok: boolean;
  note: string;
  name?: string;
  description?: string;
}

/** Restore the one snapshot in `prev/`, discard it, and restart the backend. */
export async function revertTool(
  store: ScopedStore,
  supervisor: ToolSupervisor,
  toolId: string
): Promise<RevertResult> {
  const dir = join(toolsDir(), toolId);
  const prev = join(dir, PREV);
  if (!existsSync(join(prev, "meta.json"))) return { ok: false, note: "There's no previous version to go back to." };
  const tool = store.getTool(toolId);
  if (!tool) return { ok: false, note: "tool not found" };

  let meta: { name?: string; description?: string; kind?: ToolKind } = {};
  try {
    meta = JSON.parse(await readFile(join(prev, "meta.json"), "utf8"));
  } catch {
    /* meta is best-effort */
  }

  // Release the running backend before we touch its files.
  supervisor.stop(toolId);

  // Restore the data snapshot ONLY if the improve dropped a table/column — for
  // the normal additive change, the current data works fine with the old code
  // and anything added since the improve is kept.
  let dataNote = "";
  const prevDb = join(prev, "data", "tool.db");
  if (existsSync(prevDb)) {
    const before = readSchema(prevDb);
    const after = readSchema(join(dir, "data", "tool.db"));
    if (before.size > 0 && schemaLostSomething(before, after)) {
      for (const f of DB_FILES) await rm(join(dir, "data", f), { force: true });
      await copyDbFiles(join(prev, "data"), join(dir, "data")).catch(() => {});
      dataNote = " Its data was restored too, since the last change had removed some.";
    }
  }

  for (const f of SNAPSHOT_FILES) {
    const src = join(prev, f);
    if (existsSync(src)) await cp(src, join(dir, f));
    else await rm(join(dir, f), { force: true }); // the snapshot didn't have it
  }
  await rm(prev, { recursive: true, force: true });

  const name = meta.name ?? tool.name;
  const description = meta.description ?? tool.description;
  const revertedKind = meta.kind ?? tool.kind;
  store.renameTool(toolId, name, description, revertedKind);
  store.clearToolRevisionState(toolId);

  if (revertedKind === "server" && existsSync(join(dir, "operations.ts"))) {
    await refreshManifest(toolId, name, supervisor).catch(() => {});
    supervisor.stop(toolId);
  } else {
    // Reverted back to a static (or backend-less) tool — no manifest, no db.
    supervisor.stop(toolId);
    await rm(join(dir, "mcp.json"), { force: true });
    if (tool.kind === "server" && revertedKind === "static") {
      for (const f of DB_FILES) await rm(join(dir, "data", f), { force: true });
    }
  }
  store.logActivity("user", "tool.reverted", `Reverted "${name}" to its previous version${dataNote}`);
  return { ok: true, note: `Reverted "${name}" to its previous version.${dataNote}`, name, description };
}

// ---------------------------------------------------------------------------
// build & iterate
// ---------------------------------------------------------------------------

async function currentSchemaOf(toolId: string): Promise<string> {
  try {
    const ov = dbInspect.overview(toolId);
    if (!ov.exists) return "";
    return ov.tables
      .filter((t) => t.name !== "_kv")
      .map((t) => `${t.sql ?? `-- ${t.name}`};  -- ${t.rowCount ?? "?"} row(s)`)
      .join("\n");
  } catch {
    return "";
  }
}

/** Write a fully-generated server tool's files into place and (re)start it. */
async function commitServerTool(
  dir: string,
  operations: string,
  html: string,
  snapshot: { store: ScopedStore; tool: ToolRecord } | null
): Promise<void> {
  if (snapshot) await snapshotPrev(dir, snapshot.tool);
  await writeFile(join(dir, "operations.ts"), operations, "utf8");
  await writeFile(join(dir, "server.ts"), HARNESS, "utf8");
  await writeFile(join(dir, "index.html"), html, "utf8");
  await rm(join(dir, STAGE), { recursive: true, force: true });
}

async function buildStaticTool(
  model: ChatOllama,
  store: ScopedStore,
  toolId: string,
  dir: string,
  ctx: GenContext,
  snapshot: ToolRecord | null
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const html = await generateHtml(model, "static", ctx);
  if (snapshot) await snapshotPrev(dir, snapshot);
  await writeFile(join(dir, "index.html"), html, "utf8");
  store.renameTool(toolId, nameFromHtml(html, ctx.originalPrompt), ctx.originalPrompt.slice(0, 180), "static");
}

async function buildServerTool(
  model: ChatOllama,
  store: ScopedStore,
  supervisor: ToolSupervisor,
  toolId: string,
  dir: string,
  ctx: GenContext,
  snapshot: ToolRecord | null
): Promise<string> {
  if (!supervisor.denoAvailable()) {
    throw new Error("this tool needs a backend, which requires the Deno runtime (not found on this machine)");
  }
  await mkdir(join(dir, "data"), { recursive: true });

  const firstCut = await generateOperations(model, ctx);

  // For an improve: quiesce the running backend so the copy the smoke test
  // seeds from is a consistent, WAL-checkpointed snapshot of the real data. It
  // restarts on the next request (agent or frontend) either way.
  if (snapshot) supervisor.stop(toolId);

  const { operations, note } = await validateOperations(
    model,
    supervisor,
    join(dir, STAGE),
    ctx,
    firstCut,
    /* mustSucceed */ snapshot !== null && !!ctx.priorOperations,
    /* seedFromDir  */ snapshot !== null ? dir : undefined
  );

  const html = await generateHtml(model, "server", ctx, operations);

  await commitServerTool(dir, operations, html, snapshot ? { store, tool: snapshot } : null);
  store.renameTool(toolId, nameFromHtml(html, ctx.originalPrompt), ctx.originalPrompt.slice(0, 180), "server");

  supervisor.stop(toolId);
  await refreshManifest(toolId, store.getTool(toolId)?.name ?? "tool", supervisor).catch(() => {});
  supervisor.stop(toolId);
  return note;
}

export interface BuildResult {
  tool: ToolRecord;
  ok: boolean;
  note: string;
}

// A codegen run that never returns (model hung) would sit at "building"
// forever — bound it.
const BUILD_TIMEOUT_MS = Number(process.env.FAMILY_AGENT_TOOL_BUILD_MS ?? 8 * 60_000);

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${BUILD_TIMEOUT_MS / 1000}s`)), BUILD_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Generate, write, and (for server tools) launch a NEW tool. Never throws — a
 * failure is recorded on the ToolRecord (status "failed") and returned.
 */
export async function buildTool(
  model: ChatOllama,
  store: ScopedStore,
  supervisor: ToolSupervisor,
  prompt: string
): Promise<BuildResult> {
  // Plan first: let the model decide backend-or-not and sketch the API, with
  // the keyword heuristic as the fallback.
  const plan = supervisor.denoAvailable() ? await planTool(model, prompt).catch(() => null) : null;
  const kind: ToolKind =
    supervisor.denoAvailable() && (plan ? plan.needsBackend : wantsBackend(prompt)) ? "server" : "static";
  const tool = store.createTool({ name: nameFromHtml("", prompt), description: prompt.slice(0, 180), prompt, kind });
  const dir = join(toolsDir(), tool.id);
  const ctx: GenContext = { originalPrompt: prompt, plannedOperations: kind === "server" ? plan?.operations : undefined };

  try {
    const note = await withTimeout(
      kind === "server"
        ? buildServerTool(model, store, supervisor, tool.id, dir, ctx, null)
        : buildStaticTool(model, store, tool.id, dir, ctx, null).then(() => ""),
      "build"
    );
    store.setToolStatus(tool.id, "ready");
    const done = store.getTool(tool.id)!;
    return { tool: done, ok: true, note: `Built "${done.name}".${note}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    store.setToolStatus(tool.id, "failed", msg);
    return { tool: store.getTool(tool.id)!, ok: false, note: `Could not build "${tool.name}": ${msg}` };
  }
}

export interface IterateResult {
  tool: ToolRecord;
  ok: boolean;
  note: string;
}

/**
 * Improve an existing tool in place. For a *ready* tool the current version
 * keeps serving until the new backend passes its smoke test, and the old files
 * are snapshotted to `prev/` for one-step revert. For a *failed* tool there's
 * nothing to protect, so this just rebuilds with the instruction folded in.
 */
export async function iterateTool(
  model: ChatOllama,
  store: ScopedStore,
  supervisor: ToolSupervisor,
  toolId: string,
  instruction: string
): Promise<IterateResult> {
  const tool = store.getTool(toolId);
  if (!tool) return { tool: undefined as never, ok: false, note: "tool not found" };
  const dir = join(toolsDir(), toolId);

  // A failed tool: rebuild from the original request + the new instruction.
  if (tool.status === "failed" || !existsSync(join(dir, "index.html"))) {
    const combined = `${tool.prompt}\n\nAlso: ${instruction}`;
    const kind: ToolKind = wantsBackend(combined) && supervisor.denoAvailable() ? "server" : "static";
    store.setToolStatus(toolId, "building", null);
    store.clearToolRevisionState(toolId);
    const ctx: GenContext = { originalPrompt: combined };
    try {
      const note = await withTimeout(
        kind === "server"
          ? buildServerTool(model, store, supervisor, toolId, dir, ctx, null)
          : buildStaticTool(model, store, toolId, dir, ctx, null).then(() => ""),
        "improve"
      );
      store.setToolStatus(toolId, "ready");
      return { tool: store.getTool(toolId)!, ok: true, note: `Rebuilt "${store.getTool(toolId)!.name}".${note}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.setToolStatus(toolId, "failed", msg);
      return { tool: store.getTool(toolId)!, ok: false, note: `Still couldn't build it: ${msg}` };
    }
  }

  // A change that needs to store/query data turns a display-only (static) tool
  // into a server tool with its own backend + operations the assistant can call.
  // (If the model then produces no operations, we downgrade back — see below.)
  const upgrading = tool.kind === "static" && improveWantsBackend(instruction) && supervisor.denoAvailable();
  const targetKind: ToolKind = upgrading ? "server" : tool.kind;

  // On an upgrade, plan the operations the same way a fresh build does.
  const upgradePlan = upgrading
    ? await planTool(model, `${tool.prompt}. The user now wants: ${instruction}`).catch(() => null)
    : null;

  // A working tool: keep it live, snapshot, swap only on success.
  store.beginToolRevision(toolId);
  const ctx: GenContext = {
    originalPrompt: tool.prompt,
    instruction,
    plannedOperations: upgradePlan?.operations,
    priorHtml: existsSync(join(dir, "index.html")) ? await readFile(join(dir, "index.html"), "utf8") : undefined,
    priorOperations: existsSync(join(dir, "operations.ts"))
      ? await readFile(join(dir, "operations.ts"), "utf8")
      : undefined,
    currentSchema: targetKind === "server" ? await currentSchemaOf(toolId) : undefined,
  };

  try {
    let note = await withTimeout(
      targetKind === "server"
        ? buildServerTool(model, store, supervisor, toolId, dir, ctx, tool)
        : buildStaticTool(model, store, toolId, dir, ctx, tool).then(() => ""),
      "improve"
    );

    // Upgraded to server but the model produced no operations — the change
    // didn't need a backend after all. Downgrade: drop the backend files (but
    // keep any static /__state JSON blobs in data/), keep the fresh page.
    if (upgrading && (readManifestCache(toolId)?.operations.length ?? 0) === 0) {
      supervisor.stop(toolId);
      for (const f of ["operations.ts", "server.ts", "mcp.json"]) await rm(join(dir, f), { force: true });
      for (const f of DB_FILES) await rm(join(dir, "data", f), { force: true });
      store.renameTool(toolId, store.getTool(toolId)!.name, store.getTool(toolId)!.description, "static");
      note = "";
    }

    store.finishToolRevision(toolId, { ok: true });
    const done = store.getTool(toolId)!;
    return { tool: done, ok: true, note: `Updated "${done.name}".${note}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The live version was never touched — clean up staging, bring the old
    // backend back up, and report.
    await rm(join(dir, STAGE), { recursive: true, force: true }).catch(() => {});
    if (targetKind === "server" && tool.kind === "server") void supervisor.portFor(toolId).catch(() => {});
    store.finishToolRevision(toolId, { ok: false, error: msg });
    return { tool: store.getTool(toolId)!, ok: false, note: `Couldn't make that change: ${msg}. The tool still works as before.` };
  }
}
