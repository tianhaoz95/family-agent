import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/db.js";
import { toolsDir } from "../src/config.js";
import { ToolSupervisor, resolveDenoPath } from "../src/tools/supervisor.js";
import { buildTool, iterateTool, revertTool, toolHasPreviousVersion } from "../src/tools/builder.js";
import { readManifestCache, callOperation } from "../src/tools/toolMcp.js";

// A stand-in for ChatOllama: routes on the system prompt to a canned reply.
function fakeModel(replies: {
  operations?: string | string[];
  html?: string;
  repair?: string;
  /** Plan step reply — defaults to needsBackend=true iff `operations` is set. */
  plan?: { needsBackend: boolean; operations?: { name: string; summary: string; access: string }[] };
}) {
  const opsQueue = Array.isArray(replies.operations) ? [...replies.operations] : replies.operations ? [replies.operations] : [];
  const plan = replies.plan ?? { needsBackend: !!replies.operations, operations: [] };
  return {
    async invoke(msgs: { content: string }[]) {
      const system = String(msgs[0]?.content ?? "");
      const human = String(msgs[1]?.content ?? "");
      if (/You decide what a small family/i.test(system)) return { content: JSON.stringify(plan) };
      if (/failed to run\. Fix it/i.test(human) && replies.repair) return { content: replies.repair };
      if (/operations\.ts/i.test(system)) {
        return { content: opsQueue.length > 1 ? opsQueue.shift()! : opsQueue[0] ?? "export const operations = [];" };
      }
      if (/HTML document/i.test(system)) {
        return {
          content:
            replies.html ??
            "<!doctype html><html><head><title>T</title></head><body><script>fetch('api/list_x')</script></body></html>",
        };
      }
      return { content: "" };
    },
  } as never;
}

// The static path needs no Deno — it just writes an index.html.
describe("tool builder: static tool (no Deno)", () => {
  const dirs: string[] = [];
  let before = new Set<string>();
  beforeEach(() => {
    before = new Set(existsSync(toolsDir()) ? readdirSync(toolsDir()) : []);
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const d of existsSync(toolsDir()) ? readdirSync(toolsDir()) : []) {
      if (!before.has(d)) rmSync(join(toolsDir(), d), { recursive: true, force: true });
    }
  });

  it("creates the tool directory and writes index.html for a fresh static build", async () => {
    const store = new Store(":memory:");
    const u = store.createUser({ username: "s", displayName: "s", password: "sekret123", role: "admin" });
    const supervisor = new ToolSupervisor();
    // A prompt that doesn't want a backend -> static tool.
    const res = await buildTool(
      fakeModel({ html: "<!doctype html><html><head><title>Tip Splitter</title></head><body>ok</body></html>" }) as never,
      store.scoped(u.id),
      supervisor,
      "a tip calculator for splitting a restaurant bill"
    );
    dirs.push(join(toolsDir(), res.tool.id));
    expect(res.ok).toBe(true);
    expect(res.tool.kind).toBe("static");
    expect(res.tool.status).toBe("ready");
    expect(existsSync(join(toolsDir(), res.tool.id, "index.html"))).toBe(true);
    supervisor.stopAll();
  });
});

const ITEMS_V1 = `export const operations = [
  {
    name: "list_items", description: "List items", access: "read",
    inputSchema: { type: "object", properties: {} },
    async run(_input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, room TEXT)");
      return ctx.db.prepare("SELECT name, room FROM items ORDER BY name").all();
    },
  },
  {
    name: "add_item", description: "Add an item", access: "write",
    inputSchema: { type: "object", properties: { name: { type: "string" }, room: { type: "string" } }, required: ["name", "room"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, room TEXT)");
      ctx.db.prepare("INSERT INTO items (name, room) VALUES (?, ?)").run(input.name, input.room);
      return { ok: true };
    },
  },
];`;

// v2 adds a "notes" column additively — must not lose v1 rows.
const ITEMS_V2 = `export const operations = [
  {
    name: "list_items", description: "List items with notes", access: "read",
    inputSchema: { type: "object", properties: {} },
    async run(_input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, room TEXT)");
      try { ctx.db.exec("ALTER TABLE items ADD COLUMN notes TEXT"); } catch (_) {}
      return ctx.db.prepare("SELECT name, room, notes FROM items ORDER BY name").all();
    },
  },
  {
    name: "add_item", description: "Add an item", access: "write",
    inputSchema: { type: "object", properties: { name: { type: "string" }, room: { type: "string" }, notes: { type: "string" } }, required: ["name", "room"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, room TEXT)");
      try { ctx.db.exec("ALTER TABLE items ADD COLUMN notes TEXT"); } catch (_) {}
      ctx.db.prepare("INSERT INTO items (name, room, notes) VALUES (?, ?, ?)").run(input.name, input.room, input.notes ?? null);
      return { ok: true };
    },
  },
];`;

