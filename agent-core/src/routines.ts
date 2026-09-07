// Scheduled routines ("cron for the family agent").
//
// A routine is a per-user object with three parts:
//   - a TRIGGER  — when it fires (a recurring time, a one-shot time, or a plain interval)
//   - an ACTION  — what runs (the full planner, or one specialist agent) with an instruction
//   - a DELIVERY — where the result goes (always a routine_runs row + activity line;
//                  optionally also posted into a family chat channel as @agent)
//
// The model is slow (a planner turn can take ~110s on CPU — see docs/DECISIONS.md),
// the host is a laptop that sleeps, and an unattended agent turn should never be
// able to do something a chat message couldn't. So: runs are serialized through a
// single queue, missed triggers have an explicit catch-up policy, and the action
// can pick any specialist EXCEPT builder-agent (a routine never generates or
// rewrites code unattended).
//
// This module is pure scheduling logic + the runner loop. The DB shape lives in
// db.ts (routines / routine_runs), the HTTP surface and the agent wiring in
// server.ts, and the natural-language authoring tool in agents/routineTools.ts.

import type { Store } from "./db.js";
import { AGENT_SENDER_ID } from "./db.js";

// ---- trigger model ----

export type RoutineTrigger =
  | { kind: "cron"; expr: string }
  /** A single future run. `at` is a local ISO datetime ("2026-09-07T15:00"). */
  | { kind: "once"; at: string }
  /** A plain fixed interval, anchored at creation. Handy for "every 30 minutes". */
  | { kind: "every"; minutes: number };

export type RoutineAgentKind = "planner" | "task" | "document" | "notes" | "tools" | "research";

export interface RoutineAction {
  /** Which agent runs the instruction. "planner" is the full assistant; the
   *  others are the single matching specialist. "builder" and "workshop" are
   *  deliberately not options — a routine never writes code or processes files
   *  unattended. "research" is allowed when web access is on (weather/news
   *  briefings). */
  agent: RoutineAgentKind;
  /** What to tell it to do, in plain language. */
  instruction: string;
}

/** How to treat a trigger that came due while the process was down. */
export type CatchUpPolicy = "skip" | "run";

export type RoutineRunTrigger = "schedule" | "manual" | "catchup";
export type RoutineRunStatus = "running" | "ok" | "error" | "skipped";

// ---- cron ----
// Standard 5-field cron: minute hour day-of-month month day-of-week.
// Supports  *  a  a-b  a,b,c  */n  a-b/n . Day-of-week: 0 or 7 = Sunday.
// When BOTH day-of-month and day-of-week are restricted, a date matching
// EITHER fires (the usual Vixie-cron rule).

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(raw: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo = min;
    let hi = max;
    if (rangePart !== "*") {
      const bounds = rangePart.split("-");
      if (bounds.length === 1) {
        lo = hi = Number(bounds[0]);
      } else if (bounds.length === 2) {
        lo = Number(bounds[0]);
        hi = Number(bounds[1]);
      } else {
        throw new Error(`bad range "${rangePart}"`);
      }
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`"${part}" out of ${min}-${max}`);
    }
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("a cron expression has 5 fields (minute hour day month weekday)");
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  let dow = parseField(parts[4], 0, 7);
  // Normalise 7 → 0 (both mean Sunday).
  if (dow.has(7)) {
    dow = new Set([...dow].map((d) => (d === 7 ? 0 : d)));
  }
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function cronMatches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

/** Next time (strictly after `after`) that `expr` fires, in local time.
 *  Throws if nothing matches within ~14 months (a nonsense expression). */
export function nextCronRun(expr: string, after: Date): Date {
  const f = parseCron(expr);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = 60 * 24 * 425; // minutes in ~14 months — covers every real schedule
  for (let i = 0; i < limit; i++) {
    if (cronMatches(f, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`cron expression "${expr}" has no run in the next 14 months`);
}

// ---- friendly trigger construction ----
// Clients and the NL authoring tool pass friendly fields; this turns them into
// one canonical RoutineTrigger (or throws with a message worth showing a user).

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseHhMm(s: string): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!match) throw new Error(`time must look like "07:30", got "${s}"`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) throw new Error(`"${s}" is not a valid 24-hour time`);
  return { h, m };
}

