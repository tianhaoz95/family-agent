import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOllama } from "@langchain/ollama";
import type { ScopedStore, ArtifactCommentRecord } from "../db.js";
import { validateArtifactFragment, MAX_ARTIFACT_FRAGMENT } from "./wrap.js";

// Address open comments on an artifact. Deliberately off the deepagents planner
// (same reasoning as agents/extraction.ts / agents/rename.ts): it's a bounded,
// system-triggered step — the user pressed "Ask AI to address" in the viewer —
// so it just needs to be reliable. Two tools bound with the artifact captured
// in a closure: `edit_artifact` replaces the whole body once, `resolve_comment`
// records the outcome per comment. A comment the model doesn't resolve stays
// open. One retry if the edit doesn't validate.

const EditSchema = z.object({
  html: z
    .string()
    .min(1)
    .max(MAX_ARTIFACT_FRAGMENT)
    .describe("The COMPLETE revised page body (an HTML fragment — no <html>/<head>/<body>)"),
});
const ResolveSchema = z.object({
  commentId: z.string().describe("The id of the comment you are resolving"),
  reply: z
    .string()
    .min(1)
    .max(1500)
    .describe("One or two sentences: what you changed for this comment, or why no change was needed"),
});

const SYSTEM_PROMPT = `You maintain an HTML page (an "artifact") that a family member is reviewing.
They have left comments, each anchored to a quoted passage. Your job:

1. Read the page and every open comment.
2. If ANY comment asks for a change you agree with, call edit_artifact ONCE with
   the full revised page body — apply every change that's warranted in that one
   call. Keep the same structure, style and voice; change only what the comments
   call for. Do NOT include <html>, <head> or <body> tags.
3. Call resolve_comment once for EVERY comment: say what you changed for it, or
   explain briefly why you left it as-is.

If no comment needs a change, don't call edit_artifact at all — just resolve
each comment with a short reply.`;

export interface CommentOutcome {
  id: string;
  action: "edited" | "replied" | "skipped";
  resolution: string;
}

export interface ResolveResult {
  edited: boolean;
  outcomes: CommentOutcome[];
}

function commentBlock(comments: ArtifactCommentRecord[]): string {
  return comments
    .map(
      (c, i) =>
        `Comment ${i + 1} — id: ${c.id}\n` +
        (c.quote ? `  Highlighted: "${c.quote.slice(0, 400)}"\n` : "  (not anchored to a passage)\n") +
        `  Note: ${c.body}`
    )
    .join("\n\n");
}

async function attempt(
  model: ChatOllama,
  title: string,
  html: string,
  comments: ArtifactCommentRecord[],
  feedback?: string
): Promise<{ html: string | null; replies: Map<string, string> }> {
  let editedHtml: string | null = null;
  const replies = new Map<string, string>();

  const editArtifact = tool(
    async ({ html: h }: { html: string }) => {
      editedHtml = h;
      return "ok — now resolve each comment";
    },
    { name: "edit_artifact", description: "Replace the whole page body with a revised version.", schema: EditSchema }
  );
  const resolveComment = tool(
    async ({ commentId, reply }: { commentId: string; reply: string }) => {
      replies.set(commentId, reply);
      return "recorded";
    },
    { name: "resolve_comment", description: "Record the outcome for one comment.", schema: ResolveSchema }
  );

  const bound = model.bindTools([editArtifact, resolveComment]);
  const res = await bound.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(
      `Artifact: "${title}"\n\nPage body:\n${html}\n\n---\nOpen comments:\n\n${commentBlock(comments)}` +
        (feedback ? `\n\n---\n${feedback}` : "")
    ),
  ]);
  for (const call of res.tool_calls ?? []) {
    if (call.name === "edit_artifact" && typeof call.args?.html === "string") editedHtml = call.args.html;
    if (call.name === "resolve_comment" && call.args?.commentId && call.args?.reply)
      replies.set(String(call.args.commentId), String(call.args.reply));
  }
  return { html: editedHtml, replies };
}

/**
 * Run the model over an artifact's open comments and apply the result. Resolves
 * every comment it addressed (recording the reply), applies one edit if it made
 * one, and leaves anything it didn't touch open. Returns per-comment outcomes.
 */
export async function resolveArtifactComments(
  model: ChatOllama,
  store: ScopedStore,
  artifactId: string,
  commentIds?: string[]
): Promise<ResolveResult | { error: string }> {
  const artifact = store.getArtifact(artifactId);
  if (!artifact) return { error: "artifact not found" };
  let open = store.listArtifactComments(artifactId).filter((c) => c.status === "open");
  if (commentIds?.length) open = open.filter((c) => commentIds.includes(c.id));
  if (open.length === 0) return { edited: false, outcomes: [] };

  let result: Awaited<ReturnType<typeof attempt>> | null = null;
  for (let i = 1; i <= 2; i++) {
    try {
      result = await attempt(
        model,
        artifact.title,
        artifact.html,
        open,
        i === 2 ? "Your last revised html was rejected — send valid body HTML this time, or don't edit." : undefined
      );
    } catch (err) {
      if (i === 2) return { error: err instanceof Error ? err.message : String(err) };
      continue;
    }
    if (!result.html) break; // no edit attempted — fine
    if (validateArtifactFragment(result.html).ok) break;
    if (i === 2) result.html = null; // give up on the edit, still record replies
  }
  if (!result) return { error: "the model did not respond" };

  let edited = false;
  if (result.html && validateArtifactFragment(result.html).ok) {
    store.updateArtifactHtml(artifactId, result.html);
    edited = true;
  }

  const outcomes: CommentOutcome[] = [];
  for (const c of open) {
    const reply = result.replies.get(c.id);
    if (reply) {
      store.resolveArtifactComment(artifactId, c.id, { resolution: reply, resolvedBy: "agent" });
      outcomes.push({ id: c.id, action: edited ? "edited" : "replied", resolution: reply });
    } else {
      outcomes.push({
        id: c.id,
        action: "skipped",
        resolution: "The assistant didn't address this one — try rephrasing, or resolve it yourself.",
      });
    }
  }
  store.logActivity(
    "artifact-agent",
    "artifact.comments_resolved",
    `Addressed ${outcomes.filter((o) => o.action !== "skipped").length} comment(s) on "${artifact.title}"` +
      (edited ? " and edited it" : "")
  );
  return { edited, outcomes };
}
