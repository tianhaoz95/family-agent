import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { toolsDir } from "../src/config.js";
import { HARNESS } from "../src/tools/harness.js";
import { ToolSupervisor, resolveDenoPath } from "../src/tools/supervisor.js";
import {
  refreshManifest,
  callOperation,
  readManifestCache,
  clampResult,
} from "../src/tools/toolMcp.js";
import { validateInput } from "../src/tools/validateInput.js";
import { makeFamilyToolTools, type FamilyToolEntry } from "../src/agents/toolTools.js";
import type { CallResult } from "../src/tools/toolMcp.js";

// ---------------------------------------------------------------------------
// Pure units — no Deno, no model.
// ---------------------------------------------------------------------------

describe("validateInput", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
      urgent: { type: "boolean" },
      kind: { type: "string", enum: ["a", "b"] },
    },
    required: ["query"],
  };

  it("passes a valid object and coerces query-string types", () => {
    const r = validateInput(schema, { query: "tent", limit: "5", urgent: "true" });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ query: "tent", limit: 5, urgent: true });
  });

  it("flags a missing required field", () => {
    const r = validateInput(schema, { limit: 3 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/query is required/);
  });

  it("flags a wrong type and a bad enum", () => {
    expect(validateInput(schema, { query: 5 }).errors.join(" ")).toMatch(/query must be a string/);
    expect(validateInput(schema, { query: "x", kind: "z" }).errors.join(" ")).toMatch(/kind must be one of/);
  });

  it("is lenient about schemas it doesn't model", () => {
    expect(validateInput(undefined, { anything: 1 }).ok).toBe(true);
    expect(validateInput({ type: "object", properties: {} }, {}).ok).toBe(true);
  });
});

describe("clampResult", () => {
  it("slices a long array", () => {
    const { value, truncated } = clampResult(Array.from({ length: 500 }, (_, i) => i));
    expect(truncated).toBe(true);
    expect((value as number[]).length).toBe(100);
  });
  it("truncates an oversized string blob", () => {
    const { value, truncated } = clampResult({ big: "x".repeat(20_000) });
    expect(truncated).toBe(true);
    expect(String(value)).toMatch(/…\(truncated\)$/);
  });
  it("passes a small result through untouched", () => {
    expect(clampResult({ a: 1 })).toEqual({ value: { a: 1 }, truncated: false });
  });
});