export interface TriggerInput {
  cron?: string;
  /** "HH:MM" — every day at this time. */
  dailyAt?: string;
  /** Weekday name ("sun".."sat" or "sunday"…) — every week on this day. Pair with weeklyAt. */
  weeklyOn?: string;
  weeklyAt?: string;
  /** 1–31 — every month on this day-of-month. Pair with monthlyAt. */
  monthlyDay?: number;
  monthlyAt?: string;
  /** Local ISO datetime — run once. */
  onceAt?: string;
  /** Plain interval in minutes. */
  everyMinutes?: number;
}

export function parseTriggerInput(input: TriggerInput): RoutineTrigger {
  const given = Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (given.length === 0) throw new Error("no schedule given");

  if (input.cron !== undefined) {
    nextCronRun(input.cron, new Date()); // validate now, with a clear message
    return { kind: "cron", expr: input.cron.trim().replace(/\s+/g, " ") };
  }
  if (input.dailyAt !== undefined) {
    const { h, m } = parseHhMm(input.dailyAt);
    return { kind: "cron", expr: `${m} ${h} * * *` };
  }
  if (input.weeklyOn !== undefined) {
    const key = input.weeklyOn.trim().toLowerCase().slice(0, 3);
    const dow = WEEKDAYS.indexOf(key);
    if (dow === -1) throw new Error(`"${input.weeklyOn}" is not a weekday`);
    const { h, m } = parseHhMm(input.weeklyAt ?? "09:00");
    return { kind: "cron", expr: `${m} ${h} * * ${dow}` };
  }
  if (input.monthlyDay !== undefined) {
    const day = Number(input.monthlyDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      throw new Error("monthlyDay must be 1–28 (so it exists in every month)");
    }
    const { h, m } = parseHhMm(input.monthlyAt ?? "09:00");
    return { kind: "cron", expr: `${m} ${h} ${day} * *` };
  }
  if (input.onceAt !== undefined) {
    const when = new Date(input.onceAt);
    if (Number.isNaN(when.getTime())) throw new Error(`"${input.onceAt}" is not a valid date/time`);
    return { kind: "once", at: input.onceAt };
  }
  if (input.everyMinutes !== undefined) {
    const n = Number(input.everyMinutes);
    if (!Number.isInteger(n) || n < 1 || n > 60 * 24 * 30) throw new Error("everyMinutes must be 1 … 43200");
    return { kind: "every", minutes: n };
  }
  throw new Error("no recognised schedule field");
}

/** Next fire time strictly after `after`, or null when the trigger is spent
 *  (a "once" whose time has passed and which we're not catching up). */
export function nextRunAt(trigger: RoutineTrigger, after: Date): Date | null {
  switch (trigger.kind) {
    case "cron":
      return nextCronRun(trigger.expr, after);
    case "every": {
      const d = new Date(after.getTime());
      d.setSeconds(0, 0);
      d.setMinutes(d.getMinutes() + trigger.minutes);
      return d;
    }
    case "once": {
      const when = new Date(trigger.at);
      return when.getTime() > after.getTime() ? when : null;
    }
  }
}