const BROKEN = `export const operations = [
  { name: "boom", description: "x", access: "read", inputSchema: { type: "object", properties: {} },
    async run(_i, ctx) { return ctx.db.prepare("SELECT * FROM nope_no_table").all(); } },
];`;

// A migration bug: list_items SELECTs a "tag" column but only add_item ALTERs it
// in. Against the real (old) database this crashes on the very first read.
const ITEMS_BADMIGRATION = `export const operations = [
  {
    name: "list_items", description: "List items with tags", access: "read",
    inputSchema: { type: "object", properties: {} },
    async run(_input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, room TEXT)");
      return ctx.db.prepare("SELECT name, room, tag FROM items ORDER BY name").all();
    },
  },
  {
    name: "add_item", description: "Add an item", access: "write",
    inputSchema: { type: "object", properties: { name: { type: "string" }, room: { type: "string" }, tag: { type: "string" } }, required: ["name", "room"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, room TEXT)");
      try { ctx.db.exec("ALTER TABLE items ADD COLUMN tag TEXT"); } catch (_) {}
      ctx.db.prepare("INSERT INTO items (name, room, tag) VALUES (?, ?, ?)").run(input.name, input.room, input.tag ?? null);
      return { ok: true };
    },
  },
];`;

// The repair: the guarded ALTER now runs at the top of BOTH operations.
const ITEMS_GOODMIGRATION = ITEMS_BADMIGRATION.replace(
  'ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, room TEXT)");\n      return ctx.db.prepare("SELECT name, room, tag',
  'ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, room TEXT)");\n      try { ctx.db.exec("ALTER TABLE items ADD COLUMN tag TEXT"); } catch (_) {}\n      return ctx.db.prepare("SELECT name, room, tag'
);

// A destructive improve: rebuilds the table without the "room" column.
const ITEMS_DROP_ROOM = `export const operations = [
  {
    name: "list_items", description: "List items", access: "read",
    inputSchema: { type: "object", properties: {} },
    async run(_input, ctx) {
      ctx.db.exec("DROP TABLE IF EXISTS items");
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)");
      return ctx.db.prepare("SELECT name FROM items ORDER BY name").all();
    },
  },
  {
    name: "add_item", description: "Add an item", access: "write",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run(input, ctx) {
      ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)");
      ctx.db.prepare("INSERT INTO items (name) VALUES (?)").run(input.name);
      return { ok: true };
    },
  },
];`;

const run = resolveDenoPath() ? describe : describe.skip;

