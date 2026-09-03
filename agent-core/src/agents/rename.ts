import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOllama } from "@langchain/ollama";

// Suggest a human-friendly filename for a document from its content. Like
// agents/extraction.ts this deliberately bypasses the deepagents planner: it is
// a single mechanical step with no user in the loop at call time (the user
// confirms the *result* before it is applied), so it just needs to be cheap and
// deterministic, not conversational.

const SYSTEM_PROMPT = `You name family documents. Given a document's text, reply with ONE short, specific filename that says what it is — who it is from and what it covers. Rules:
- 3 to 8 words, Title Case, spaces are fine.
- No date prefixes, no file extension, no quotes, no explanation.
- Prefer concrete nouns from the document (sender, account, subject) over generic words like "Document" or "Scan".
Reply with only the name on a single line.`;

/** Keep the original extension (".pdf", ".jpg", …); return "" if there is none. */
function extensionOf(filename: string): string {
  const m = filename.match(/(\.[A-Za-z0-9]{1,8})$/);
  return m ? m[1] : "";
}

function cleanName(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
    ?.replace(/^["'`]|["'`]$/g, "")
    .replace(/^(filename|name)\s*[:\-]\s*/i, "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    ?? "";
}

export interface RenameSuggestion {
  /** Proposed filename, extension included, e.g. "Blue Cross EOB March 2026.pdf". */
  filename: string;
}

/**
 * Ask the local model for a better name. Returns null if it produced nothing
 * usable after one retry — the caller should then just leave the name alone.
 */
export async function suggestDocumentName(
  model: ChatOllama,
  doc: { filename: string; rawText: string; extracted?: Record<string, unknown> | null }
): Promise<RenameSuggestion | null> {
  const ext = extensionOf(doc.filename);
  const summary =
    doc.extracted && typeof doc.extracted.summary === "string" ? `Known summary: ${doc.extracted.summary}\n\n` : "";
  const body = doc.rawText.slice(0, 4000);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(`Current filename: ${doc.filename}\n\n${summary}Document text:\n${body}`),
      ]);
      const text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      const base = cleanName(text).replace(new RegExp(`${ext.replace(".", "\\.")}$`, "i"), "").trim();
      if (base.length >= 2 && !/^(document|scan|upload|untitled|image|file)$/i.test(base)) {
        return { filename: base + ext };
      }
    } catch {
      /* retry once, then give up */
    }
  }
  return null;
}