describe("makeFamilyToolTools", () => {
  const catalog: FamilyToolEntry[] = [
    {
      id: "TRACKER01",
      name: "Item Tracker",
      description: "where the family's stuff lives",
      kind: "server",
      operations: [
        {
          name: "find_item",
          description: "look up an item",
          access: "read",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
        {
          name: "save_item",
          description: "record an item's location",
          access: "write",
          inputSchema: {
            type: "object",
            properties: { name: { type: "string" }, location: { type: "string" } },
            required: ["name", "location"],
          },
        },
      ],
    },
    {
      id: "RECIPES01",
      name: "Recipe Randomizer",
      description: "picks a random dinner",
      kind: "static",
      operations: [],
    },
  ];

  function setup(callResult: CallResult) {
    const activity: string[] = [];
    const refs: string[] = [];
    const calls: { toolId: string; op: string; args: unknown }[] = [];
    const [listTool, callTool] = makeFamilyToolTools({
      getCatalog: () => catalog,
      callOperation: async (toolId, op, args) => {
        calls.push({ toolId, op, args });
        return callResult;
      },
      onReference: (r) => refs.push(`${r.type}:${r.id}`),
      logActivity: (_actor, action, detail) => activity.push(`${action} ${detail}`),
    });
    return { listTool, callTool, activity, refs, calls };
  }

  it("list_family_tools renders the catalog with operations and params", async () => {
    const { listTool } = setup({ ok: true });
    const out = (await listTool.invoke({})) as string;
    expect(out).toMatch(/Item Tracker/);
    expect(out).toMatch(/find_item \[read\]/);
    expect(out).toMatch(/save_item \[write\]/);
    expect(out).toMatch(/query \(string, required\)/);
  });

  it("call_family_tool resolves the tool, calls it, and records a reference", async () => {
    const { callTool, refs, calls } = setup({ ok: true, value: [{ name: "tent", location: "garage" }] });
    const out = (await callTool.invoke({ tool: "item tracker", operation: "find_item", input: { query: "tent" } })) as string;
    expect(calls).toEqual([{ toolId: "TRACKER01", op: "find_item", args: { query: "tent" } }]);
    expect(refs).toEqual(["tool:TRACKER01"]);
    expect(out).toMatch(/garage/);
  });

  it("logs an activity line for a write operation only", async () => {
    const { callTool, activity } = setup({ ok: true, value: { ok: true } });
    await callTool.invoke({ tool: "Item Tracker", operation: "find_item", input: { query: "x" } });
    expect(activity).toEqual([]);
    await callTool.invoke({ tool: "Item Tracker", operation: "save_item", input: { name: "tent", location: "shed" } });
    // A plain-language line, no snake_case or JSON — see makeFamilyToolTools.
    expect(activity.join(" ")).toMatch(/tool\.invoked Item Tracker: .*name tent, location shed/);
    expect(activity.join(" ")).not.toMatch(/save_item|\{/);
  });

  it("rejects a bad operation name and bad input before calling", async () => {
    const { callTool, calls } = setup({ ok: true });
    expect(await callTool.invoke({ tool: "Item Tracker", operation: "nope", input: {} })).toMatch(/no operation "nope"/);
    expect(await callTool.invoke({ tool: "Item Tracker", operation: "find_item", input: {} })).toMatch(
      /query is required/,
    );
    expect(calls).toEqual([]);
  });

  it("surfaces an unknown tool with the real tool names", async () => {
    const { callTool } = setup({ ok: true });
    const out = (await callTool.invoke({ tool: "Budget App", operation: "x", input: {} })) as string;
    expect(out).toMatch(/No family tool matches/);
    expect(out).toMatch(/Item Tracker/);
    expect(out).toMatch(/Recipe Randomizer/);
  });

  it("list_family_tools shows a display-only tool, not omits it", async () => {
    const { listTool } = setup({ ok: true });
    const out = (await listTool.invoke({})) as string;
    expect(out).toMatch(/Recipe Randomizer/);
    expect(out).toMatch(/display-only/);
  });

  it("call_family_tool on a display-only tool points to improving it, not 'no tool'", async () => {
    const { callTool, calls } = setup({ ok: true });
    const out = (await callTool.invoke({ tool: "Recipe Randomizer", operation: "add_recipe", input: {} })) as string;
    expect(out).toMatch(/display-only/i);
    expect(out).toMatch(/improved|builder-agent/i);
    expect(out).not.toMatch(/no family tool matches/i);
    expect(calls).toEqual([]);
  });

  it("call_family_tool on a real tool missing the operation suggests improving it", async () => {
    const { callTool } = setup({ ok: true });
    const out = (await callTool.invoke({ tool: "Item Tracker", operation: "export_csv", input: {} })) as string;
    expect(out).toMatch(/no operation "export_csv"/);
    expect(out).toMatch(/improved|don't build a new tool/i);
  });
});

// ---------------------------------------------------------------------------
// Deno-backed — the real harness MCP server + the agent-core client.
// ---------------------------------------------------------------------------

const run = resolveDenoPath() ? describe : describe.skip;

const ITEM_OPERATIONS = `export const operations = [
  {
    name: "find_item",
    description: "Find where an item is stored",
    access: "read",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, location TEXT)");
      return ctx.db.prepare("SELECT name, location FROM items WHERE name LIKE ?").all("%" + (input.query ?? "") + "%");
    },
  },
  {
    name: "save_item",
    description: "Record an item location",
    access: "write",
    inputSchema: { type: "object", properties: { name: { type: "string" }, location: { type: "string" } }, required: ["name", "location"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, location TEXT)");
      ctx.db.prepare("INSERT INTO items (name, location) VALUES (?, ?)").run(input.name, input.location);
      return { ok: true, saved: input };
    },
  },
];`;

run("tool MCP server + client (Deno)", () => {
  const supervisor = new ToolSupervisor();
  const dirs: string[] = [];

  afterEach(() => {
    supervisor.stopAll();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function seedServerTool(id: string, files: Record<string, string>): string {
    const dir = join(toolsDir(), id);
    mkdirSync(join(dir, "data"), { recursive: true });
    dirs.push(dir);
    writeFileSync(join(dir, "server.ts"), HARNESS);
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }

  const rpc = (port: number, method: string, params?: unknown) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then((r) => r.json());

  it("serves initialize / tools/list / tools/call and /api + /__manifest", async () => {
    seedServerTool("ZMCPTOOL1", { "operations.ts": ITEM_OPERATIONS });
    const port = await supervisor.start("ZMCPTOOL1");

    const init = await rpc(port, "initialize", {});
    expect(init.result.protocolVersion).toBeTruthy();
    expect(init.result.capabilities.tools).toBeDefined();

    const list = await rpc(port, "tools/list");
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual(["find_item", "save_item"]);
    expect(list.result.tools.find((t: any) => t.name === "find_item").annotations.readOnlyHint).toBe(true);

    const save = await rpc(port, "tools/call", { name: "save_item", arguments: { name: "passport", location: "safe" } });
    expect(save.result.isError).toBe(false);
    expect(save.result.structuredContent).toMatchObject({ ok: true });

    const find = await rpc(port, "tools/call", { name: "find_item", arguments: { query: "pass" } });
    expect(JSON.parse(find.result.content[0].text)).toEqual([{ name: "passport", location: "safe" }]);

    // REST convenience route the frontend uses.
    const rest = await fetch(`http://127.0.0.1:${port}/api/find_item?query=pass`).then((r) => r.json());
    expect(rest).toEqual([{ name: "passport", location: "safe" }]);

    const manifest = await fetch(`http://127.0.0.1:${port}/__manifest`).then((r) => r.json());
    expect(manifest.operations.map((o: any) => `${o.name}:${o.access}`).sort()).toEqual([
      "find_item:read",
      "save_item:write",
    ]);
  }, 30_000);

  it("returns JSON-RPC errors for bad method / bad tool / parse error, and 202 for a notification", async () => {
    seedServerTool("ZMCPTOOL2", { "operations.ts": ITEM_OPERATIONS });
    const port = await supervisor.start("ZMCPTOOL2");

    expect((await rpc(port, "no/such/method")).error.code).toBe(-32601);
    expect((await rpc(port, "tools/call", { name: "ghost", arguments: {} })).error.code).toBe(-32602);

    const parse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }).then((r) => r.json());
    expect(parse.error.code).toBe(-32700);

    const notif = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notif.status).toBe(202);
  }, 30_000);

  it("an operation that throws comes back as isError, not a crash", async () => {
    seedServerTool("ZMCPTOOL3", {
      "operations.ts": `export const operations = [{
        name: "boom", description: "always throws", access: "read",
        inputSchema: { type: "object", properties: {} },
        async run() { throw new Error("kaboom"); },
      }];`,
    });
    const port = await supervisor.start("ZMCPTOOL3");
    const res = await rpc(port, "tools/call", { name: "boom", arguments: {} });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toMatch(/kaboom/);
  }, 30_000);

  it("still runs a legacy handler.ts tool (no operations.ts)", async () => {
    seedServerTool("ZMCPLEGACY", {
      "handler.ts": `export async function handler(req, ctx) {
        const url = new URL(req.url);
        if (url.pathname === "/ping") return new Response("pong");
        return new Response("nope", { status: 404 });
      }`,
    });
    const port = await supervisor.start("ZMCPLEGACY");
    expect(await (await fetch(`http://127.0.0.1:${port}/ping`)).text()).toBe("pong");
    // MCP endpoint answers with an empty tool list rather than 404.
    expect((await rpc(port, "tools/list")).result.tools).toEqual([]);
    // /__state still works for a legacy tool.
    await fetch(`http://127.0.0.1:${port}/__state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(await (await fetch(`http://127.0.0.1:${port}/__state`)).json()).toEqual({ a: 1 });
  }, 30_000);

  it("refreshManifest caches to mcp.json and callOperation round-trips", async () => {
    const dir = seedServerTool("ZMCPCLIENT", { "operations.ts": ITEM_OPERATIONS });

    const manifest = await refreshManifest("ZMCPCLIENT", "Item Tracker", supervisor);
    expect(manifest?.operations.map((o) => o.name).sort()).toEqual(["find_item", "save_item"]);
    expect(existsSync(join(dir, "mcp.json"))).toBe(true);

    const cached = readManifestCache("ZMCPCLIENT");
    expect(cached?.operations.length).toBe(2);
    expect(cached?.name).toBe("Item Tracker");

    const w = await callOperation("ZMCPCLIENT", "save_item", { name: "drill", location: "garage" }, supervisor);
    expect(w.ok).toBe(true);

    const r = await callOperation("ZMCPCLIENT", "find_item", { query: "drill" }, supervisor);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([{ name: "drill", location: "garage" }]);

    const bad = await callOperation("ZMCPCLIENT", "find_item", {}, supervisor);
    // The op itself runs (LIKE '%undefined%') but returns [] — not an error.
    expect(bad.ok).toBe(true);
  }, 40_000);

  it("refreshManifest returns null for a tool with no operations", async () => {
    seedServerTool("ZMCPEMPTY", { "operations.ts": "export const operations = [];" });
    expect(await refreshManifest("ZMCPEMPTY", "Empty", supervisor)).toBe(null);
  }, 30_000);
});