run("tool builder: iterate / revert / self-repair (Deno)", () => {
  const supervisor = new ToolSupervisor();
  const dirs: string[] = [];
  let before = new Set<string>();

  beforeEach(() => {
    before = new Set(existsSync(toolsDir()) ? readdirSync(toolsDir()) : []);
  });

  afterEach(() => {
    supervisor.stopAll();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    // Belt-and-suspenders: a test that threw before dirs.push() still cleans up.
    for (const d of existsSync(toolsDir()) ? readdirSync(toolsDir()) : []) {
      if (!before.has(d)) rmSync(join(toolsDir(), d), { recursive: true, force: true });
    }
  });

  async function build(store: Store, model: unknown) {
    const u = store.createUser({ username: "u" + Math.random().toString(36).slice(2, 6), displayName: "u", password: "sekret123", role: "admin" });
    const scoped = store.scoped(u.id);
    const res = await buildTool(model as never, scoped, supervisor, "an item location tracker the family can update");
    dirs.push(join(toolsDir(), res.tool.id));
    return { scoped, res };
  }

  it("the plan step decides server-vs-static and the operations to expose", async () => {
    // Plan says a "recipe picker" needs a backend even though the prompt has no
    // storage keyword — and hands the operation list to codegen.
    const RECIPE_OPS = `export const operations = [
      { name: "add_recipe", description: "Add a recipe", access: "write",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        async run(i, ctx) { ctx.db.exec("CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, name TEXT)"); ctx.db.prepare("INSERT INTO recipes (name) VALUES (?)").run(i.name); return { ok: true }; } },
      { name: "random_recipe", description: "Pick a random recipe", access: "read",
        inputSchema: { type: "object", properties: {} },
        async run(_i, ctx) { ctx.db.exec("CREATE TABLE IF NOT EXISTS recipes (id INTEGER PRIMARY KEY, name TEXT)"); return ctx.db.prepare("SELECT name FROM recipes ORDER BY RANDOM() LIMIT 1").get() ?? {}; } },
    ];`;
    const store = new Store(":memory:");
    const u = store.createUser({ username: "pl", displayName: "u", password: "sekret123", role: "admin" });
    const res = await buildTool(
      fakeModel({
        plan: { needsBackend: true, operations: [{ name: "add_recipe", summary: "add", access: "write" }, { name: "random_recipe", summary: "pick", access: "read" }] },
        operations: RECIPE_OPS,
        html: "<!doctype html><html><head><title>Recipe Picker</title></head><body><h1>Recipes</h1><script>fetch('api/random_recipe')</script></body></html>",
      }) as never,
      store.scoped(u.id),
      supervisor,
      "a random recipe picker" // no storage keyword in the prompt
    );
    dirs.push(join(toolsDir(), res.tool.id));
    expect(res.ok).toBe(true);
    expect(res.tool.kind).toBe("server");
    expect(readManifestCache(res.tool.id)?.operations.map((o) => o.name).sort()).toEqual(["add_recipe", "random_recipe"]);
  }, 60_000);

  it("builds a server tool, smoke-tests it, and caches the manifest", async () => {
    const store = new Store(":memory:");
    const { res } = await build(store, fakeModel({ operations: ITEMS_V1 }));
    expect(res.ok).toBe(true);
    expect(res.tool.kind).toBe("server");
    expect(res.tool.status).toBe("ready");
    expect(res.tool.revisionCount).toBe(0);
    expect(readManifestCache(res.tool.id)?.operations.map((o) => o.name).sort()).toEqual(["add_item", "list_items"]);
  }, 60_000);

  it("upgrades a display-only static tool to a server tool when the change needs data", async () => {
    const store = new Store(":memory:");
    const u = store.createUser({ username: "up", displayName: "u", password: "sekret123", role: "admin" });
    const scoped = store.scoped(u.id);
    const built = await buildTool(
      fakeModel({ html: "<!doctype html><html><head><title>Recipe Randomizer</title></head><body>random</body></html>" }) as never,
      scoped,
      supervisor,
      "a random recipe picker"
    );
    dirs.push(join(toolsDir(), built.tool.id));
    expect(built.tool.kind).toBe("static");

    const up = await iterateTool(
      fakeModel({
        operations: ITEMS_V1,
        html: "<!doctype html><html><head><title>Recipe Box</title></head><body><h1>Recipe Box</h1><div id=list></div><script>fetch('api/list_items')</script></body></html>",
      }) as never,
      scoped,
      supervisor,
      built.tool.id,
      "let me add and save my own recipes to a collection"
    );
    expect(up.ok).toBe(true);
    const t = scoped.getTool(built.tool.id)!;
    expect(t.kind).toBe("server");
    expect(readManifestCache(built.tool.id)?.operations.map((o) => o.name).sort()).toEqual(["add_item", "list_items"]);
    // revert takes it back to static and drops the manifest
    const rev = await revertTool(scoped, supervisor, built.tool.id);
    expect(rev.ok).toBe(true);
    expect(scoped.getTool(built.tool.id)!.kind).toBe("static");
    expect(existsSync(join(toolsDir(), built.tool.id, "mcp.json"))).toBe(false);
    expect(existsSync(join(toolsDir(), built.tool.id, "operations.ts"))).toBe(false);
  }, 120_000);

  it("improves in place: keeps data, snapshots prev/, bumps revisionCount", async () => {
    const store = new Store(":memory:");
    const { scoped, res } = await build(store, fakeModel({ operations: ITEMS_V1 }));
    const id = res.tool.id;

    // put a row in through the running backend
    expect((await callOperation(id, "add_item", { name: "tent", room: "garage" }, supervisor)).ok).toBe(true);

    const it1 = await iterateTool(fakeModel({ operations: ITEMS_V2 }) as never, scoped, supervisor, id, "add a notes field to each item");
    expect(it1.ok).toBe(true);

    const t = scoped.getTool(id)!;
    expect(t.revisionCount).toBe(1);
    expect(t.revisionState).toBe(null);
    expect(toolHasPreviousVersion(id)).toBe(true);
    expect(existsSync(join(toolsDir(), id, "prev", "operations.ts"))).toBe(true);

    // the row survived, and the new column is queryable
    const rows = (await callOperation(id, "list_items", {}, supervisor)).value as Record<string, unknown>[];
    expect(rows).toEqual([{ name: "tent", room: "garage", notes: null }]);
    expect(readManifestCache(id)?.operations.find((o) => o.name === "list_items")?.description).toBe("List items with notes");
  }, 90_000);

  it("catches a migration bug (read op SELECTs a column it never ALTERs in) and self-repairs", async () => {
    const store = new Store(":memory:");
    const { scoped, res } = await build(store, fakeModel({ operations: ITEMS_V1 }));
    const id = res.tool.id;
    await callOperation(id, "add_item", { name: "tent", room: "garage" }, supervisor);

    const it1 = await iterateTool(
      fakeModel({ operations: ITEMS_BADMIGRATION, repair: ITEMS_GOODMIGRATION }) as never,
      scoped,
      supervisor,
      id,
      "add a tag to each item"
    );
    expect(it1.ok).toBe(true); // the repair fixed the missing ALTER
    const rows = (await callOperation(id, "list_items", {}, supervisor)).value as Record<string, unknown>[];
    expect(rows).toEqual([{ name: "tent", room: "garage", tag: null }]);
  }, 120_000);

  it("an unfixable migration bug keeps the working version + its data", async () => {
    const store = new Store(":memory:");
    const { scoped, res } = await build(store, fakeModel({ operations: ITEMS_V1 }));
    const id = res.tool.id;
    await callOperation(id, "add_item", { name: "tent", room: "garage" }, supervisor);

    const bad = await iterateTool(
      fakeModel({ operations: ITEMS_BADMIGRATION, repair: ITEMS_BADMIGRATION }) as never,
      scoped,
      supervisor,
      id,
      "add a tag"
    );
    expect(bad.ok).toBe(false);
    expect(scoped.getTool(id)!.revisionState).toBeTruthy();
    // old code + data intact
    expect(readFileSync(join(toolsDir(), id, "operations.ts"), "utf8")).not.toContain("tag");
    expect((await callOperation(id, "list_items", {}, supervisor)).value).toEqual([{ name: "tent", room: "garage" }]);
  }, 120_000);

  it("revert restores the DATA too when an improve dropped a column", async () => {
    const store = new Store(":memory:");
    const { scoped, res } = await build(store, fakeModel({ operations: ITEMS_V1 }));
    const id = res.tool.id;
    await callOperation(id, "add_item", { name: "tent", room: "garage" }, supervisor);

    // a destructive improve — rebuilds the table without "room". Smoke-tests
    // green (it's self-consistent), so it commits.
    await iterateTool(fakeModel({ operations: ITEMS_DROP_ROOM }) as never, scoped, supervisor, id, "simplify the schema");
    // trigger the drop by using the tool
    await callOperation(id, "list_items", {}, supervisor);
    expect((await callOperation(id, "list_items", {}, supervisor)).value).toEqual([]); // room + its data gone

    const rev = await revertTool(scoped, supervisor, id);
    expect(rev.ok).toBe(true);
    expect(rev.note).toMatch(/data was restored/i);
    expect((await callOperation(id, "list_items", {}, supervisor)).value).toEqual([{ name: "tent", room: "garage" }]);
  }, 120_000);

  it("reverts to the previous version, restoring code + clearing prev/", async () => {
    const store = new Store(":memory:");
    const { scoped, res } = await build(store, fakeModel({ operations: ITEMS_V1 }));
    const id = res.tool.id;
    await iterateTool(fakeModel({ operations: ITEMS_V2 }) as never, scoped, supervisor, id, "add notes");

    expect(readFileSync(join(toolsDir(), id, "operations.ts"), "utf8")).toContain("List items with notes");
    const rev = await revertTool(scoped, supervisor, id);
    expect(rev.ok).toBe(true);
    expect(readFileSync(join(toolsDir(), id, "operations.ts"), "utf8")).toContain('description: "List items"');
    expect(toolHasPreviousVersion(id)).toBe(false);
    // manifest reflects the reverted code
    expect(readManifestCache(id)?.operations.find((o) => o.name === "list_items")?.description).toBe("List items");
  }, 90_000);

  it("a broken improve leaves the working tool untouched and records the failure", async () => {
    const store = new Store(":memory:");
    const { scoped, res } = await build(store, fakeModel({ operations: ITEMS_V1 }));
    const id = res.tool.id;
    await callOperation(id, "add_item", { name: "drill", room: "shed" }, supervisor);

    // model returns broken code both times (initial + repair)
    const bad = await iterateTool(fakeModel({ operations: BROKEN, repair: BROKEN }) as never, scoped, supervisor, id, "break it");
    expect(bad.ok).toBe(false);

    const t = scoped.getTool(id)!;
    expect(t.revisionCount).toBe(0);
    expect(t.revisionState).toBeTruthy();
    expect(t.revisionState).not.toBe("revising");
    expect(t.status).toBe("ready"); // still works

    // old operations still on disk, old data still there
    expect(readFileSync(join(toolsDir(), id, "operations.ts"), "utf8")).toContain('description: "List items"');
    expect((await callOperation(id, "list_items", {}, supervisor)).value).toEqual([{ name: "drill", room: "shed" }]);
    expect(existsSync(join(toolsDir(), id, ".next"))).toBe(false);
  }, 90_000);

  it("self-repairs a broken first cut on a fresh build", async () => {
    const store = new Store(":memory:");
    // first operations reply is broken; the repair reply is good
    const { res } = await build(store, fakeModel({ operations: [BROKEN, BROKEN], repair: ITEMS_V1 }));
    expect(res.ok).toBe(true);
    expect(res.tool.status).toBe("ready");
    expect(readManifestCache(res.tool.id)?.operations.map((o) => o.name).sort()).toEqual(["add_item", "list_items"]);
  }, 90_000);

  it("a fresh build with an unfixable backend still ships (frontend only), no agent ops", async () => {
    const store = new Store(":memory:");
    const { res } = await build(store, fakeModel({ operations: [BROKEN, BROKEN], repair: BROKEN }));
    expect(res.ok).toBe(true);
    expect(res.tool.status).toBe("ready");
    expect(res.note).toMatch(/assistant can't use it/i);
    expect(readManifestCache(res.tool.id)?.operations ?? []).toEqual([]); // no agent operations
  }, 90_000);

  it("improving a failed tool rebuilds it from the original prompt + instruction", async () => {
    const store = new Store(":memory:");
    // build fails because HTML generation never produces a usable document
    const { scoped, res } = await build(store, fakeModel({ operations: ITEMS_V1, html: "nope" }));
    expect(res.ok).toBe(false);
    expect(res.tool.status).toBe("failed");

    const fixed = await iterateTool(fakeModel({ operations: ITEMS_V1 }) as never, scoped, supervisor, res.tool.id, "make it actually work");
    expect(fixed.ok).toBe(true);
    expect(scoped.getTool(res.tool.id)!.status).toBe("ready");
    // no prev/ — there was nothing working to snapshot
    expect(toolHasPreviousVersion(res.tool.id)).toBe(false);
  }, 120_000);
});

describe("ToolSupervisor.smokeTest / denoCheck", () => {
  const supervisor = new ToolSupervisor();
  const maybe = resolveDenoPath() ? it : it.skip;

  maybe("smokeTest reports ok + the operation names, or the boot error", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { HARNESS } = await import("../src/tools/harness.js");
    const good = join(toolsDir(), "ZSMOKEGOOD");
    const bad = join(toolsDir(), "ZSMOKEBAD");
    try {
      mkdirSync(join(good, "data"), { recursive: true });
      writeFileSync(join(good, "server.ts"), HARNESS);
      writeFileSync(join(good, "operations.ts"), ITEMS_V1);
      const okRes = await supervisor.smokeTest(good);
      expect(okRes.ok).toBe(true);
      expect(okRes.operations?.sort()).toEqual(["add_item", "list_items"]);

      mkdirSync(join(bad, "data"), { recursive: true });
      writeFileSync(join(bad, "server.ts"), HARNESS);
      writeFileSync(join(bad, "operations.ts"), "export const operations = [ this is not valid ts");
      const badRes = await supervisor.smokeTest(bad);
      expect(badRes.ok).toBe(false);
      expect(badRes.error).toBeTruthy();
    } finally {
      supervisor.stopAll();
      rmSync(good, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    }
  }, 40_000);
});
