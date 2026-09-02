import { describe, it, expect, vi } from "vitest";
import { askFamilyAgent } from "../src/agents/index.js";

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

  it("gives up after 2 attempts with a clear message, not a garbled one", async () => {
    const { agent } = stubAgent(["", ""]);
    const reply = await askFamilyAgent(agent, "hi");
    expect(reply).toContain("didn't return a clean response");
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
});
