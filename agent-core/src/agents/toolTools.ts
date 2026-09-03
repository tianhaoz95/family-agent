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
    return "The family hasn't built any tools with operations the assistant can use.";
  }
  return catalog
    .map((t) => {
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
        return `No family tool matches "${toolName}". Call list_family_tools to see the exact names.`;
      }
      const op = entry.operations.find((o) => o.name === operation);
      if (!op) {
        return `The "${entry.name}" tool has no operation "${operation}". It has: ${entry.operations
          .map((o) => o.name)
          .join(", ")}.`;
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
        return `The "${entry.name}" tool couldn't run ${operation}: ${result.error}`;
      }
      if (op.access === "write") {
        deps.logActivity(
          "tools-agent",
          "tool.invoked",
          `Ran ${entry.name} · ${operation}(${JSON.stringify(check.value)})`,
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
