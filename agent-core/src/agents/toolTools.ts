import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { OnReference } from "./references.js";
import type { CallResult, ToolOperation } from "../tools/toolMcp.js";
import { validateInput } from "../tools/validateInput.js";
import { fullSchemaText, oneLineParams } from "./schemaText.js";

// The "tools-agent" subagent's tools. Unlike task-agent / document-agent, the
// operations here aren't fixed — they come from whatever the family has built.
// Rather than regenerate the planner graph every time a tool changes, this
// exposes two generic tools and resolves the catalog live on each call.

export interface FamilyToolEntry {
  id: string;
  name: string;
  description: string;
  kind: "static" | "server";
  /** Empty for a display-only (static) tool, or a server tool with no operations. */
  operations: ToolOperation[];
}

export interface FamilyToolDeps {
  /** The current user's ready tools that expose an operation list. Live — read on each call. */
  getCatalog: () => FamilyToolEntry[];
  /** Invoke one operation over MCP (tools/toolMcp.ts). */
  callOperation: (toolId: string, operation: string, args: Record<string, unknown>) => Promise<CallResult>;
  onReference?: OnReference;
  /** ScopedStore.logActivity — writes get an audit-log line. */
  logActivity: (actor: string, action: string, detail: string) => void;
}

const paramList = oneLineParams;

function renderCatalog(catalog: FamilyToolEntry[]): string {
  if (catalog.length === 0) {
    return "The family hasn't built any tools yet.";
  }
  return catalog
    .map((t) => {
      if (t.operations.length === 0) {
        return `- ${t.name}: ${t.description}\n    (display-only — nothing the assistant can run. If the user wants it to do something, ask to have it improved.)`;
      }
      const ops = t.operations
        .map((o) => `    • ${o.name} [${o.access}] — ${o.description}\n      params: ${paramList(o.inputSchema)}`)
        .join("\n");
      return `- ${t.name}: ${t.description}\n${ops}`;
    })
    .join("\n\n") +
    `\n\nThe "params" lines are summaries. For an operation with nested or unclear ` +
    `parameters, call describe_family_tool first to see the full shape.`;
}

/** Case-insensitive exact match, then unique substring match. */
function resolveTool(catalog: FamilyToolEntry[], name: string): FamilyToolEntry | undefined {
  const q = name.trim().toLowerCase();
  const exact = catalog.find((t) => t.name.toLowerCase() === q || t.id.toLowerCase() === q);
  if (exact) return exact;
  const partial = catalog.filter((t) => t.name.toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : undefined;
}

export function makeFamilyToolTools(deps: FamilyToolDeps) {
  const listFamilyTools = tool(
    async () => renderCatalog(deps.getCatalog()),
    {
      name: "list_family_tools",
      description:
        "List the custom tools the family has built and the operations each exposes (name, read/write, and a one-line parameter summary). Call this first; then describe_family_tool for a full schema, then call_family_tool.",
      schema: z.object({}),
    },
  );

  const describeFamilyTool = tool(
    async ({ tool: toolName, operation }) => {
      const catalog = deps.getCatalog();
      const entry = resolveTool(catalog, toolName);
      if (!entry) {
        const names = catalog.map((t) => t.name).join(", ");
        return names
          ? `No family tool matches "${toolName}". The tools are: ${names}.`
          : `The family hasn't built any tools yet.`;
      }
      if (entry.operations.length === 0) {
        return `The "${entry.name}" tool is display-only — it has no operations to describe.`;
      }
      const ops = operation
        ? entry.operations.filter((o) => o.name === operation)
        : entry.operations;
      if (ops.length === 0) {
        return `The "${entry.name}" tool has no operation "${operation}". It has: ${entry.operations
          .map((o) => o.name)
          .join(", ")}.`;
      }
      return ops
        .map(
          (o) =>
            `${entry.name}.${o.name} [${o.access}] — ${o.description}\n\nParameters:\n${fullSchemaText(o.inputSchema)}`
        )
        .join("\n\n---\n\n");
    },
    {
      name: "describe_family_tool",
      description:
        "Show the full parameter schema for a family tool's operation(s) — every field, including nested objects and arrays. Call this before call_family_tool when the parameters look complex. Omit `operation` to see them all.",
      schema: z.object({
        tool: z.string().describe("The tool's name, e.g. 'Item Tracker'"),
        operation: z.string().optional().describe("One operation name; omit for all of them"),
      }),
    },
  );

  const callFamilyTool = tool(
    async ({ tool: toolName, operation, input }) => {
      const catalog = deps.getCatalog();
      const entry = resolveTool(catalog, toolName);
      if (!entry) {
        const names = catalog.map((t) => t.name).join(", ");
        return names
          ? `No family tool matches "${toolName}". The tools are: ${names}. Use one of those exact names.`
          : `The family hasn't built any tools yet.`;
      }
      if (entry.operations.length === 0) {
        return `The "${entry.name}" tool is display-only — it has nothing to run. It does NOT exist as a duplicate to build; to make it able to ${
          operation ? `"${operation}"` : "do that"
        }, tell the user it needs to be improved (builder-agent can add that capability to the existing tool).`;
      }
      const op = entry.operations.find((o) => o.name === operation);
      if (!op) {
        return `The "${entry.name}" tool has no operation "${operation}". It has: ${entry.operations
          .map((o) => o.name)
          .join(", ")}. If none of those fit, the existing tool can be improved to add one — don't build a new tool.`;
      }

      const check = validateInput(op.inputSchema, input ?? {});
      if (!check.ok) {
        return `Can't call ${entry.name}.${operation}: ${check.errors.join("; ")}. Expected params: ${paramList(
          op.inputSchema,
        )}.`;
      }

      const result = await deps.callOperation(entry.id, op.name, check.value);
      deps.onReference?.({ type: "tool", id: entry.id });

      if (!result.ok) {
        // Surface a failing operation in the activity log — repeated entries are
        // the signal that the tool needs fixing (builder-agent's improve_tool).
        deps.logActivity("tools-agent", "tool.error", `${entry.name} · ${operation} failed: ${result.error}`);
        return `The "${entry.name}" tool couldn't run ${operation}: ${result.error}. It may need fixing — the user can ask to have it improved.`;
      }
      if (op.access === "write") {
        // A plain-language activity line — "Loan Tracker: added drill, borrower Nate".
        const fields = Object.entries(check.value)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(", ");
        const verb = op.description || operation.replace(/_/g, " ");
        deps.logActivity(
          "tools-agent",
          "tool.invoked",
          `${entry.name}: ${verb}${fields ? ` — ${fields}` : ""}`,
        );
      }
      const body = typeof result.value === "string" ? result.value : JSON.stringify(result.value);
      return `${entry.name}.${operation} returned:\n${body}`;
    },
    {
      name: "call_family_tool",
      description:
        "Run one operation on a family tool. Give the tool name and operation name exactly as list_family_tools shows them, plus an input object with the operation's parameters (use describe_family_tool first if the shape isn't obvious).",
      schema: z.object({
        tool: z.string().describe("The tool's name, e.g. 'Item Tracker'"),
        operation: z.string().describe("The operation name, e.g. 'find_item'"),
        input: z
          .record(z.string(), z.any())
          .optional()
          .describe("The operation's parameters as an object, e.g. { \"query\": \"passport\" }"),
      }),
    },
  );

  return [listFamilyTools, describeFamilyTool, callFamilyTool];
}