const HHMM = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A human sentence for a trigger — shown in the UI and echoed by the agent. */
export function describeTrigger(trigger: RoutineTrigger): string {
  if (trigger.kind === "once") {
    const d = new Date(trigger.at);
    return `once, on ${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${HHMM.format(d)}`;
  }
  if (trigger.kind === "every") {
    const n = trigger.minutes;
    if (n % 60 === 0) return `every ${n / 60} hour${n === 60 ? "" : "s"}`;
    return `every ${n} minute${n === 1 ? "" : "s"}`;
  }
  try {
    const f = parseCron(trigger.expr);
    const time = () => {
      const h = [...f.hour][0];
      const m = [...f.minute][0];
      const d = new Date();
      d.setHours(h, m, 0, 0);
      return HHMM.format(d);
    };
    const single = (s: Set<number>) => s.size === 1;
    if (single(f.minute) && single(f.hour)) {
      if (f.dowRestricted && !f.domRestricted) {
        const days = [...f.dow].map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]).join(", ");
        return `every ${days} at ${time()}`;
      }
      if (f.domRestricted && !f.dowRestricted) {
        return `on day ${[...f.dom].join(", ")} of the month at ${time()}`;
      }
      if (!f.domRestricted && !f.dowRestricted) return `every day at ${time()}`;
    }
  } catch {
    /* fall through to the raw expression */
  }
  return `cron: ${trigger.expr}`;
}

// ---- the scheduler ----

export interface RoutineRunResult {
  runId: string;
  status: RoutineRunStatus;
  output?: string;
  error?: string;
}

export interface RoutineSchedulerOptions {
  /** Run one routine's action and return its text output. Provided by server.ts,
   *  where the per-user agent caches live. May take a long time. */
  runAction: (userId: string, action: RoutineAction) => Promise<string>;
  /** ms between due-checks. Default 60s. */
  tickMs?: number;
  /** A trigger that came due more than this long ago is too stale to catch up
   *  on — it's skipped forward instead. Default 6h. */
  catchUpGraceMs?: number;
  /** Injectable clock, for tests. */
  now?: () => Date;
  /** Optional log sink; defaults to console. */
  log?: (msg: string) => void;
}

interface QueuedJob {
  userId: string;
  routineId: string;
  trigger: RoutineRunTrigger;
  /** Resolved when this job finishes (for POST /routines/:id/run callers who wait). */
  resolve?: (r: RoutineRunResult) => void;
}

