import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { LocalChatModel } from "../model.js";
import type { ScopedStore } from "../db.js";

// Deliberately bypasses the deepagents planner/subagent graph for this one
// step. The planner path (agents/index.ts) is for conversational requests;
// this runs automatically right after ingest, with no user in the loop, so
// it needs to be deterministic. Routing it through the planner meant asking
// a 3B local model to copy a document id into a tool call by hand — it
// silently transposed a character mid-id in testing (see docs/DECISIONS.md)
// and the extraction just never happened. Binding one tool whose id is
// captured in a closure removes that failure mode entirely: the model only
// has to produce the fields it actually read off the page.
const ExtractionSchema = z.object({
  summary: z.string().describe("One sentence describing what this document is"),
  category: z
    .enum(["bill", "medical", "school", "insurance", "tax", "receipt", "other"])
    .describe("Best-fit category for this document"),
  importantDates: z
    .array(z.string())
    .optional()
    .describe("Any ISO 8601 dates found in the document (due dates, expirations, appointments)"),
});

const SYSTEM_PROMPT = `You extract structured fields from a family document.
Read the text and call save_extraction exactly once with your best answers.
If you are unsure of the category, use "other". If no dates are present,
omit importantDates.`;

export interface ExtractionResult {
  summary: string;
  category: string;
  importantDates: string[];
}

async function attemptExtraction(
  model: LocalChatModel,
  filename: string,
  rawText: string
): Promise<ExtractionResult | null> {
  let captured: ExtractionResult | null = null;

  const saveExtraction = tool(
    async (input) => {
      captured = { summary: input.summary, category: input.category, importantDates: input.importantDates ?? [] };
      return "saved";
    },
    { name: "save_extraction", description: "Save the extracted fields for this document.", schema: ExtractionSchema }
  );

  const bound = model.bindTools([saveExtraction]);
  const response = await bound.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(`Filename: ${filename}\n\nDocument text:\n${rawText}`),
  ]);

  for (const call of response.tool_calls ?? []) {
    if (call.name === "save_extraction") {
      await saveExtraction.invoke(call.args as z.infer<typeof ExtractionSchema>);
    }
  }

  return captured;
}

// Small local models occasionally return no tool call at all on the first
// try; one retry clears most of those (see docs/BUILD_LOG.md for observed
// rates) without masking a real, repeatable failure.
export async function extractDocument(
  model: LocalChatModel,
  store: ScopedStore,
  doc: { id: string; filename: string; rawText: string }
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await attemptExtraction(model, doc.filename, doc.rawText);
      if (result) {
        store.updateDocumentExtraction(doc.id, result as unknown as Record<string, unknown>);
        return;
      }
    } catch (err) {
      store.logActivity(
        "document-agent",
        "document.extract_error",
        `Attempt ${attempt} failed for "${doc.filename}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  store.setDocumentExtractionStatus(doc.id, "failed");
  store.logActivity(
    "document-agent",
    "document.extract_failed",
    `Could not extract fields from "${doc.filename}" after 2 attempts.`
  );
}
