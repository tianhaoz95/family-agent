import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { LocalChatModel } from "../model.js";

// A single participant turn in a comment thread — on an artifact or a wiki
// page. Deliberately off the deepagents planner (same reasoning as
// agents/extraction.ts / artifacts/resolve.ts, which this supersedes for the
// per-thread case): it's a bounded, system-triggered step — a family member
// typed "@agent" into a reply — so it just needs to read the whole page and
// the discussion so far and answer once. Shared between artifacts and the
// wiki (see docs/DECISIONS.md → "Threaded comments") since the shape is
// identical; only what the caller does with `editedContent` differs
// (`store.updateArtifactHtml` vs `store.updateWikiPage`).

const EditSchema = z.object({
  content: z.string().min(1).describe("The COMPLETE revised content, in the same format as the original"),
});

export interface ThreadReplyInput {
  /** A human-readable noun for prompt copy — "artifact" or "wiki page". */
  kind: string;
  title: string;
  /** The full current content — HTML for an artifact, Markdown for a wiki page. */
  content: string;
  maxContentChars: number;
  /** The passage this thread is anchored to, if any. */
  quote?: string | null;
  /** Every reply so far, oldest first (the root comment counts as the first one). */
  history: { author: string; body: string }[];
  /** The newest message — the one that mentioned @agent. */
  message: string;
}

export interface ThreadReplyOutput {
  reply: string;
  /** Set only if the model actually called edit_content. */
  editedContent: string | null;
}

function historyBlock(history: { author: string; body: string }[]): string {
  if (history.length === 0) return "(nothing yet — this is the first message)";
  return history.map((h) => `${h.author}: ${h.body}`).join("\n\n");
}

/** One off-planner model call: reads the content + thread, replies like a
 *  participant, and may revise the content once via `edit_content`. */
export async function runThreadAgentTurn(
  model: LocalChatModel,
  input: ThreadReplyInput
): Promise<ThreadReplyOutput | { error: string }> {
  let edited: string | null = null;
  const editContent = tool(
    async ({ content }: { content: string }) => {
      edited = content;
      return "ok — now reply to the thread explaining what you changed";
    },
    {
      name: "edit_content",
      description: `Replace the whole ${input.kind}'s content with a revised version, if the discussion calls for a change.`,
      schema: EditSchema,
    }
  );
  const bound = model.bindTools([editContent]);

  const system = `You're one participant in a comment thread on a ${input.kind} called "${input.title}" that a family is collaborating on. Someone just mentioned you (@agent).

${input.quote ? `This thread is anchored to a highlighted passage: "${input.quote.slice(0, 400)}"\n\n` : ""}Read the full current content, the discussion so far, and the newest message, then reply — conversationally and specifically, like a real participant, not a form response. Keep it to a few sentences unless the question genuinely needs more.

If (and only if) the discussion calls for an actual change to the ${input.kind} itself, call edit_content ONCE with the complete revised content (same format as the original — don't add wrapper tags/fences that weren't already there), then say what you changed in your reply. Otherwise just reply — most messages are questions or discussion, not edit requests.`;

  const human = `Full content:\n${input.content.slice(0, input.maxContentChars)}\n\n---\nThread so far:\n${historyBlock(
    input.history
  )}\n\n---\nNewest message: ${input.message}`;

  let res;
  try {
    res = await bound.invoke([new SystemMessage(system), new HumanMessage(human)]);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  for (const call of res.tool_calls ?? []) {
    if (call.name === "edit_content" && typeof call.args?.content === "string") edited = call.args.content;
  }
  const raw = res.content;
  const replyText =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.map((c: any) => (typeof c === "string" ? c : (c?.text ?? ""))).join("")
        : "";
  return { reply: replyText.trim() || "(The assistant didn't have anything to add.)", editedContent: edited };
}
