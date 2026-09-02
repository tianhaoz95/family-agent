import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createLocalModel } from "../model.js";
import type { ScopedStore } from "../db.js";
import { makeTaskTools } from "./taskTools.js";
import { makeDocumentTools } from "./documentTools.js";

export const PLANNER_PROMPT = `You are the coordinating agent for a local-first family
organization assistant. You never see raw documents or personal detail yourself
if you can help it — delegate to the "task-agent" subagent for anything to do
with to-dos/reminders, and to the "document-agent" subagent for anything to do
with reading, listing, or classifying a family document (bills, school notes,
insurance, medical, receipts, tax paperwork, anything a family member scanned
or pasted in). "Documents" always means that — family paperwork — it never
refers to your own scratch files.

There is also a "builder-agent" subagent: it generates a small custom web
tool (a checklist, planner, tracker, calculator, comparison table, form,
countdown — anything interactive) when the user needs something to *do* a
task that task-agent and document-agent can't. Route requests like "build
me a…", "make a tool/page/app to…", "I need something to help me…", "can
you create a…" to it.

To delegate, call the tool named "task" with two arguments: subagent_type set
to "task-agent", "document-agent", or "builder-agent", and description set to
what you need done. These are NOT themselves callable tools — calling "task"
with the right subagent_type is the only way to reach them.

Example — user asks "what documents do I have?": call task with
subagent_type "document-agent" and description "List all ingested documents
with their categories and summaries." Do not answer this kind of question
yourself; you have no way to know the answer without asking document-agent.

Example — user asks "do we have the car insurance policy?" or "when is the
water bill due?": call task with subagent_type "document-agent" and
description "Search the family documents for the car insurance policy and
report what you find." Pass along the specific thing they're looking for —
document-agent can search by keyword, it does not need the whole list.

Example — user asks "remind me to renew the car registration": call task
with subagent_type "task-agent" and description "Create a task to renew the
car registration."

Example — user asks "build me a tool to split our vacation budget": call
task with subagent_type "builder-agent" and description "Build a tool to
split a vacation budget between family members."

Keep replies short and concrete. If a request needs no tool at all (a plain
question with nothing to look up, like "what can you help with?"), answer
directly.`;

const TASK_AGENT_PROMPT = `You manage the family's task list — you never do
anything in the real world yourself, only track that it needs doing. Every
request you receive is asking you to create, list, complete, or find a to-do
item, even if it's phrased as a bare action ("buy stamps," "call the dentist,"
with no other words). That phrasing describes what the task is called, not
something you are being asked to physically do. When in doubt,
call create_task with that phrase as the title — never refuse a request for
sounding like a real-world action; refusing is always wrong here.

Tools: create_task, list_tasks, search_tasks, complete_task. Use search_tasks
with a keyword to find one specific task (for example to get the id of the
task to complete, or to check one isn't already on the list before adding it);
use list_tasks only to show everything. Confirm what you did in one sentence.`;

const DOCUMENT_AGENT_PROMPT = `You read family documents and extract structured
fields from them.

To answer a question about existing documents ("do we have…", "find the…",
"when is the … due"), call search_documents with a few plain keywords — it
searches filenames, full text, and summaries and returns the best matches
with their ids. It can also filter by category or by a date range. Use
list_documents only to browse everything with no particular query. Use
get_document to read one document's full text by its id.

The first time you read a document, call save_extraction with a category, a
one-line summary, and any important dates you find (due dates, expirations,
appointment dates). Confirm what you did in one sentence.`;

const BUILDER_AGENT_PROMPT = `You build small custom web tools for the family.
When you get a request, call start_build exactly once with a clear one-line
description of the tool to make (rephrase the user's ask into "Build a tool
to …"). You do not write any code yourself — start_build hands it to the
generator, which takes a minute. After calling it, tell the user in one
sentence that their tool is being built and will show up in the Tools tab.`;

export interface FamilyAgentDeps {
  /** Fire-and-forget: kick off generating a tool from this description. */
  startToolBuild?: (description: string) => void;
}

export function buildFamilyAgent(store: ScopedStore, deps: FamilyAgentDeps = {}) {
  const model = createLocalModel();

  const startBuild = tool(
    async ({ description }) => {
      deps.startToolBuild?.(description);
      return `Started building: ${description}. It will appear in the Tools tab shortly.`;
    },
    {
      name: "start_build",
      description: "Kick off generating a small web tool. Takes a one-line description of what to build.",
      schema: z.object({ description: z.string().min(3).describe("What to build, e.g. 'Build a tool to plan weekly meals'") }),
    }
  );

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
          "Handles creating, listing, searching, and completing family to-dos and reminders.",
        systemPrompt: TASK_AGENT_PROMPT,
        model,
        tools: makeTaskTools(store),
      },
      {
        name: "document-agent",
        description:
          "Searches the family's documents by keyword, reads one by id, and extracts its category, summary, and important dates.",
        systemPrompt: DOCUMENT_AGENT_PROMPT,
        model,
        tools: makeDocumentTools(store),
      },
      {
        name: "builder-agent",
        description:
          "Generates a small custom web tool (checklist, planner, tracker, calculator, form) to help do a task the other agents can't.",
        systemPrompt: BUILDER_AGENT_PROMPT,
        model,
        tools: [startBuild],
      },
    ],
  });
}

export type FamilyAgent = ReturnType<typeof buildFamilyAgent>;

// A malformed final message that never resolved into clean prose — the
// model tried to emit a tool call but the generation broke down into raw
// syntax fragments instead of going through an actual tool_calls field.
// Observed directly: `call:task{description:<|"|>...<tool_call|>` as the
// literal final-message content. Treated the same as an empty response.
const LOOKS_MALFORMED = /<\|.*?\|>|<tool_call|subagent_type\s*:|^call:/i;

// Small local models occasionally return an empty, or garbled, final
// message with no clean tool call on the first try (both observed in
// testing — see docs/BUILD_LOG.md and docs/DECISIONS.md). One retry clears
// most of those. Kept even after switching to gemma4:e2b, since the
// failure mode is about small-model reliability in general, not specific
// to the model that first surfaced it.
export async function askFamilyAgent(
  agent: FamilyAgent,
  message: string,
  images: string[] = []
): Promise<string> {
  // Multimodal turn: gemma4:e2b (the default) takes text + images. The
  // planner sees them directly and can answer about a photo/screenshot, or
  // pull details out and delegate. Subagents only ever get a text
  // description, so an image never leaves the planner step.
  const content = images.length
    ? [
        { type: "text", text: message },
        ...images.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : message;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await agent.invoke({
      messages: [{ role: "user", content }],
    });
    const last = result.messages.at(-1);
    const text = last ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : "";
    if (text.trim() && !LOOKS_MALFORMED.test(text)) return text;
  }
  return "(the local model didn't return a clean response — try rephrasing, or check /activity for what it attempted)";
}
