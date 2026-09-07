import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ScopedStore } from "../db.js";
import {
  parseTriggerInput,
  describeTrigger,
  nextRunAt,
  type RoutineAgentKind,
} from "../routines.js";

// Tools for the "routine-agent" subagent (and the "/schedule" forced turn):
// create, list, and delete scheduled routines from natural language. Bound to
// one user's ScopedStore, like every other agent tool.
//
// The model is given FRIENDLY schedule fields (dailyAt / weeklyOn / onceAt / …)
// rather than raw cron — a small model writes "0 7 * * *" unreliably but fills
// "dailyAt: 07:00" fine. parseTriggerInput() turns them into the canonical
// trigger and validates.

const ACTION_AGENTS: RoutineAgentKind[] = ["planner", "task", "document", "notes", "tools", "research", "connect"];

export function makeRoutineTools(store: ScopedStore, now: () => Date = () => new Date()) {
  const currentDatetime = tool(
    async () => {
      const d = now();
      return (
        `Right now it is ${d.toLocaleString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}.\nISO: ${d.toISOString()}\n` +
        `Use this to work out an "onceAt" datetime for phrases like "tomorrow at 9" or "in 2 hours".`
      );
    },
    {
      name: "current_datetime",
      description:
        "Get the current date and time. Call this first whenever the user's schedule is relative ('tomorrow', 'tonight', 'in an hour', 'next Monday') so you can compute an absolute onceAt.",
      schema: z.object({}),
    }
  );

  const createRoutine = tool(
    async (input) => {
      let trigger;
      try {
        trigger = parseTriggerInput({
          cron: input.cron,
          dailyAt: input.dailyAt,
          weeklyOn: input.weeklyOn,
          weeklyAt: input.weeklyAt,
          monthlyDay: input.monthlyDay,
          monthlyAt: input.monthlyAt,
          onceAt: input.onceAt,
          everyMinutes: input.everyMinutes,
        });
      } catch (err) {
        return `Could not set that schedule: ${(err as Error).message}. Ask the user to clarify the timing.`;
      }
      const agent = (input.agent ?? "planner") as RoutineAgentKind;
      if (!ACTION_AGENTS.includes(agent)) {
        return `"${agent}" is not a valid agent. Use one of: ${ACTION_AGENTS.join(", ")}.`;
      }
      const rec = store.createRoutine({
        name: input.name,
        trigger,
        action: { agent, instruction: input.instruction },
      });
      const next = (() => {
        try {
          const n = nextRunAt(trigger, now());
          return n ? n.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
        } catch {
          return "—";
        }
      })();
      return `Created routine "${rec.name}" — runs ${describeTrigger(trigger)} (next: ${next}). It will ${
        agent === "planner" ? "run the assistant" : `use the ${agent} agent`
      } with: "${input.instruction}". Results show on the Routines screen.`;
    },
    {
      name: "create_routine",
      description:
        "Schedule a routine: an instruction that runs automatically on a schedule. Give it a short name, exactly ONE schedule field, the agent to run it, and the instruction. Examples of schedule fields: dailyAt '07:00'; weeklyOn 'sunday' + weeklyAt '18:00'; monthlyDay 1 + monthlyAt '09:00'; onceAt '2026-09-08T09:00'; everyMinutes 120; cron '0 7 * * *'.",
      schema: z.object({
        name: z.string().min(1).describe("Short name, e.g. 'Morning briefing'"),
        instruction: z
          .string()
          .min(1)
          .describe("What the agent should do each run, e.g. 'Summarise today's events, overdue tasks, and any bills due this week.'"),
        agent: z
          .enum(["planner", "task", "document", "notes", "tools", "research", "connect"])
          .optional()
          .describe("Which agent runs the instruction. 'planner' (default) is the full assistant. 'research' searches the web (weather/news briefings). 'connect' uses a connected external service (MCP). Never 'builder'."),
        dailyAt: z.string().optional().describe("'HH:MM' — every day at this time"),
        weeklyOn: z.string().optional().describe("Weekday name — every week on this day (pair with weeklyAt)"),
        weeklyAt: z.string().optional().describe("'HH:MM' for weeklyOn (default 09:00)"),
        monthlyDay: z.number().int().optional().describe("1–28 — every month on this day (pair with monthlyAt)"),
        monthlyAt: z.string().optional().describe("'HH:MM' for monthlyDay (default 09:00)"),
        onceAt: z.string().optional().describe("Local ISO datetime — run one time only"),
        everyMinutes: z.number().int().optional().describe("Plain interval in minutes"),
        cron: z.string().optional().describe("A 5-field cron expression, if the user gave one"),
      }),
    }
  );

  const listRoutines = tool(
    async () => {
      const routines = store.listRoutines();
      if (routines.length === 0) return "No routines scheduled yet.";
      return routines
        .map((r) => {
          const last = r.lastRunAt ? `, last ran ${new Date(r.lastRunAt).toLocaleString()} (${r.lastStatus})` : "";
          return `- "${r.name}" (id: ${r.id}) — ${r.enabled ? "on" : "off"}, ${describeTrigger(r.trigger)}${last}. Action: ${r.action.agent} — "${r.action.instruction}"`;
        })
        .join("\n");
    },
    {
      name: "list_routines",
      description: "List every scheduled routine — its name, id, schedule, on/off state, and last run.",
      schema: z.object({}),
    }
  );

  const deleteRoutine = tool(
    async ({ id }) => {
      const removed = store.deleteRoutine(id);
      return removed ? `Deleted routine "${removed.name}".` : `No routine with id "${id}".`;
    },
    {
      name: "delete_routine",
      description: "Delete a routine by its id. Call list_routines first to get the id.",
      schema: z.object({ id: z.string().min(1) }),
    }
  );

  const setRoutineEnabled = tool(
    async ({ id, enabled }) => {
      const updated = store.updateRoutine(id, { enabled });
      return updated
        ? `Routine "${updated.name}" is now ${enabled ? "on" : "off"}.`
        : `No routine with id "${id}".`;
    },
    {
      name: "set_routine_enabled",
      description: "Turn a routine on or off by its id (pause it without deleting).",
      schema: z.object({ id: z.string().min(1), enabled: z.boolean() }),
    }
  );

  return [currentDatetime, createRoutine, listRoutines, deleteRoutine, setRoutineEnabled];
}
