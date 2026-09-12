import { AIMessage, BaseMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ToolCall } from "@langchain/core/messages/tool";
import {
  loadNativeAddon,
  nativeAddonUnavailableReason,
  type ChatMessageInput,
  type ToolSpecInput,
} from "./nativeAddon.js";
import { ensureMistralRsLoaded, getMistralRsStatus } from "./manager.js";

interface ChatMistralRsCallOptions extends BaseChatModelCallOptions {
  tools?: ToolSpecInput[];
}

interface OpenAIToolShape {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

function safeParseJson(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function contentToString(content: BaseMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function toWireMessage(m: BaseMessage): ChatMessageInput {
  const content = contentToString(m.content);
  if (m instanceof ToolMessage) {
    return { role: "tool", content, toolCallId: m.tool_call_id };
  }
  if (m instanceof AIMessage) {
    const toolCalls = m.tool_calls?.length
      ? m.tool_calls.map((tc) => ({
          id: tc.id ?? "",
          name: tc.name,
          argumentsJson: JSON.stringify(tc.args ?? {}),
        }))
      : undefined;
    return { role: "assistant", content, toolCalls };
  }
  if (m instanceof SystemMessage) return { role: "system", content };
  // HumanMessage, and anything else, is treated as a user turn.
  return { role: "user", content };
}

/**
 * mistral.rs, embedded as a Rust library via the mistralrs-node native
 * addon (native/mistralrs-node/) — NOT an HTTP client to a spawned
 * mistralrs-server. See config.ts's "Chat/planner model provider" section
 * and native/mistralrs-node/src/lib.rs for the full story.
 *
 * Mirrors @langchain/ollama's ChatOllama contract closely enough that
 * agents/index.ts and every other model.ts consumer can treat this
 * interchangeably (see model.ts's LocalChatModel union).
 */
export class ChatMistralRs extends BaseChatModel<ChatMistralRsCallOptions> {
  temperature: number;

  constructor(fields: BaseChatModelParams & { temperature?: number }) {
    super(fields);
    this.temperature = fields.temperature ?? 0;
  }

  static lc_name(): string {
    return "ChatMistralRs";
  }

  _llmType(): string {
    return "mistralrs";
  }

  bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<ChatMistralRsCallOptions>
  ): ReturnType<NonNullable<BaseChatModel<ChatMistralRsCallOptions>["bindTools"]>> {
    const wireTools: ToolSpecInput[] = tools.map((t) => {
      const converted = convertToOpenAITool(t) as OpenAIToolShape;
      return {
        name: converted.function.name,
        description: converted.function.description,
        parametersJson: JSON.stringify(converted.function.parameters ?? {}),
      };
    });
    return this.withConfig({ tools: wireTools, ...kwargs } as Partial<ChatMistralRsCallOptions>);
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const addon = loadNativeAddon();
    if (!addon) {
      throw new Error(nativeAddonUnavailableReason() ?? "mistral.rs native addon is not available on this platform");
    }
    await ensureMistralRsLoaded();
    const status = getMistralRsStatus();
    if (status.status !== "ready") {
      const detail = status.error ? `: ${status.error}` : "";
      throw new Error(`mistral.rs model is not ready (status: ${status.status}${detail})`);
    }

    const tools = options.tools?.length ? options.tools : undefined;
    const result = await addon.chatCompletion({
      messages: messages.map(toWireMessage),
      tools,
      toolChoice: tools?.length ? "auto" : undefined,
      temperature: this.temperature,
    });

    const toolCalls: ToolCall[] = result.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: safeParseJson(tc.argumentsJson),
      type: "tool_call",
    }));

    // When the model made tool calls, mistral.rs's own `content` still
    // carries the model's raw tool-call markup (e.g. Qwen's
    // "<tool_call>{...}</tool_call>" text) alongside the already-parsed
    // structured tool_calls — confirmed against a real model. That's
    // redundant/confusing to show, and doesn't match how deepagents/
    // LangChain expect a tool-calling turn to look (empty content), so it's
    // dropped here rather than surfaced twice.
    const message = new AIMessage({
      content: toolCalls.length ? "" : result.content ?? "",
      tool_calls: toolCalls.length ? toolCalls : undefined,
    });

    return {
      generations: [{ message, text: result.content ?? "" }],
    };
  }
}
