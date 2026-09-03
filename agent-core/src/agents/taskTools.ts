import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ScopedStore } from "../db.js";
import type { OnReference } from "./references.js";

// Bound to one user's ScopedStore — the planner builds a fresh agent per
// authenticated user (see agents/index.ts), so these tools only ever touch
// that user's tasks. `onReference` (when given) is notified of each task this
// turn touched, so /chat can return clickable references.
export function makeTaskTools(store: ScopedStore, onReference?: OnReference) {
  const createTask = tool(
    async ({ title, notes, dueDate, dueTime }) => {
      const rec = store.createTask({ title, notes, dueDate, dueTime });
      onReference?.({ type: "task", id: rec.id });
      const when = rec.dueDate ? ` (due ${rec.dueDate}${rec.dueTime ? ` ${rec.dueTime}` : ""})` : "";
      return `Created task ${rec.id}: "${rec.title}"${when}.`;
    },
    {
      name: "create_task",
      description:
        "Create a new family to-do item. Use for anything the user wants tracked or reminded about.",
      schema: z.object({
        title: z.string().describe("Short, human-readable task title"),
        notes: z.string().optional().describe("Extra context or detail"),
        dueDate: z
          .string()
          .optional()
          .describe("ISO 8601 date (YYYY-MM-DD) if the task has a deadline"),
        dueTime: z
          .string()
          .optional()
          .describe("24-hour time HH:MM if a specific time of day was mentioned; needs dueDate too"),
      }),
    }
  );

  const listTasks = tool(
    async ({ status }) => {
      const tasks = store.listTasks(status);
      if (tasks.length === 0) return "No tasks found.";
      return tasks
        .map((t) => {
          const when = t.dueDate ? ` (due ${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ""})` : "";
          return `- [${t.status}] ${t.title}${when} (id: ${t.id})`;
        })
        .join("\n");
    },
    {
      name: "list_tasks",
      description: "List existing family tasks, optionally filtered by status.",
      schema: z.object({
        status: z.enum(["open", "done"]).optional(),
      }),
    }
  );

  const searchTasks = tool(
    async ({ query, status }) => {
      const hits = store.searchTasks(query ?? "", { status, limit: 10 });
      const label = [query?.trim(), status].filter(Boolean).join(" ") || "(all)";
      store.logActivity(
        "task-agent",
        "task.searched",
        `Searched tasks for "${label}" — ${hits.length} match${hits.length === 1 ? "" : "es"}`
      );
      if (hits.length === 0) return query?.trim() ? `No tasks matched "${query}".` : "No tasks found.";
      for (const h of hits) onReference?.({ type: "task", id: h.id });
      return hits
        .map((t) => {
          const when = t.dueDate ? ` (due ${t.dueDate}${t.dueTime ? ` ${t.dueTime}` : ""})` : "";
          return `- [${t.status}] ${t.title}${when} (id: ${t.id})`;
        })
        .join("\n");
    },
    {
      name: "search_tasks",
      description:
        "Find existing tasks by keyword in their title or notes (best match first), optionally filtered by status. Use it to check whether a task already exists before creating a duplicate, or to get the id of the task to complete.",
      schema: z.object({
        query: z.string().describe("Words to look for in the task, e.g. 'dentist' or 'car registration'"),
        status: z.enum(["open", "done"]).optional(),
      }),
    }
  );

  const completeTask = tool(
    async ({ taskId }) => {
      const updated = store.updateTaskStatus(taskId, "done");
      if (!updated) return `No task found with id ${taskId}.`;
      onReference?.({ type: "task", id: updated.id });
      return `Marked "${updated.title}" as done.`;
    },
    {
      name: "complete_task",
      description: "Mark a task as done, given its id (from list_tasks).",
      schema: z.object({
        taskId: z.string(),
      }),
    }
  );

  return [createTask, listTasks, searchTasks, completeTask];
}
