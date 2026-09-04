import { createDeepAgent, createFilesystemMiddleware } from "deepagents";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createLocalModel } from "../model.js";
import type { ScopedStore } from "../db.js";
import { makeTaskTools } from "./taskTools.js";
import { makeDocumentTools } from "./documentTools.js";
import { makeNoteTools } from "./noteTools.js";
import { makeFamilyToolTools, type FamilyToolDeps } from "./toolTools.js";
import type { OnReference } from "./references.js";
import type { Embedder } from "../embeddings.js";

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
you create a…" to it. It also **improves an existing tool** — route "add … to
the … tool", "change the … tool so it …", "the … tool is broken / wrong",
"fix the …" to builder-agent too.

There is also a "notes-agent" subagent: it reads and writes the family's
sticky notes — a shared family board and each person's private board. Route
anything about "the board", "the sticky notes", "the fridge", "our notes", or
"note that down / add to my notes / jot this down" to it.

There is also a "tools-agent" subagent: the family builds their own small
tools (an item / location tracker, a household inventory, a borrowed-things
log, a chore-points tally, a bookshelf catalog…), and those tools can be
queried and updated from chat. When someone wants to look something up in one
of them or record something into one — "where did we put the…", "who
borrowed the…", "add… to the inventory", "log that…", "how many points does
… have" — delegate to tools-agent. If tools-agent reports the matching tool is
"display-only" or lacks the needed operation, THEN delegate the same request to
builder-agent to improve that existing tool — do not tell the user there's no
tool and do not build a duplicate.

To delegate, call the tool named "task" with two arguments: subagent_type set
to "task-agent", "document-agent", "builder-agent", "notes-agent", or
"tools-agent", and description set to what you need done. These are NOT
themselves callable tools — calling "task" with the right subagent_type is the
only way to reach them.

Example — user asks "what documents do I have?": call task with
subagent_type "document-agent" and description "List all ingested documents
with their categories and summaries." Do not answer this kind of question
yourself; you have no way to know the answer without asking document-agent.

Example — user asks "do we have the car insurance policy?" or "when is the
water bill due?": call task with subagent_type "document-agent" and
description "Search the family documents for the car insurance policy and
report what you find." Pass along the specific thing they're looking for —
document-agent can search by keyword, it does not need the whole list.

