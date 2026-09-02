import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ScopedStore } from "../db.js";

// Bound to one user's ScopedStore — the planner builds a fresh agent per
// authenticated user (see agents/index.ts), so these tools only ever touch
// that user's tasks.
export function makeTaskTools(store: ScopedStore) {
  const createTask = tool(
    async ({ title, notes, dueDate }) => {
      const rec = store.createTask({ title, notes, dueDate });
      return `Created task ${rec.id}: "${rec.title}"${rec.dueDate ? ` (due ${rec.dueDate})` : ""}.`;
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
      }),
    }
  );

  const listTasks = tool(
    async ({ status }) => {
      const tasks = store.listTasks(status);
      if (tasks.length === 0) return "No tasks found.";
      return tasks
        .map((t) => `- [${t.status}] ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ""} (id: ${t.id})`)
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

  const completeTask = tool(
    async ({ taskId }) => {
      const updated = store.updateTaskStatus(taskId, "done");
      if (!updated) return `No task found with id ${taskId}.`;
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

  return [createTask, listTasks, completeTask];
}
