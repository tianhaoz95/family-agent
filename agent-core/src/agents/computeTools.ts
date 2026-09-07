import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { runCode } from "../compute/run.js";

// The `run_code` tool — bound directly to the planner and document-agent (no
// subagent; computation is a capability, not a domain). Stateless: no files,
// no network, no persistence between calls.

export interface ComputeToolDeps {
  logActivity: (actor: string, action: string, detail: string) => void;
}

export function makeComputeTools(deps: ComputeToolDeps) {
  const runCodeTool = tool(
    async ({ code, input }) => {
      const out = await runCode(code, input);
      deps.logActivity("compute", "compute.run", `Ran a calculation (${code.length} chars)`);
      const parts: string[] = [];
      if (out.logs.length) parts.push(`output:\n${out.logs.join("\n")}`);
      if (out.error) {
        parts.push(`error: ${out.error}`);
      } else {
        parts.push(`result: ${out.result === undefined ? "(no value — end with an expression or use console.log)" : JSON.stringify(out.result)}`);
      }
      return parts.join("\n");
    },
    {
      name: "run_code",
      description:
        "Run a short JavaScript snippet to compute an exact answer — arithmetic, percentages, tips, loan/interest math, date differences, unit conversions, summing or averaging numbers, simple rules/logic. Do NOT do maths in your head; use this. The value of the snippet's LAST expression is the result; use console.log for intermediate steps. `input` (any JSON) is available as the global `input`; the current time is the ISO string `NOW`. No file, network, or state access.",
      schema: z.object({
        code: z
          .string()
          .min(1)
          .max(8000)
          .describe("JavaScript. Example: 'const each = (847.50 * 1.18) / 3; Math.round(each * 100) / 100'"),
        input: z
          .any()
          .optional()
          .describe("Optional JSON data the snippet can read as the global `input` (e.g. an array of numbers from a document)."),
      }),
    }
  );

  return [runCodeTool];
}
