import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { createLocalModel } from "../model.js";
import type { Store } from "../db.js";
import { makeTaskTools } from "./taskTools.js";
import { makeDocumentTools } from "./documentTools.js";

const PLANNER_PROMPT = `You are the coordinating agent for a local-first family
organization assistant. You never see raw documents or personal detail yourself
if you can help it — delegate to the "task-agent" subagent for anything to do
with to-dos/reminders, and to the "document-agent" subagent for anything to do
with reading, listing, or classifying a family document (bills, school notes,
insurance, medical, receipts, tax paperwork, anything a family member scanned
or pasted in). "Documents" always means that — family paperwork — it never
refers to your own scratch files.

To delegate, call the tool named "task" with two arguments: subagent_type set
to "task-agent" or "document-agent", and description set to what you need
done. task-agent and document-agent are NOT themselves callable tools — there
is no tool literally named "task-agent" or "document-agent". Calling "task"
with the right subagent_type is the only way to reach them.

Example — user asks "what documents do I have?": call task with
subagent_type "document-agent" and description "List all ingested documents
with their categories and summaries." Do not answer this kind of question
yourself; you have no way to know the answer without asking document-agent.

Example — user asks "remind me to renew the car registration": call task
with subagent_type "task-agent" and description "Create a task to renew the
car registration."

Keep replies short and concrete. If a request needs no tool at all (a plain
question with nothing to look up, like "what can you help with?"), answer
directly.`;

const TASK_AGENT_PROMPT = `You manage the family's task list. Use create_task,
list_tasks, and complete_task as needed. Confirm what you did in one sentence.`;

const DOCUMENT_AGENT_PROMPT = `You read family documents and extract structured
fields from them. Use list_documents to see what's been ingested (id,
category, summary) — always start here for any question about what documents
exist. Use get_document to read a specific document's full text by id, then
always call save_extraction with a category, a one-line summary, and any
important dates you find (due dates, expirations, appointment dates). Confirm
what you did in one sentence.`;

export function buildFamilyAgent(store: Store) {
  const model = createLocalModel();

  return createDeepAgent({
    name: "family-planner",
    model,
    systemPrompt: PLANNER_PROMPT,
    // deepagents bakes in generic ls/read_file/write_file tools for the
    // agent's own "working memory" filesystem. A 3B-class model reliably
    // confused those with our domain concept of "documents" — asked "what
    // documents do I have," it called ls("/") on its own empty scratch
    // filesystem and reported no documents, never delegating to
    // document-agent (reproduced with both qwen2.5:3b and gemma4:e2b; a
    // stronger prompt alone did not fix it — see docs/DECISIONS.md).
    // Denying all paths removes those generic tools' ability to do
    // anything, without touching the custom tools below (list_documents,
    // create_task, etc.), which aren't filesystem-permission-gated at all.
    permissions: [{ operations: ["read", "write"], paths: ["/**"], mode: "deny" }],
    middleware: [createFilesystemMiddleware({ tools: ["read_file"] })],
    subagents: [
      {
        name: "task-agent",
        description:
          "Handles creating, listing, and completing family to-dos and reminders.",
        systemPrompt: TASK_AGENT_PROMPT,
        model,
        tools: makeTaskTools(store),
      },
      {
        name: "document-agent",
        description:
          "Reads a family document by id and extracts its category, a summary, and important dates.",
        systemPrompt: DOCUMENT_AGENT_PROMPT,
        model,
        tools: makeDocumentTools(store),
      },
    ],
  });
}

export type FamilyAgent = ReturnType<typeof buildFamilyAgent>;

// Small local models occasionally return an empty final message with no
// tool call on the first try (observed in testing — see docs/BUILD_LOG.md
// and docs/DECISIONS.md). One retry clears most of those. Kept even after
// switching to gemma4:e2b, since the failure mode is about small-model
// reliability in general, not specific to the model that first surfaced it.
export async function askFamilyAgent(agent: FamilyAgent, message: string): Promise<string> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await agent.invoke({
      messages: [{ role: "user", content: message }],
    });
    const last = result.messages.at(-1);
    const text = last ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : "";
    if (text.trim()) return text;
  }
  return "(the local model didn't return a response — try rephrasing, or check /activity for what it attempted)";
}