export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: QueuedJob[] = [];
  private draining = false;
  private stopped = false;
  private readonly tickMs: number;
  private readonly graceMs: number;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(
    private store: Store,
    private opts: RoutineSchedulerOptions
  ) {
    this.tickMs = opts.tickMs ?? 60_000;
    this.graceMs = opts.catchUpGraceMs ?? 6 * 60 * 60_000;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((m) => console.log(`[routines] ${m}`));
  }

  /** Compute any missing next_run_at, apply the catch-up policy for triggers that
   *  fired while we were down, then start the tick loop. */
  start(): void {
    this.stopped = false;
    this.reconcile();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Enqueue a routine to run as soon as the queue drains to it. Resolves with
   *  the run result. Used by POST /routines/:id/run. */
  runNow(userId: string, routineId: string): Promise<RoutineRunResult> {
    return new Promise((resolve) => {
      this.queue.push({ userId, routineId, trigger: "manual", resolve });
      void this.drain();
    });
  }

  private reconcile(): void {
    const nowMs = this.now().getTime();
    for (const { id, userId } of this.store.allEnabledRoutineIds()) {
      const scoped = this.store.scoped(userId);
      const routine = scoped.getRoutine(id);
      if (!routine) continue;
      const due = routine.nextRunAt ? new Date(routine.nextRunAt).getTime() : null;

      if (due === null) {
        // No next time yet (freshly created before the scheduler was running,
        // or a legacy row). Compute it.
        this.advanceSchedule(userId, id, "reconcile");
        continue;
      }
      if (due <= nowMs) {
        const missedByMs = nowMs - due;
        const fresh = missedByMs <= this.graceMs;
        if (routine.trigger.kind === "once") {
          // A one-shot: run it late if it's still fresh, otherwise let it go.
          if (fresh) {
            this.advanceSchedule(userId, id, "reconcile"); // clears next_run_at
            this.queue.push({ userId, routineId: id, trigger: "catchup" });
          } else {
            scoped.setRoutineSchedule(id, { nextRunAt: null, enabled: false, lastStatus: "skipped" });
            this.log(`"${routine.name}" missed its one-time run by too much — disabled`);
          }
        } else if (routine.catchUp === "run" && fresh) {
          this.queue.push({ userId, routineId: id, trigger: "catchup" });
          this.advanceSchedule(userId, id, "reconcile");
        } else {
          // Skip the missed occurrence(s); resume on the next one.
          this.advanceSchedule(userId, id, "reconcile");
        }
      }
    }
    if (this.queue.length) void this.drain();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const nowIso = this.now().toISOString();
    for (const { id, userId } of this.store.dueRoutineIds(nowIso)) {
      // Advance the schedule up front so a slow run can't cause an immediate
      // re-fire, and a crash mid-run still moves the clock forward.
      this.advanceSchedule(userId, id, "tick");
      this.queue.push({ userId, routineId: id, trigger: "schedule" });
    }
    await this.drain();
  }

  /** Recompute and persist next_run_at from `now`. A spent "once" just loses its
   *  next time here — it's disabled by execute() once the run itself completes,
   *  so a job already queued for it isn't skipped as "disabled". */
  private advanceSchedule(userId: string, routineId: string, _reason: string): void {
    const scoped = this.store.scoped(userId);
    const routine = scoped.getRoutine(routineId);
    if (!routine) return;
    let next: Date | null = null;
    try {
      next = nextRunAt(routine.trigger, this.now());
    } catch (err) {
      this.log(`"${routine.name}" has an unschedulable trigger (${(err as Error).message}) — disabling`);
      scoped.setRoutineSchedule(routineId, { nextRunAt: null, enabled: false });
      return;
    }
    scoped.setRoutineSchedule(routineId, { nextRunAt: next ? next.toISOString() : null });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        const result = await this.execute(job);
        job.resolve?.(result);
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(job: QueuedJob): Promise<RoutineRunResult> {
    const scoped = this.store.scoped(job.userId);
    const routine = scoped.getRoutine(job.routineId);
    if (!routine) return { runId: "", status: "skipped", error: "routine no longer exists" };
    // A schedule/ catch-up job for a routine the user disabled in the meantime
    // is a no-op; a manual "run now" always runs.
    if (!routine.enabled && job.trigger !== "manual") {
      return { runId: "", status: "skipped", error: "routine disabled" };
    }

    const runId = scoped.startRoutineRun(routine.id, job.trigger);
    this.log(`running "${routine.name}" (${job.trigger})`);
    try {
      const output = (await this.opts.runAction(job.userId, routine.action)).trim();
      scoped.finishRoutineRun(runId, { status: "ok", output });
      scoped.setRoutineSchedule(routine.id, {
        lastRunAt: this.now().toISOString(),
        lastStatus: "ok",
        // A one-shot is spent once it has run.
        ...(routine.trigger.kind === "once" ? { enabled: false, nextRunAt: null } : {}),
      });
      scoped.logActivity("routine", "routine.ran", `Ran routine "${routine.name}"`);
      this.deliver(job.userId, routine.id, routine.name, routine.deliverChannelId, output);
      return { runId, status: "ok", output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scoped.finishRoutineRun(runId, { status: "error", error: message });
      scoped.setRoutineSchedule(routine.id, {
        lastRunAt: this.now().toISOString(),
        lastStatus: "error",
        ...(routine.trigger.kind === "once" ? { enabled: false, nextRunAt: null } : {}),
      });
      scoped.logActivity("routine", "routine.failed", `Routine "${routine.name}" failed: ${message}`);
      this.log(`"${routine.name}" failed: ${message}`);
      return { runId, status: "error", error: message };
    }
  }

  private deliver(
    userId: string,
    routineId: string,
    routineName: string,
    channelId: string | null,
    output: string
  ): void {
    if (!channelId || !output) return;
    if (!this.store.isChannelMember(channelId, userId)) return;
    try {
      this.store.postMessage(channelId, AGENT_SENDER_ID, `⏰ ${routineName}\n\n${output}`);
    } catch (err) {
      this.log(`could not deliver "${routineName}" to a channel: ${(err as Error).message}`);
    }
  }
}
