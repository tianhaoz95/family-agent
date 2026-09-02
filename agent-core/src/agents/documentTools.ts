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

  const CATEGORIES = ["bill", "medical", "school", "insurance", "tax", "receipt", "other"] as const;

  const searchDocuments = tool(
    async ({ query, category, dueBefore, dueAfter }) => {
      const hits = store.searchDocuments(query ?? "", { category, dueBefore, dueAfter, limit: 8 });
      const label = [query?.trim(), category && `category:${category}`].filter(Boolean).join(" ") || "(all)";
      store.logActivity(
        "document-agent",
        "document.searched",
        `Searched documents for "${label}" — ${hits.length} match${hits.length === 1 ? "" : "es"}`
      );
      if (hits.length === 0) {
        return query?.trim()
          ? `No documents matched "${query}".`
          : "No documents match those filters.";
      }
      return hits
        .map((h) => {
          const status = h.category
            ? `${h.category}${h.summary ? ` — ${h.summary}` : ""}`
            : h.extractionStatus === "done"
              ? "uncategorized"
              : "still being processed";
          const line = `- ${h.filename} (id: ${h.id}): ${status}`;
          return h.snippet ? `${line}\n    “…${h.snippet}…”` : line;
        })
        .join("\n");
    },
    {
      name: "search_documents",
      description:
        "Find family documents by keyword — searches the filename, the full text, and the extracted summary, and returns the best matches (with their ids) first. Optionally narrow by category (bill, medical, school, insurance, tax, receipt, other) or by an important-date range (dueBefore / dueAfter, ISO YYYY-MM-DD). Use this for any 'do we have…', 'find the…', 'when is … due' question; only fall back to list_documents to browse everything with no particular query.",
      schema: z.object({
        query: z
          .string()
          .describe("What to look for, in plain words — e.g. 'car insurance renewal' or 'Lincoln Elementary field trip'"),
        category: z.enum(CATEGORIES).optional().describe("Only documents in this category"),
        dueBefore: z
          .string()
          .optional()
          .describe("Only documents with an important date on or before this ISO date (YYYY-MM-DD)"),
        dueAfter: z
          .string()
          .optional()
          .describe("Only documents with an important date on or after this ISO date (YYYY-MM-DD)"),
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

  return [searchDocuments, getDocument, listDocuments, saveExtraction];
}
