// Local by default, cloud by explicit grant (see docs/DECISIONS.md).
// Nothing in this file reaches off-box; OLLAMA_BASE_URL always points at
// localhost or another node on the family tailnet, never a public host.
export const config = {
  port: Number(process.env.PORT ?? 4173),
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  // gemma3n:e2b was the requested test model, but Ollama rejects it for this
  // app's tool-calling agent loop ("does not support tools" — confirmed by
  // hand, not assumed). qwen2.5:3b is the smallest verified tool-calling
  // model swapped in instead; see docs/DECISIONS.md for the full story and
  // how to switch once a tool-calling-capable Gemma build is available.
  model: process.env.FAMILY_AGENT_MODEL ?? "qwen2.5:3b",
  dataDir: process.env.FAMILY_AGENT_DATA_DIR ?? new URL("../data", import.meta.url).pathname,
};

export function dbPath(): string {
  return `${config.dataDir}/family-agent.db`;
}
