import { ChatOllama } from "@langchain/ollama";
import { config } from "./config.js";

// Every agent in this app resolves to a local model unless a future grant
// explicitly swaps this out for a cloud-backed ChatModel. There is no such
// grant wired up yet — see docs/DECISIONS.md.
export function createLocalModel(temperature = 0): ChatOllama {
  return new ChatOllama({
    baseUrl: config.ollamaBaseUrl,
    model: config.model,
    temperature,
    // Keep the model loaded between turns so only the very first chat after
    // a cold start pays the load cost — see warmup.ts, which primes that.
    keepAlive: config.ollamaKeepAlive,
  });
}
