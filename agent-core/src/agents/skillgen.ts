import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ChatOllama } from "@langchain/ollama";

// Draft a SKILL.md from a plain-language description. Like agents/rename.ts and
// agents/extraction.ts this bypasses the deepagents planner — one mechanical
// model call whose output the user reviews and edits before it's saved.

const SYSTEM_PROMPT = `You write "skills" for a family's local AI assistant. A skill is a short markdown playbook the assistant follows for a recurring task.

Given a description, output ONLY the markdown body of the skill — no front-matter, no code fences around the whole thing, no preamble. Structure it as:

# <Skill title>

<One sentence on what this skill is for.>

## Steps

1. <concrete step>
2. <concrete step>
...

## Notes
- <anything the assistant should keep in mind>

Keep it under ~250 words. Be concrete and imperative. Refer to the assistant's other tools by name where relevant (create_task, search_documents, add_sticky_note, run_code, web_search). Do not invent capabilities.`;

/** Returns the markdown body (no front-matter). Null on failure. */
export async function generateSkillMarkdown(
  model: ChatOllama,
  input: { name: string; description: string }
): Promise<string | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await model.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(`Skill name: ${input.name}\nWhat it should do: ${input.description}`),
      ]);
      let text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
      text = text
        .replace(/^```(?:markdown|md)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
      if (text.length > 40 && /\n/.test(text)) return text;
    } catch {
      /* retry once */
    }
  }
  return null;
}
