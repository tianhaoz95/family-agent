import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "./config.js";
import { ChatMistralRs } from "./mistralrs/chatModel.js";

// The chat/planner model backend. ADDITIVE — modelProvider is a per-slot
// choice (see config.ts): OCR/embeddings keep their own independent
// Ollama-only settings regardless of what this is set to, so "mistralrs for
// chat, ollama for embeddings" is just two separate client constructions,
// not a special mode. Every call site that used to see a concrete
// `ChatOllama` now sees this union — all three classes satisfy the same
// LangChain BaseChatModel contract (bindTools + _generate), which is all
// deepagents/agents/index.ts and friends actually need.
export type LocalChatModel = ChatOllama | ChatOpenAI | ChatMistralRs;

export function createLocalModel(temperature = 0): LocalChatModel {
  switch (config.modelProvider) {
    case "openai":
      return new ChatOpenAI({
        model: config.openaiModel || config.model,
        temperature,
        apiKey: config.openaiApiKey || "not-needed",
        configuration: { baseURL: config.openaiBaseUrl || undefined },
      });
    case "mistralrs":
      return new ChatMistralRs({ temperature });
    case "ollama":
    default:
      return new ChatOllama({
        baseUrl: config.ollamaBaseUrl,
        model: config.model,
        temperature,
        // Keep the model loaded between turns so only the very first chat after
        // a cold start pays the load cost — see warmup.ts, which primes that.
        keepAlive: config.ollamaKeepAlive,
      });
  }
}
