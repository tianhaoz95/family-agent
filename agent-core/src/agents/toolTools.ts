import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { OnReference } from "./references.js";
import type { CallResult, JsonSchema, ToolOperation } from "../tools/toolMcp.js";
import { validateInput } from "../tools/validateInput.js";

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

function paramList(schema: JsonSchema | undefined): string {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  const parts = Object.entries(props).map(([name, s]) => {
    const bits = [s.type ?? "any"];
    if (s.enum) bits.push(`one of ${s.enum.map((e) => JSON.stringify(e)).join("/")}`);
    if (required.has(name)) bits.push("required");
    const note = s.description ? ` — ${s.description}` : "";
    return `${name} (${bits.join(", ")})${note}`;
  });
  return parts.length ? parts.join("; ") : "no parameters";
}

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
    .join("\n\n");
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
        "List the custom tools the family has built and the operations each one exposes (name, whether it reads or writes, and its parameters). Call this first, then call_family_tool.",
      schema: z.object({}),
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
        "Run one operation on a family tool. Give the tool name and operation name exactly as list_family_tools shows them, plus an input object with the operation's parameters.",
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

  return [listFamilyTools, callFamilyTool];
}
