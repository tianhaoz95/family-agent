import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Store } from "../db.js";

// Bound to one Store instance per server process — see agents/index.ts.
export function makeDocumentTools(store: Store) {
  const saveExtraction = tool(
    async ({ documentId, summary, category, importantDates }) => {
      const extracted = {
        summary,
        category,
        importantDates: importantDates ?? [],
      };
      const doc = store.updateDocumentExtraction(documentId, extracted);
      if (!doc) return `No document found with id ${documentId}.`;
      return `Saved extraction for "${doc.filename}": ${category} — ${summary}`;
    },
    {
      name: "save_extraction",
      description:
        "Record the structured fields extracted from a family document (its category, a one-line summary, and any important dates found in it).",
      schema: z.object({
        documentId: z.string(),
        summary: z.string().describe("One sentence describing what this document is"),
        category: z
          .enum(["bill", "medical", "school", "insurance", "tax", "receipt", "other"])
          .describe("Best-fit category for this document"),
        importantDates: z
          .array(z.string())
          .optional()
          .describe("Any ISO 8601 dates found in the document (due dates, expirations, appointments)"),
      }),
    }
  );

  const getDocument = tool(
    async ({ documentId }) => {
      const doc = store.getDocument(documentId);
      if (!doc) return `No document found with id ${documentId}.`;
      return `Filename: ${doc.filename}\n\n${doc.rawText}`;
    },
    {
      name: "get_document",
      description: "Fetch the raw text of a document by id, to read before extracting fields from it.",
      schema: z.object({
        documentId: z.string(),
      }),
    }
  );

  return [getDocument, saveExtraction];
}
