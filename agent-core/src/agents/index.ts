import { createDeepAgent } from "deepagents";
import { createLocalModel } from "../model.js";
import type { Store } from "../db.js";
import { makeTaskTools } from "./taskTools.js";
import { makeDocumentTools } from "./documentTools.js";

const PLANNER_PROMPT = `You are the coordinating agent for a local-first family
organization assistant. You never see raw documents or personal detail yourself
if you can help it — delegate to the "task-agent" subagent for anything to do
with to-dos/reminders, and to the "document-agent" subagent for anything to do
with reading or classifying a document. Keep replies short and concrete. If a
request needs no tool (a plain question), answer directly.`;

const TASK_AGENT_PROMPT = `You manage the family's task list. Use create_task,
list_tasks, and complete_task as needed. Confirm what you did in one sentence.`;

const DOCUMENT_AGENT_PROMPT = `You read family documents and extract structured
fields from them. Use get_document to read the document text, then always call
save_extraction with a category, a one-line summary, and any important dates
you find (due dates, expirations, appointment dates). Confirm what you saved in
one sentence.`;

export function buildFamilyAgent(store: Store) {
  const model = createLocalModel();

  return createDeepAgent({
    name: "family-planner",
    model,
    systemPrompt: PLANNER_PROMPT,
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
// tool call on the first try (observed in testing with qwen2.5:3b, not
// hypothetical — see docs/BUILD_LOG.md). One retry clears most of those.
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
