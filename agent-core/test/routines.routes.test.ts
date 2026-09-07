import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { Store } from "../src/db.js";
import { seedUser, authInject, type SeededUser } from "./helpers.js";

// HTTP contract for /routines. No live model — POST /routines/:id/run drives the
// scheduler with a stubbed action via app.routineScheduler internals is covered
// in routines.test.ts; here we cover CRUD, validation and scoping.
describe("HTTP API — /routines", () => {
  let app: FastifyInstance;
  let store: Store;
  let alice: SeededUser;
  let bob: SeededUser;
  let inject: ReturnType<typeof authInject>;

  beforeEach(() => {
    store = new Store(":memory:");
    app = buildServer(store);
    alice = seedUser(store, { username: "alice", role: "admin" });
    bob = seedUser(store, { username: "bob", role: "member" });
    inject = authInject(app, alice.token);
  });

  afterEach(async () => {
    await app.close();
  });

  const create = (body: unknown, token = alice.token) =>
    authInject(app, token)({ method: "POST", url: "/routines", payload: body });

  it("creates a daily routine and computes its next run", async () => {
    const res = await create({
      name: "Morning briefing",
      trigger: { dailyAt: "07:00" },
      action: { agent: "planner", instruction: "Summarise the day." },
    });
    expect(res.statusCode).toBe(201);
    const { routine } = res.json();
    expect(routine.name).toBe("Morning briefing");
    expect(routine.trigger).toEqual({ kind: "cron", expr: "0 7 * * *" });
    expect(routine.triggerText).toMatch(/every day at/i);
    expect(routine.enabled).toBe(true);
    expect(typeof routine.nextRunAt).toBe("string");
    expect(new Date(routine.nextRunAt).getHours()).toBe(7);
  });

  it("rejects an invalid schedule and a past one-shot", async () => {
    expect((await create({ name: "x", trigger: {}, action: { instruction: "hi" } })).statusCode).toBe(400);
    expect(
      (await create({ name: "x", trigger: { dailyAt: "99:99" }, action: { instruction: "hi" } })).statusCode
    ).toBe(400);
    const past = await create({
      name: "x",
      trigger: { onceAt: "2000-01-01T09:00" },
      action: { instruction: "hi" },
    });
    expect(past.statusCode).toBe(400);
    expect(past.json().error).toMatch(/past/i);
  });

  it("rejects builder as an action agent", async () => {
    const res = await create({
      name: "x",
      trigger: { dailyAt: "07:00" },
      action: { agent: "builder", instruction: "make a thing" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("lists, patches (pause) and deletes a routine", async () => {
    const id = (await create({ name: "R", trigger: { everyMinutes: 60 }, action: { instruction: "x" } })).json()
      .routine.id;

    let list = (await inject("/routines")).json().routines;
    expect(list).toHaveLength(1);

    const patched = await inject({ method: "PATCH", url: `/routines/${id}`, payload: { enabled: false } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().routine.enabled).toBe(false);
    expect(patched.json().routine.nextRunAt).toBeNull();

    const del = await inject({ method: "DELETE", url: `/routines/${id}` });
    expect(del.statusCode).toBe(200);
    expect((await inject("/routines")).json().routines).toEqual([]);
  });

  it("changing the trigger reschedules the next run", async () => {
    const id = (await create({ name: "R", trigger: { dailyAt: "07:00" }, action: { instruction: "x" } })).json()
      .routine.id;
    const res = await inject({
      method: "PATCH",
      url: `/routines/${id}`,
      payload: { trigger: { dailyAt: "20:30" } },
    });
    expect(res.json().routine.trigger).toEqual({ kind: "cron", expr: "30 20 * * *" });
    expect(new Date(res.json().routine.nextRunAt).getHours()).toBe(20);
  });

  it("routines are per-user — bob cannot see or touch alice's", async () => {
    const id = (await create({ name: "R", trigger: { everyMinutes: 60 }, action: { instruction: "x" } })).json()
      .routine.id;
    const bobInject = authInject(app, bob.token);
    expect((await bobInject("/routines")).json().routines).toEqual([]);
    expect((await bobInject(`/routines/${id}`)).statusCode).toBe(404);
    expect((await bobInject({ method: "DELETE", url: `/routines/${id}` })).statusCode).toBe(404);
  });

  it("GET /routines/:id returns the routine plus its run history", async () => {
    const id = (await create({ name: "R", trigger: { everyMinutes: 60 }, action: { instruction: "x" } })).json()
      .routine.id;
    const res = await inject(`/routines/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().routine.id).toBe(id);
    expect(res.json().runs).toEqual([]);
  });

  it("POST /routines/:id/run executes via the scheduler and records a run", async () => {
    const id = (await create({ name: "R", trigger: { everyMinutes: 60 }, action: { agent: "task", instruction: "list" } })).json()
      .routine.id;
    // Stub the scheduler's action so no model is needed.
    (app.routineScheduler as unknown as { opts: { runAction: unknown } }).opts.runAction = async () => "stub output";
    const res = await inject({ method: "POST", url: `/routines/${id}/run` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    expect(res.json().output).toBe("stub output");
    expect(res.json().run.trigger).toBe("manual");
  });

  it("/health advertises routinesEnabled", async () => {
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(body.routinesEnabled).toBe(true);
  });
});
