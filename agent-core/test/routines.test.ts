import { describe, it, expect, beforeEach, vi } from "vitest";
import { Store, type ScopedStore } from "../src/db.js";
import {
  parseCron,
  nextCronRun,
  parseTriggerInput,
  nextRunAt,
  describeTrigger,
  RoutineScheduler,
  type RoutineAction,
} from "../src/routines.js";

describe("cron", () => {
  it("parses the standard 5 fields with lists, ranges and steps", () => {
    const f = parseCron("0 7 * * 1-5");
    expect([...f.minute]).toEqual([0]);
    expect([...f.hour]).toEqual([7]);
    expect(f.domRestricted).toBe(false);
    expect(f.dowRestricted).toBe(true);
    expect([...f.dow].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("normalises weekday 7 to 0 (Sunday)", () => {
    expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
  });

  it("rejects a malformed expression", () => {
    expect(() => parseCron("0 7 * *")).toThrow();
    expect(() => parseCron("99 7 * * *")).toThrow();
  });

  it("nextCronRun finds the next daily occurrence in local time", () => {
    // Fri 2026-09-04 08:00 local → next "0 7 * * *" is Sat 09-05 07:00
    const after = new Date(2026, 8, 4, 8, 0, 0);
    const next = nextCronRun("0 7 * * *", after);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(8);
    expect(next.getDate()).toBe(5);
    expect(next.getHours()).toBe(7);
    expect(next.getMinutes()).toBe(0);
  });

  it("nextCronRun respects a weekday restriction", () => {
    // Sat 2026-09-05 → next "0 18 * * 0" (Sunday 18:00) is 09-06 18:00
    const next = nextCronRun("0 18 * * 0", new Date(2026, 8, 5, 12, 0, 0));
    expect(next.getDate()).toBe(6);
    expect(next.getDay()).toBe(0);
    expect(next.getHours()).toBe(18);
  });
});

describe("parseTriggerInput", () => {
  it("turns friendly fields into a canonical trigger", () => {
    expect(parseTriggerInput({ dailyAt: "07:30" })).toEqual({ kind: "cron", expr: "30 7 * * *" });
    expect(parseTriggerInput({ weeklyOn: "sunday", weeklyAt: "18:00" })).toEqual({ kind: "cron", expr: "0 18 * * 0" });
    expect(parseTriggerInput({ monthlyDay: 1, monthlyAt: "09:00" })).toEqual({ kind: "cron", expr: "0 9 1 * *" });
    expect(parseTriggerInput({ everyMinutes: 120 })).toEqual({ kind: "every", minutes: 120 });
    const once = parseTriggerInput({ onceAt: "2099-01-01T09:00" });
    expect(once.kind).toBe("once");
  });

  it("rejects an empty or nonsense schedule", () => {
    expect(() => parseTriggerInput({})).toThrow();
    expect(() => parseTriggerInput({ dailyAt: "25:00" })).toThrow();
    expect(() => parseTriggerInput({ cron: "not a cron" })).toThrow();
    expect(() => parseTriggerInput({ monthlyDay: 31 })).toThrow(); // must be 1–28
  });

  it("describeTrigger produces a readable sentence", () => {
    expect(describeTrigger({ kind: "cron", expr: "0 7 * * *" })).toMatch(/every day at/i);
    expect(describeTrigger({ kind: "every", minutes: 120 })).toBe("every 2 hours");
  });
});

describe("nextRunAt", () => {
  it("returns null for a one-shot already in the past", () => {
    expect(nextRunAt({ kind: "once", at: "2000-01-01T00:00" }, new Date())).toBeNull();
  });
  it("advances an interval trigger by its minutes", () => {
    const after = new Date(2026, 0, 1, 0, 0, 0);
    const next = nextRunAt({ kind: "every", minutes: 30 }, after)!;
    expect(next.getTime() - after.getTime()).toBe(30 * 60_000);
  });
});

describe("ScopedStore — routines", () => {
  let raw: Store;
  let alice: ScopedStore;
  let bob: ScopedStore;

  beforeEach(() => {
    raw = new Store(":memory:");
    alice = raw.scoped(raw.createUser({ username: "alice", displayName: "Alice", password: "sekret123" }).id);
    bob = raw.scoped(raw.createUser({ username: "bob", displayName: "Bob", password: "sekret123" }).id);
  });

  const action: RoutineAction = { agent: "planner", instruction: "brief me" };

  it("creates, lists, updates and deletes a routine — scoped per user", () => {
    const r = alice.createRoutine({ name: "Morning briefing", trigger: { kind: "cron", expr: "0 7 * * *" }, action });
    expect(alice.listRoutines().map((x) => x.id)).toEqual([r.id]);
    expect(bob.listRoutines()).toEqual([]);
    expect(bob.getRoutine(r.id)).toBeUndefined();

    alice.updateRoutine(r.id, { enabled: false });
    expect(alice.getRoutine(r.id)!.enabled).toBe(false);

    alice.deleteRoutine(r.id);
    expect(alice.listRoutines()).toEqual([]);
  });

  it("records run history and clears it when the routine is deleted", () => {
    const r = alice.createRoutine({ name: "R", trigger: { kind: "every", minutes: 10 }, action });
    const runId = alice.startRoutineRun(r.id, "manual");
    alice.finishRoutineRun(runId, { status: "ok", output: "done" });
    const runs = alice.listRoutineRuns(r.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "ok", output: "done", trigger: "manual" });
    alice.deleteRoutine(r.id);
    expect(alice.listRoutineRuns(r.id)).toEqual([]);
  });

  it("dueRoutineIds only returns enabled routines whose next_run_at has passed", () => {
    const past = alice.createRoutine({ name: "past", trigger: { kind: "every", minutes: 10 }, action });
    const future = alice.createRoutine({ name: "future", trigger: { kind: "every", minutes: 10 }, action });
    const off = alice.createRoutine({ name: "off", trigger: { kind: "every", minutes: 10 }, action });
    alice.setRoutineSchedule(past.id, { nextRunAt: "2020-01-01T00:00:00.000Z" });
    alice.setRoutineSchedule(future.id, { nextRunAt: "2099-01-01T00:00:00.000Z" });
    alice.setRoutineSchedule(off.id, { nextRunAt: "2020-01-01T00:00:00.000Z", enabled: false });
    const due = raw.dueRoutineIds(new Date().toISOString()).map((d) => d.id);
    expect(due).toEqual([past.id]);
  });
});

describe("RoutineScheduler", () => {
  let raw: Store;
  let alice: ScopedStore;
  let userId: string;

  beforeEach(() => {
    raw = new Store(":memory:");
    const u = raw.createUser({ username: "alice", displayName: "Alice", password: "sekret123" });
    userId = u.id;
    alice = raw.scoped(u.id);
  });

  const makeScheduler = (runAction: (u: string, a: RoutineAction) => Promise<string>, now: () => Date) =>
    new RoutineScheduler(raw, { runAction, now, tickMs: 999_999, catchUpGraceMs: 60 * 60_000, log: () => {} });

  it("reconcile() fills in a missing next_run_at", () => {
    const r = alice.createRoutine({ name: "R", trigger: { kind: "cron", expr: "0 7 * * *" }, action: { agent: "planner", instruction: "x" } });
    expect(alice.getRoutine(r.id)!.nextRunAt).toBeNull();
    const sched = makeScheduler(async () => "ok", () => new Date(2026, 8, 4, 8, 0, 0));
    sched.start();
    sched.stop();
    const next = new Date(alice.getRoutine(r.id)!.nextRunAt!);
    expect(next.getDate()).toBe(5);
    expect(next.getHours()).toBe(7);
  });

  it("runNow() executes the action, records a run, and advances nothing for a manual run", async () => {
    const r = alice.createRoutine({ name: "R", trigger: { kind: "every", minutes: 60 }, action: { agent: "task", instruction: "list tasks" } });
    const runAction = vi.fn(async () => "here are your tasks");
    const sched = makeScheduler(runAction, () => new Date());
    const result = await sched.runNow(userId, r.id);
    expect(result.status).toBe("ok");
    expect(result.output).toBe("here are your tasks");
    expect(runAction).toHaveBeenCalledWith(userId, { agent: "task", instruction: "list tasks" });
    const runs = alice.listRoutineRuns(r.id);
    expect(runs[0]).toMatchObject({ status: "ok", trigger: "manual" });
    expect(alice.getRoutine(r.id)!.lastStatus).toBe("ok");
  });

  it("records an error run when the action throws", async () => {
    const r = alice.createRoutine({ name: "R", trigger: { kind: "every", minutes: 60 }, action: { agent: "planner", instruction: "x" } });
    const sched = makeScheduler(async () => {
      throw new Error("model unreachable");
    }, () => new Date());
    const result = await sched.runNow(userId, r.id);
    expect(result.status).toBe("error");
    expect(alice.listRoutineRuns(r.id)[0]).toMatchObject({ status: "error", error: "model unreachable" });
    expect(alice.getRoutine(r.id)!.lastStatus).toBe("error");
  });

  it("a spent one-shot is disabled after it runs", async () => {
    const nowRef = { d: new Date(2026, 8, 4, 8, 0, 0) };
    const r = alice.createRoutine({
      name: "call plumber",
      trigger: { kind: "once", at: "2026-09-04T08:30:00" },
      action: { agent: "planner", instruction: "remind" },
    });
    alice.setRoutineSchedule(r.id, { nextRunAt: new Date(2026, 8, 4, 8, 30, 0).toISOString() });
    const sched = makeScheduler(async () => "reminded", () => nowRef.d);
    nowRef.d = new Date(2026, 8, 4, 8, 31, 0);
    // drive one tick manually
    await (sched as unknown as { tick: () => Promise<void> }).tick();
    const after = alice.getRoutine(r.id)!;
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
    expect(alice.listRoutineRuns(r.id)[0].status).toBe("ok");
  });

  it("delivers output to a family channel the user belongs to", async () => {
    const bob = raw.createUser({ username: "bob", displayName: "Bob", password: "sekret123" });
    const channel = raw.findOrCreateDm(userId, bob.id);
    const r = alice.createRoutine({
      name: "Briefing",
      trigger: { kind: "every", minutes: 60 },
      action: { agent: "planner", instruction: "x" },
      deliverChannelId: channel.id,
    });
    const sched = makeScheduler(async () => "today: dentist 3pm", () => new Date());
    await sched.runNow(userId, r.id);
    const msgs = raw.listMessages(channel.id, userId);
    expect(msgs.at(-1)!.body).toContain("today: dentist 3pm");
    expect(msgs.at(-1)!.senderId).toBe("_agent_");
  });

  it("a disabled routine that comes due is skipped, not run", async () => {
    const r = alice.createRoutine({ name: "R", trigger: { kind: "every", minutes: 10 }, action: { agent: "planner", instruction: "x" } });
    alice.setRoutineSchedule(r.id, { nextRunAt: "2020-01-01T00:00:00.000Z", enabled: false });
    const runAction = vi.fn(async () => "ran");
    const sched = makeScheduler(runAction, () => new Date());
    await (sched as unknown as { tick: () => Promise<void> }).tick();
    expect(runAction).not.toHaveBeenCalled();
  });
});