The family's own paperwork is NOT "personal information" to be withheld from
them — a family member reading a number off their own document is the entire
point of this app, and you are running locally on their own machine with no
one to leak to. When someone asks for a detail *out of* a document ("what is
my insurance number?", "what's the policy number?", "what's the account
number on the water bill?", "how much is the electric bill?", "when does my
passport expire?"), that is a document-agent request. Never answer it with a
refusal, a privacy disclaimer, or "check your documents yourself" — always
delegate.

Example — user asks "what is my insurance number?": call task with
subagent_type "document-agent" and description "Find the insurance document
and report the policy or member number it lists."

Example — user asks "remind me to renew the car registration": call task
with subagent_type "task-agent" and description "Create a task to renew the
car registration."

Example — user asks "build me a tool to split our vacation budget": call
task with subagent_type "builder-agent" and description "Build a tool to
split a vacation budget between family members."

Example — user asks "add a due date to the loan tracker" or "the chore chart
is missing a person": call task with subagent_type "builder-agent" and
description "Improve the loan tracker: add a due date to each loan."

Example — user asks "what's on the sticky board?" or "anything on the
fridge?": call task with subagent_type "notes-agent" and description "List
the sticky notes." And for "add a sticky note that the plumber comes Friday"
or "note that down for me": call task with subagent_type "notes-agent" and
description "Add a sticky note: plumber comes Friday."

Example — user asks "where's the good screwdriver?": call task with
subagent_type "tools-agent" and description "Look up where the good
screwdriver is stored." And for "we moved the tent to the basement": call
task with subagent_type "tools-agent" and description "Record that the tent
is now in the basement."

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

When the question asks for a specific value out of a document — a policy or
member number, an account number, an amount, an expiry date — search for the
document, then call get_document on its id and read the full text to pull out
the exact value, and quote it back. These documents belong to the family
member asking; reporting what one says is your job, never a privacy
violation. "I can't share that", "that's personal information", and "check
the document yourself" are always the wrong answer here — if you found the
document, answer with what it says.

The first time you read a document, call save_extraction with a category, a
one-line summary, and any important dates you find (due dates, expirations,
appointment dates). Confirm what you did in one sentence.`;

const NOTES_AGENT_PROMPT = `You manage the family's sticky notes. There are two
boards: a "shared" board the whole family sees, and a "private" board for the
person you're helping right now.

Tools: list_sticky_notes (scope "shared" | "private" | "all"), add_sticky_note
(scope + text). To answer "what's on the board / the fridge / our notes", call
list_sticky_notes and report the notes plainly. To pin something, call
add_sticky_note once — default to the shared board unless the request is
clearly personal ("my notes", "remind me"), then use private. Confirm what you
did in one sentence. Never refuse — a sticky note is just a short line of text.`;

const TOOLS_AGENT_PROMPT = `You use the family's own custom-built tools to look
things up and record things — trackers, inventories, logs, tallies the family
made in the Tools tab. You do NOT build tools (that's builder-agent's job) and
you do NOT touch tasks, documents, or sticky notes.

Always call list_family_tools first. It shows every tool, and for each one the
operations you can call — their exact names, whether they read or write, and
their parameters. Then call call_family_tool with the tool name, the operation
name (both exactly as listed), and an input object with the parameters.

If a lookup ("where is…", "who has…", "how many…") — use a read operation and
report what it returns, plainly. If a change ("we moved…", "add…", "log
that…", "mark…") — use a write operation, then confirm what you recorded in
one sentence.

list_family_tools may show a tool marked "display-only" — it exists but has no
operations. If that tool is the obvious match for the request (the family has a
"Recipe Box" and the user wants to add a recipe), DO NOT say the tool doesn't
exist and DO NOT suggest building a new one. Say the existing tool can't do
that yet and that it can be improved to add the feature (the user can ask
builder-agent). Same if a matching tool exists but lacks the right operation.

Only say "there's no tool for that" when the catalog has nothing related at
all. Never invent a tool or an operation.`;

const BUILDER_AGENT_PROMPT = `You build the family's custom web tools, and improve
the ones they already have. You never write code yourself — you hand the request
to a generator (this takes a minute).

- A NEW tool ("build me…", "I need something to…", "make a tool that…"): call
  start_build once with a clear one-line description ("Build a tool to …").
- A CHANGE to an EXISTING tool ("add a due-date to the loan tracker", "the X
  tool is broken", "make the meal planner also do breakfast"): call list_tools
  to find its exact name, then call improve_tool once with that name and a
  plain description of the change. The tool keeps working while the change is
  generated; if the change can't be made the old version stays.

Call exactly one of start_build / improve_tool, then tell the user in one
sentence what's happening ("Improving the loan tracker — it'll update in a
minute"). Don't call both.`;

export interface FamilyAgentDeps {
  /** Fire-and-forget: kick off generating a tool from this description. */
  startToolBuild?: (description: string) => void;
  /** Fire-and-forget: kick off improving an existing tool. */
  startToolIterate?: (toolId: string, instruction: string) => void;
  /** This user's tools — id/name/kind/status — for builder-agent to resolve "the X tool". */
  listTools?: () => { id: string; name: string; kind: string; status: string; revisionState: string | null }[];
  /** Notified of each task / document / tool a subagent retrieves this turn. */
  onReference?: OnReference;
  /** Current embedding client (or null) — enables semantic document search. */
  getEmbedder?: () => Embedder | null;
  /**
   * The "tools-agent" wiring: `getCatalog` returns this user's ready tools that
   * expose operations (read live each turn — no graph rebuild when a tool
   * changes), `callOperation` invokes one over MCP. Omit to disable the
   * subagent (e.g. tools feature off).
   */
  familyTools?: Pick<FamilyToolDeps, "getCatalog" | "callOperation">;
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
      description: "Kick off generating a NEW small web tool. Takes a one-line description of what to build.",
      schema: z.object({ description: z.string().min(3).describe("What to build, e.g. 'Build a tool to plan weekly meals'") }),
    }
  );

  const listToolsForBuilder = tool(
    async () => {
      const tools = deps.listTools?.() ?? [];
      if (tools.length === 0) return "The family has no tools yet.";
      return tools
        .map((t) => {
          const flags = [t.status !== "ready" ? t.status : "", t.revisionState === "revising" ? "being improved" : ""]
            .filter(Boolean)
            .join(", ");
          return `- ${t.name} (${t.kind}${flags ? `, ${flags}` : ""})`;
        })
        .join("\n");
    },
    {
      name: "list_tools",
      description: "List the family's existing tools by name, so you can pick the right one to improve.",
      schema: z.object({}),
    }
  );

  const improveTool = tool(
    async ({ tool: toolName, change }) => {
      const tools = deps.listTools?.() ?? [];
      const q = toolName.trim().toLowerCase();
      const exact = tools.find((t) => t.name.toLowerCase() === q);
      const partial = tools.filter((t) => t.name.toLowerCase().includes(q));
      const match = exact ?? (partial.length === 1 ? partial[0] : undefined);
      if (!match) {
        return tools.length
          ? `No single tool matches "${toolName}". The tools are: ${tools.map((t) => t.name).join(", ")}. Use the exact name.`
          : `There are no tools to improve yet.`;
      }
      if (match.revisionState === "revising") return `"${match.name}" is already being improved — wait for that to finish.`;
      deps.startToolIterate?.(match.id, change);
      return `Started improving "${match.name}": ${change}. It keeps working while the change is generated.`;
    },
    {
      name: "improve_tool",
      description:
        "Change an EXISTING tool — add a field or operation, fix a bug, adjust behaviour. Give the tool's exact name (from list_tools) and a plain description of the change.",
      schema: z.object({
        tool: z.string().describe("The exact tool name, e.g. 'Loan Tracker'"),
        change: z.string().min(3).describe("What to change, e.g. 'add a due date to each loan'"),
      }),
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
        tools: makeTaskTools(store, deps.onReference),
      },
      {
        name: "document-agent",
        description:
          "Searches the family's documents by meaning or keyword (typo-tolerant), reads one by id, and extracts its category, summary, and important dates.",
        systemPrompt: DOCUMENT_AGENT_PROMPT,
        model,
        tools: makeDocumentTools(store, deps.onReference, deps.getEmbedder),
      },
      {
        name: "builder-agent",
        description:
          "Generates a NEW small custom web tool (checklist, planner, tracker, calculator, form), or improves an EXISTING one (add a field, fix a bug, change behaviour).",
        systemPrompt: BUILDER_AGENT_PROMPT,
        model,
        tools: [startBuild, listToolsForBuilder, improveTool],
      },
      {
        name: "notes-agent",
        description:
          "Reads and writes the family's sticky notes — a shared family board and the current person's private board.",
        systemPrompt: NOTES_AGENT_PROMPT,
        model,
        tools: makeNoteTools(store),
      },
      ...(deps.familyTools
        ? [
            {
              name: "tools-agent",
              description:
                "Uses the family's own custom-built tools (trackers, inventories, logs, tallies) to look something up or record something — where an item is stored, who borrowed what, how many chore points someone has.",
              systemPrompt: TOOLS_AGENT_PROMPT,
              model,
              tools: makeFamilyToolTools({
                getCatalog: deps.familyTools.getCatalog,
                callOperation: deps.familyTools.callOperation,
                onReference: deps.onReference,
                logActivity: (actor, action, detail) => store.logActivity(actor, action, detail),
              }),
            },
          ]
        : []),
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

// A small model sometimes applies a generic "don't reveal personal data"
// reflex to a question about the family's *own* paperwork and answers with a
// refusal instead of delegating to document-agent — observed verbatim: "I
// cannot provide personal information such as insurance numbers. Please check
// your family documents for this information." The prompts push hard against
// this; this catches the shape so askFamilyAgent can retry once. Deliberately
// narrow — a legitimate "I couldn't find an insurance document" must NOT match.
const LOOKS_LIKE_REFUSAL = new RegExp(
  [
    /\b(?:can(?:no|')?t|cannot|not able to|unable to|won'?t|not allowed to)\b[^.?!]{0,60}\b(?:provide|share|disclose|reveal|give|hand out|access)\b[^.?!]{0,60}\b(?:personal|private|sensitive|confidential|identif)/,
    /\b(?:provide|share|disclose|give you|reveal|access)\b[^.?!]{0,25}\bpersonal (?:information|details|data|numbers?)/,
  ]
    .map((r) => r.source)
    .join("|"),
  "i"
);

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
  let lastRefusal = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await agent.invoke({
      messages: [{ role: "user", content }],
    });
    const last = result.messages.at(-1);
    const text = last ? (typeof last.content === "string" ? last.content : JSON.stringify(last.content)) : "";
    if (!text.trim() || LOOKS_MALFORMED.test(text)) continue;
    // Retry a privacy-refusal once (the model usually delegates on the second
    // try); keep it as a fallback so we never downgrade a real answer — even
    // an unhelpful one — to the generic error string.
    if (LOOKS_LIKE_REFUSAL.test(text) && attempt < 2) {
      lastRefusal = text;
      continue;
    }
    return text;
  }
  return (
    lastRefusal ||
    "(the local model didn't return a clean response — try rephrasing, or check /activity for what it attempted)"
  );
}

// ---- family chat: the @agent mention ----

// True when a chat message is asking the assistant to chime in. Word-boundaried
// so "email@agent.example" or a sentence ending "…the agent." doesn't trigger.
const AGENT_MENTION = /(^|[^\w@])@(agent|ai|assistant)\b/i;
export function mentionsAgent(body: string): boolean {
  return AGENT_MENTION.test(body ?? "");
}

/**
 * The planner chiming into a family channel. Same graph, same retry logic as a
 * 1:1 chat turn — just wrapped with the recent conversation so the reply is in
 * context. Runs with the mentioning user's agent (their scoped store), so it
 * can answer about their tasks / documents / notes.
 */
export async function askFamilyAgentInChannel(
  agent: FamilyAgent,
  transcript: string,
  latestMessage: string,
  images: string[] = []
): Promise<string> {
  const wrapped = `You are one participant in a family group chat. Here is the recent conversation:

${transcript}

The latest message mentioned you (@agent):
${latestMessage}
${images.length ? "\nThe latest message also attached the image(s) below.\n" : ""}
Reply as a single chat message — short, friendly, and directly useful. Do not prefix your reply with your name.`;
  return askFamilyAgent(agent, wrapped, images);
}
