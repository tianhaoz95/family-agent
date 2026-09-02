import { config } from "./config.js";
import { PLANNER_PROMPT } from "./agents/index.js";

// Prime Ollama before the first real chat turn. One throwaway request that
// (1) loads the model into memory and (2) runs the planner system prompt
// through it, so Ollama's prefix KV cache already holds that ~700-token
// prefix. The user's first message then skips both the cold-load and the
// prefill — the two things that made the first interaction slow.
//
// Best-effort: any failure (Ollama not up yet, model still pulling, network
// blip) is logged and swallowed — the first turn is then just as slow as it
// used to be, nothing breaks. The deepagents planner appends its tool
// schemas after this prompt, and each subagent has its own system prompt;
// those tails still prefill on first use, but they're small next to the
// base prompt and the model itself is already resident by then.
export async function warmModel(signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "system", content: PLANNER_PROMPT }],
        stream: false,
        options: { num_predict: 1 },
        keep_alive: config.ollamaKeepAlive,
      }),
      signal,
    });
    if (!res.ok) {
      console.log(`model warmup skipped — Ollama returned ${res.status}`);
      return;
    }
    await res.json();
    console.log(`model "${config.model}" warmed in ${Date.now() - started}ms`);
  } catch (err) {
    console.log(`model warmup skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}
