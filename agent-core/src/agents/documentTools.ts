import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { ScopedStore } from "../db.js";

// Bound to one user's ScopedStore — see agents/index.ts.
export function makeDocumentTools(store: ScopedStore) {
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

  const listDocuments = tool(
    async () => {
      const docs = store.listDocuments();
      if (docs.length === 0) return "No documents have been ingested yet.";
      return docs
        .map((d) => {
          const status = d.extracted
            ? `${d.extracted.category ?? "uncategorized"} — ${d.extracted.summary ?? ""}`
            : "still being processed";
          return `- ${d.filename} (id: ${d.id}): ${status}`;
        })
        .join("\n");
    },
    {
      name: "list_documents",
      description:
        "List every document that has been ingested, with its id, category, and summary if extraction has finished. Use this before answering any question about what documents exist.",
      schema: z.object({}),
    }
  );

  return [getDocument, listDocuments, saveExtraction];
}
