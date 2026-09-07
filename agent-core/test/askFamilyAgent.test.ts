import { describe, it, expect, vi } from "vitest";
import { askFamilyAgent, buildPlannerPrompt } from "../src/agents/index.js";

// Fast, deterministic coverage of the retry logic itself — the live-model
// tests in agents.integration.test.ts prove the real thing works, but
// can't reliably exercise "what happens on a malformed/empty reply" since
// that depends on when the model happens to misbehave.
function stubAgent(replies: string[]) {
  let call = 0;
  const invoke = vi.fn(async (_input: unknown) => {
    const content = replies[Math.min(call, replies.length - 1)];
    call++;
    return { messages: [{ content }] };
  });
  return { agent: { invoke } as any, invoke };
}

describe("askFamilyAgent retry logic", () => {
  it("returns a clean reply immediately without retrying", async () => {
    const { agent, invoke } = stubAgent(["All done."]);
    const reply = await askFamilyAgent(agent, "hi");
    expect(reply).toBe("All done.");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("retries once on an empty reply, then returns the retry's clean text", async () => {
    const { agent, invoke } = stubAgent(["", "Here you go."]);
    const reply = await askFamilyAgent(agent, "hi");
    expect(reply).toBe("Here you go.");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("retries on a reply that leaks raw tool-call syntax instead of prose", async () => {
    // Exact shape observed in testing against gemma4:e2b — see docs/DECISIONS.md.
    const malformed = 'call:task{description:<|"|>list all documents<|"|>,subagent_type:<|"|>document-agent<|"|>}<tool_call|>';
    const { agent, invoke } = stubAgent([malformed, "You have one document."]);
    const reply = await askFamilyAgent(agent, "what documents do I have?");
    expect(reply).toBe("You have one document.");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("retries once when the model refuses a question about the family's own documents", async () => {
    // Exact shape observed against gemma4:e2b — a privacy reflex applied to
    // the family's own paperwork instead of delegating to document-agent.
    const refusal =
      "I cannot provide personal information such as insurance numbers. Please check your family documents for this information.";
    const { agent, invoke } = stubAgent([refusal, "Your insurance member ID is 210284396, from insurance.pdf."]);
    const reply = await askFamilyAgent(agent, "what is my insurance number?");
    expect(reply).toBe("Your insurance member ID is 210284396, from insurance.pdf.");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps the refusal text as the answer if the retry also refuses (never the generic error)", async () => {
    const refusal = "I'm not able to share personal information like that.";
    const { agent, invoke } = stubAgent([refusal, refusal]);
    const reply = await askFamilyAgent(agent, "what is my insurance number?");
    expect(reply).toBe(refusal);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not treat a genuine 'no document found' answer as a refusal", async () => {
    const notFound = "I couldn't find any insurance document in your family documents.";
    const { agent, invoke } = stubAgent([notFound, "should not get here"]);
    const reply = await askFamilyAgent(agent, "what is my insurance number?");
    expect(reply).toBe(notFound);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("gives up after 2 attempts with a clear message, not a garbled one", async () => {
    const { agent } = stubAgent(["", ""]);
    const reply = await askFamilyAgent(agent, "hi");
    expect(reply).toContain("didn't return a clean response");
  });

  it("degrades gracefully when the model delegates to a subagent that isn't wired", async () => {
    // deepagents' `task` tool throws exactly this when subagent_type is unknown
    // (web access off → no research-agent, etc). Must NOT propagate as a 502.
    const invoke = vi.fn(async () => {
      throw new Error(
        "Error: invoked agent of type research-agent, the only allowed types are `task-agent`, `document-agent`"
      );
    });
    const reply = await askFamilyAgent({ invoke } as any, "what is the TSLA price?");
    expect(reply).toMatch(/research-agent.*isn't turned on/i);
    expect(invoke).toHaveBeenCalledTimes(1); // no pointless retry
  });

  it("re-throws a genuine model-connection error (so /chat can report it accurately)", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("request to http://127.0.0.1:11434/api/chat failed, reason: ECONNREFUSED");
    });
    await expect(askFamilyAgent({ invoke } as any, "hi")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("buildPlannerPrompt — only advertises wired subagents", () => {
  it("the base prompt names none of the optional subagents", () => {
    const base = buildPlannerPrompt({});
    expect(base).not.toMatch(/research-agent/);
    expect(base).not.toMatch(/workshop-agent/);
    expect(base).not.toMatch(/tools-agent/);
    // core ones are always there
    expect(base).toMatch(/task-agent/);
    expect(base).toMatch(/document-agent/);
  });

  it("adds a section only for each capability that's enabled", () => {
    expect(buildPlannerPrompt({ web: true })).toMatch(/research-agent/);
    expect(buildPlannerPrompt({ web: true })).not.toMatch(/workshop-agent/);
    expect(buildPlannerPrompt({ shell: true })).toMatch(/workshop-agent/);
    expect(buildPlannerPrompt({ tools: true })).toMatch(/tools-agent/);
    const all = buildPlannerPrompt({ web: true, shell: true, tools: true });
    expect(all).toMatch(/research-agent/);
    expect(all).toMatch(/workshop-agent/);
    expect(all).toMatch(/tools-agent/);
  });

  it("passes plain string content when there are no images", async () => {
    const { agent, invoke } = stubAgent(["ok"]);
    await askFamilyAgent(agent, "hello");
    expect(invoke.mock.calls[0][0]).toEqual({ messages: [{ role: "user", content: "hello" }] });
  });

  it("builds a multimodal content array when images are attached", async () => {
    const { agent, invoke } = stubAgent(["That's a cat."]);
    const img = "data:image/png;base64,AAAA";
    await askFamilyAgent(agent, "what is this?", [img]);
    expect(invoke.mock.calls[0][0]).toEqual({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: img } },
          ],
        },
      ],
    });
  });

  it("prepends prior session turns ahead of the current message", async () => {
    const { agent, invoke } = stubAgent(["Blue, like you said."]);
    const history = [
      { role: "user" as const, content: "my favorite color is blue" },
      { role: "assistant" as const, content: "Got it — blue." },
    ];
    await askFamilyAgent(agent, "what's my favorite color?", [], history);
    expect(invoke.mock.calls[0][0]).toEqual({
      messages: [...history, { role: "user", content: "what's my favorite color?" }],
    });
  });

  it("omitting history keeps the old single-message shape (no session yet)", async () => {
    const { agent, invoke } = stubAgent(["ok"]);
    await askFamilyAgent(agent, "hello", []);
    expect(invoke.mock.calls[0][0]).toEqual({ messages: [{ role: "user", content: "hello" }] });
  });
});
