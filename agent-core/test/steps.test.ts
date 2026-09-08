import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { StepRecorder } from "../src/agents/steps.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// The recorder is a LangChain callback handler; here we drive its callbacks
// directly (no model) and check the shape the chat UI consumes.
describe("StepRecorder", () => {
  it("captures a tool call start → end with parsed input and clamped output", () => {
    const updates: number[] = [];
    const rec = new StepRecorder((steps) => updates.push(steps.length));
    rec.handleToolStart({ name: "run_code" } as any, '{"code":"1+1"}', "run-1");
    expect(rec.steps).toHaveLength(1);
    expect(rec.steps[0]).toMatchObject({ tool: "run_code", phase: "running", input: { code: "1+1" } });

    rec.handleToolEnd({ kwargs: { content: "result: 2" } }, "run-1");
    expect(rec.steps[0].phase).toBe("done");
    expect(rec.steps[0].output).toBe("result: 2");
    expect(rec.steps[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(updates.length).toBeGreaterThanOrEqual(2); // start + end fired onUpdate
  });

  it("labels a `task` delegation with its subagent", () => {
    const rec = new StepRecorder();
    rec.handleToolStart(
      { name: "task" } as any,
      { description: "Count the tasks", subagent_type: "task-agent" } as any,
      "run-2"
    );
    expect(rec.steps[0]).toMatchObject({ tool: "task", subagent: "task-agent" });
  });

  it("records a tool error", () => {
    const rec = new StepRecorder();
    rec.handleToolStart({ name: "open_page" } as any, '{"url":"x"}', "run-3");
    rec.handleToolError(new Error("blocked host"), "run-3");
    expect(rec.steps[0]).toMatchObject({ phase: "error", error: "blocked host" });
  });

  it("reset() clears the list (used between retries)", () => {
    const rec = new StepRecorder();
    rec.handleToolStart({ name: "a" } as any, "{}", "r1");
    rec.reset();
    expect(rec.steps).toHaveLength(0);
  });
});

describe("HTTP API — GET /chat/turns/:turnId", () => {
  let app: FastifyInstance;
  let store: Store;
  let alice: SeededUser;
  let bob: SeededUser;

  beforeEach(() => {
    store = new Store(":memory:");
    app = buildServer(store);
    alice = seedUser(store, { username: "alice" });
    bob = seedUser(store, { username: "bob", role: "member" });
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("404s an unknown turn id", async () => {
    const res = await authInject(app, alice.token)("/chat/turns/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json().steps).toEqual([]);
    expect(res.json().done).toBe(true);
  });

  it("exposes the live steps of an in-flight /chat turn, scoped to its user", async () => {
    // Stub the agent so /chat runs fast but still feeds the recorder a step.
    const idx = await import("../src/agents/index.js");
    vi.spyOn(idx, "askFamilyAgent").mockImplementation(async (_agent, _msg, _imgs, _hist, recorder) => {
      recorder?.handleToolStart({ name: "list_tasks" } as any, '{"status":"open"}', "run-x");
      const mid = await authInject(app, alice.token)("/chat/turns/turn-abc").then((r) => r.json());
      expect(mid.done).toBe(false);
      expect(mid.steps[0]).toMatchObject({ tool: "list_tasks", phase: "running" });
      // another user can't read it
      const other = await authInject(app, bob.token)("/chat/turns/turn-abc");
      expect(other.statusCode).toBe(404);
      recorder?.handleToolEnd({ content: "- [open] buy milk" }, "run-x");
      return "You have 1 open task.";
    });

    const res = await authInject(app, alice.token)({
      method: "POST",
      url: "/chat",
      payload: { message: "how many open tasks?", turnId: "turn-abc" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reply).toBe("You have 1 open task.");
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]).toMatchObject({ tool: "list_tasks", phase: "done", output: "- [open] buy milk" });

    // Persisted on the assistant message for replay.
    const msgs = await authInject(app, alice.token)(`/chat/sessions/${body.sessionId}/messages`).then((r) =>
      r.json()
    );
    expect(msgs.messages.at(-1).steps[0].tool).toBe("list_tasks");

    // The turn is now marked done.
    const after = await authInject(app, alice.token)("/chat/turns/turn-abc").then((r) => r.json());
    expect(after.done).toBe(true);
  });
});
