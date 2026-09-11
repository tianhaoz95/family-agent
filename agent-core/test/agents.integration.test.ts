import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store, type ScopedStore } from "../src/db.js";
import { config, toolsDir } from "../src/config.js";
import { HARNESS } from "../src/tools/harness.js";
import { resolveDenoPath } from "../src/tools/supervisor.js";
import { seedUser, authInject } from "./helpers.js";

// Real end-to-end tests against the local Ollama model (gemma4:e2b by
// default). These are slow — gemma4:e2b is a larger multimodal model and a
// full planner turn on CPU has taken ~110s in testing — and are skipped
// automatically if the model isn't reachable, so the fast unit tests still
// pass in an environment without Ollama set up. See docs/BUILD_LOG.md for
// the last recorded run against a live model.
async function modelIsReady(): Promise<boolean> {
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/tags`);
    if (!res.ok) return false;
    const body = (await res.json()) as { models?: { name: string }[] };
    return !!body.models?.some((m) => m.name === config.model || m.name === `${config.model}:latest`);
  } catch {
    return false;
  }
}

const ready = await modelIsReady();
const maybe = ready ? describe : describe.skip;

maybe("family agent (live model: " + config.model + ")", () => {
  let app: FastifyInstance;
  let store: ScopedStore;
  let inject: ReturnType<typeof authInject>;

  beforeAll(() => {
    const raw = new Store(":memory:");
    app = buildServer(raw);
    const seeded = seedUser(raw);
    store = seeded.scoped;
    inject = authInject(app, seeded.token);
  });

  it(
    "creates a task from a natural-language request via /chat",
    async () => {
      const res = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "Please add a task to renew the car registration by 2026-11-01." },
      });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().reply).toBe("string");

      const tasks = store.listTasks();
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    },
    240000
  );

  it(
    "creates a task from a bare action phrase instead of refusing it",
    async () => {
      // Regression test: this exact phrasing previously made task-agent
      // refuse ("I cannot help you with buying stamps") because the
      // planner's delegation description dropped the "create a task"
      // framing, leaving task-agent a bare action phrase it read literally.
      const res = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "Add a task to buy stamps" },
      });
      expect(res.statusCode).toBe(200);
      const reply = res.json().reply.toLowerCase();
      expect(reply).not.toContain("cannot");
      expect(reply).not.toContain("i'm sorry");

      const stampTask = store.listTasks().find((t) => t.title.toLowerCase().includes("stamp"));
      expect(stampTask).toBeDefined();
    },
    240000
  );

  it(
    "extracts fields from an ingested document",
    async () => {
      const ingest = await inject({
        method: "POST",
        url: "/documents/ingest",
        payload: {
          filename: "electric-bill.txt",
          text: "City Power & Light — Account #4471. Amount due: $86.40. Due date: 2026-10-05.",
        },
      });
      expect(ingest.statusCode).toBe(200);
      const docId = ingest.json().document.id;

      // Extraction runs asynchronously (see server.ts); poll for it.
      let extracted: unknown = null;
      for (let i = 0; i < 60; i++) {
        const doc = store.getDocument(docId);
        if (doc?.extracted) {
          extracted = doc.extracted;
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }

      expect(extracted).not.toBeNull();
    },
    240000
  );

  it(
    "answers 'what documents do I have' correctly once one exists",
    async () => {
      // Regression test: this exact prompt returned "I found no documents"
      // against a real ingested document before list_documents existed.
      const ingest = await inject({
        method: "POST",
        url: "/documents/ingest",
        payload: { filename: "insurance-note.txt", text: "Auto insurance renews 2026-12-01, premium $410." },
      });
      const docId = ingest.json().document.id;
      for (let i = 0; i < 60; i++) {
        if (store.getDocument(docId)?.extracted) break;
        await new Promise((r) => setTimeout(r, 3000));
      }

      const res = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "What documents do I have?" },
      });
      expect(res.statusCode).toBe(200);
      // The model is free to cite the document by filename, id, or category —
      // any of those confirms it actually found it via list_documents rather
      // than claiming ignorance (the bug this test guards against).
      const reply = res.json().reply.toLowerCase();
      expect(reply).toMatch(/insurance-note|insurance/);
    },
    240000
  );

  it(
    "answers 'what is my insurance number' with the number, not a privacy refusal",
    async () => {
      // Regression: uploading an insurance doc and asking for the number came
      // back as "I cannot provide personal information such as insurance
      // numbers. Please check your family documents for this information." —
      // a generic safety reflex applied to the family's own paperwork. See
      // docs/DECISIONS.md ("the planner refused to read a number off the
      // family's own document").
      // No need to wait for async field extraction — the FTS index is
      // populated by a synchronous trigger on ingest, and both the filename
      // and the body contain "insurance", so search_documents finds it now.
      await inject({
        method: "POST",
        url: "/documents/ingest",
        payload: {
          filename: "insurance.pdf",
          text: "Regence BlueShield health insurance. Member ID: 210284396. Group: 10001234.",
        },
      });

      const res = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "What is my insurance number?" },
      });
      expect(res.statusCode).toBe(200);
      const reply = res.json().reply as string;
      expect(reply).toContain("210284396");
      expect(reply.toLowerCase()).not.toMatch(/cannot provide|can'?t (?:provide|share)|check your (?:family )?documents/);
    },
    300000
  );

  it(
    "remembers an earlier turn of the same chat session",
    async () => {
      // The core claim of persisted chat sessions: resuming one actually
      // carries conversational memory, not just a saved transcript. Turn one
      // states a fact with no other source for it in tasks/documents; turn
      // two — sent with the same sessionId — asks for it back. If the reply
      // doesn't reflect it, server.ts isn't feeding session history into
      // askFamilyAgent (see agents/index.ts).
      const first = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "Remember this: my favorite color is teal. Just acknowledge it, nothing else." },
      });
      expect(first.statusCode).toBe(200);
      const sessionId = first.json().sessionId as string;
      expect(sessionId).toBeTruthy();

      const second = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "What did I just say my favorite color is?", sessionId },
      });
      expect(second.statusCode).toBe(200);
      expect((second.json().reply as string).toLowerCase()).toContain("teal");

      // Both turns of both messages ended up in the persisted session.
      const messages = (await inject({ method: "GET", url: `/chat/sessions/${sessionId}/messages` })).json()
        .messages;
      expect(messages).toHaveLength(4);
      expect(messages.map((m: { role: string }) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    },
    480000
  );

  it(
    "'/task' forces the task-agent path",
    async () => {
      const res = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "/task buy stamps" },
      });
      expect(res.statusCode).toBe(200);
      const stampTask = store.listTasks().find((t) => t.title.toLowerCase().includes("stamp"));
      expect(stampTask, `expected a stamp task, got ${JSON.stringify(store.listTasks())}`).toBeDefined();
    },
    240000
  );

  it(
    "'/task' with a relative day + bare time sets both dueDate and dueTime",
    async () => {
      // Regression test for the exact reported phrasing: task-agent had no
      // current_datetime tool and no prompt guidance to use one, so it left
      // dueDate/dueTime blank rather than resolve "tomorrow"/"7pm" itself —
      // which also meant the task never showed up in the calendar view
      // (bucketByDay treats a missing dueDate as "unscheduled").
      const res = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "/task go to doctor appointment 7pm tomorrow" },
      });
      expect(res.statusCode).toBe(200);
      const task = store.listTasks().find((t) => t.title.toLowerCase().includes("doctor"));
      expect(task, `expected a doctor task, got ${JSON.stringify(store.listTasks())}`).toBeDefined();
      expect(task!.dueDate, `expected dueDate to be set, got ${JSON.stringify(task)}`).toBeTruthy();
      expect(task!.dueTime, `expected dueTime to be set, got ${JSON.stringify(task)}`).toBeTruthy();
      // Tomorrow relative to whenever the test runs, and 7pm in 24h time.
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      expect(task!.dueDate).toBe(tomorrow);
      expect(task!.dueTime).toBe("19:00");
    },
    240000
  );

  it(
    "'/find' forces the document-agent path",
    async () => {
      await inject({
        method: "POST",
        url: "/documents/ingest",
        payload: { filename: "water-bill.txt", text: "City Water Utility. Amount due: $54.20. Due date: 2026-11-15." },
      });
      const res = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "/find the water bill" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().reply.toLowerCase()).toMatch(/water-bill|water/);
    },
    240000
  );

  it(
    "'/note' forces the notes-agent path",
    async () => {
      const res = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "/note the plumber comes Friday" },
      });
      expect(res.statusCode).toBe(200);
      const notes = [...store.listStickyNotes("shared"), ...store.listStickyNotes("private")];
      expect(
        notes.some((n) => /plumber/i.test(n.text)),
        `expected a plumber sticky note, got ${JSON.stringify(notes)}`
      ).toBe(true);
    },
    240000
  );
});

if (!ready) {
  describe("family agent (live model)", () => {
    it.skip(`skipped: ${config.model} not available at ${config.ollamaBaseUrl}`, () => {});
  });
}

// The tools-agent path needs a live model AND Deno (to run the tool backend).
const toolsMaybe = ready && resolveDenoPath() ? describe : describe.skip;

toolsMaybe("family agent → tools-agent (live model + Deno)", () => {
  let app: FastifyInstance;
  let store: ScopedStore;
  let inject: ReturnType<typeof authInject>;
  let toolDir = "";
  let toolId = "";

  const OPS = `export const operations = [
    {
      name: "find_item", description: "Find where an item is stored", access: "read",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async run(input, ctx) {
        ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, location TEXT)");
        return ctx.db.prepare("SELECT name, location FROM items WHERE name LIKE ?").all("%" + (input.query ?? "") + "%");
      },
    },
    {
      name: "save_item", description: "Record where an item is stored", access: "write",
      inputSchema: { type: "object", properties: { name: { type: "string" }, location: { type: "string" } }, required: ["name", "location"] },
      async run(input, ctx) {
        ctx.db.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, location TEXT)");
        ctx.db.prepare("INSERT INTO items (name, location) VALUES (?, ?)").run(input.name, input.location);
        return { ok: true };
      },
    },
  ];`;

  beforeAll(() => {
    const raw = new Store(":memory:");
    app = buildServer(raw);
    const seeded = seedUser(raw);
    store = seeded.scoped;
    inject = authInject(app, seeded.token);

    const t = store.createTool({
      name: "Item Tracker",
      description: "where the family's stuff is",
      prompt: "an item tracker",
      kind: "server",
    });
    store.setToolStatus(t.id, "ready");
    toolId = t.id;
    toolDir = join(toolsDir(), t.id);
    mkdirSync(join(toolDir, "data"), { recursive: true });
    writeFileSync(join(toolDir, "server.ts"), HARNESS);
    writeFileSync(join(toolDir, "operations.ts"), OPS);
    // The build-time MCP manifest cache the planner's catalog reads.
    writeFileSync(
      join(toolDir, "mcp.json"),
      JSON.stringify({
        name: "Item Tracker",
        operations: [
          { name: "find_item", description: "Find where an item is stored", access: "read", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
          { name: "save_item", description: "Record where an item is stored", access: "write", inputSchema: { type: "object", properties: { name: { type: "string" }, location: { type: "string" } }, required: ["name", "location"] } },
        ],
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    if (toolDir) rmSync(toolDir, { recursive: true, force: true });
  });

  it(
    "answers 'where is X' by calling the tool, after recording it",
    async () => {
      const save = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "Using our item tracker, record that the passport is in the bedroom safe." },
      });
      expect(save.statusCode).toBe(200);

      // The write should have gone through the tool's own backend.
      const rows = await inject({ method: "GET", url: `/tools/${toolId}/db/rows?table=items` });
      expect(rows.statusCode).toBe(200);
      expect(
        rows.json().rows.some((r: Record<string, string>) => /passport/i.test(r.name) && /safe/i.test(r.location)),
        `expected the agent to have saved the passport row, got ${JSON.stringify(rows.json().rows)}`,
      ).toBe(true);

      const ask = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "Where is the passport?" },
      });
      expect(ask.statusCode).toBe(200);
      const reply = (ask.json().reply as string).toLowerCase();
      expect(reply).toMatch(/safe/);
      expect(ask.json().references?.some((r: { type: string }) => r.type === "tool")).toBe(true);
    },
    600000,
  );

  it(
    "a leading '/' forces the tools API even for a phrasing the planner wouldn't obviously route there",
    async () => {
      // No "using our item tracker" framing this time — just "log that…"
      // (one of tools-agent's own write triggers, per TOOLS_AGENT_PROMPT),
      // with no mention of a tool by name. Left to the planner, whether this
      // reaches tools-agent at all is the unreliable part; the leading "/"
      // is what's supposed to make it deterministic.
      const save = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "/log that the good screwdriver is in the garage drawer" },
      });
      expect(save.statusCode).toBe(200);

      const rows = await inject({ method: "GET", url: `/tools/${toolId}/db/rows?table=items` });
      expect(
        rows.json().rows.some((r: Record<string, string>) => /screwdriver/i.test(r.name) && /garage/i.test(r.location)),
        `expected the forced tools path to have saved the screwdriver row, got ${JSON.stringify(rows.json().rows)}`,
      ).toBe(true);

      const ask = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "/where is the good screwdriver?" },
      });
      expect(ask.statusCode).toBe(200);
      expect((ask.json().reply as string).toLowerCase()).toMatch(/garage/);
      expect(ask.json().references?.some((r: { type: string }) => r.type === "tool")).toBe(true);
    },
    600000,
  );

  it(
    "'/build' forces the builder-agent path — a new tool starts building",
    async () => {
      // Scope note: this only proves "/" forced-routing reaches builder-
      // agent's start_build tool directly — a structural guarantee, not a
      // model-quality question — so it stops at "a new tool row appeared,
      // building" rather than waiting for generation to finish or work;
      // that's toolBuilder.test.ts's job (see the comment below).
      const before = new Set(store.listTools().map((t) => t.id));
      const res = await inject({
        method: "POST",
        url: "/chat",
        payload: { message: "/build a tool to track chore points for each family member" },
      });
      expect(res.statusCode).toBe(200);

      let created: string | undefined;
      for (let i = 0; i < 30; i++) {
        created = store.listTools().find((t) => !before.has(t.id))?.id;
        if (created) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      expect(created, `expected a new tool to start building, got ${JSON.stringify(store.listTools())}`).toBeDefined();
    },
    300000,
  );

  // The "improve an existing tool" chat path (planner → builder-agent →
  // improve_tool → startToolIterate → iterateTool) was verified by hand against
  // gemma4:26b and is exercised mechanically in test/toolBuilder.test.ts. A
  // live end-to-end assertion here is deliberately omitted: it's a 3-hop
  // delegation whose reliability is a model-quality question, not a code one.
});
