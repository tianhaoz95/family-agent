//! Native Node addon embedding mistral.rs as a library.
//!
//! Deliberately does NOT spawn `mistralrs-server`/`mistralrs serve` as a
//! child process — agent-core loads this addon in-process (`require()`,
//! same shape as onnxruntime-node for ASR/TTS in this codebase) and calls
//! straight into mistral.rs's own Rust API. There's exactly one model
//! resident at a time, guarded by a mutex behind a process-wide OnceLock —
//! agent-core is a single Node process per install, so a global is the
//! right level of "one instance", matching ToolSupervisor/McpManager/
//! RoutineScheduler elsewhere in this codebase.
//!
//! Wire shapes deliberately stay primitive (strings for JSON blobs) rather
//! than mapping `serde_json::Value` across the N-API boundary — it keeps
//! this file's surface small and avoids taking on the `napi` crate's
//! serde-json feature.

use std::collections::HashMap;

use mistralrs::{
    CalledFunction, DeviceMapSetting, Function, GgufModelBuilder, IsqBits, Model, ModelBuilder,
    RequestBuilder, TextMessageRole, Tool, ToolCallResponse, ToolCallType, ToolChoice, ToolType,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;
use tokio::sync::Mutex;

static MODEL: std::sync::OnceLock<Mutex<Option<Model>>> = std::sync::OnceLock::new();

fn model_cell() -> &'static Mutex<Option<Model>> {
    MODEL.get_or_init(|| Mutex::new(None))
}

fn napi_err(e: impl std::fmt::Display) -> Error {
    Error::from_reason(e.to_string())
}

#[napi(object)]
pub struct LoadModelOptions {
    /// Hugging Face repo id, or a local model directory path.
    pub model_id: String,
    /// GGUF filename within `model_id`'s repo. Omit to load a full-precision
    /// / safetensors model instead, quantized on the fly via `isq_bits`.
    pub gguf_file: Option<String>,
    /// In-situ quantization width in bits (e.g. 4 or 8) for the non-GGUF
    /// path. Ignored when `gguf_file` is set (the GGUF file is already
    /// quantized).
    pub isq_bits: Option<u32>,
}

/// Loads (or replaces) the resident model. Blocking/slow — this downloads
/// the model on first use and can take a while; call it once at startup or
/// on a provider/model settings change, not per chat turn.
#[napi]
pub async fn load_model(opts: LoadModelOptions) -> Result<()> {
    let model = if let Some(gguf_file) = opts.gguf_file {
        GgufModelBuilder::new(opts.model_id, vec![gguf_file])
            .with_logging()
            // mistral.rs's *automatic* device mapping probes available
            // device memory to decide how to split layers across devices —
            // and that probe reads 0 available bytes on at least one real
            // Mac this was tested on (confirmed not a sandboxing artifact:
            // plain `sysctl`/`vm_stat`/Node's os.freemem() all read normal
            // values in the same process), which makes it refuse to load
            // ANY model, full stop, regardless of how much RAM is actually
            // free. A manual "dummy" device map (single device, no capacity
            // math at all) sidesteps that broken probe entirely — this app
            // targets a home laptop, not a multi-GPU rig, so "just load it,
            // no fancy cross-device splitting" is a reasonable default
            // outright, not just a workaround. Metal/CUDA acceleration is a
            // follow-up (this still runs on CPU as a result, for now).
            .with_device_mapping(DeviceMapSetting::dummy())
            .build()
            .await
            .map_err(napi_err)?
    } else {
        let mut builder = ModelBuilder::new(opts.model_id).with_logging();
        let bits = match opts.isq_bits {
            Some(4) => IsqBits::Four,
            _ => IsqBits::Eight,
        };
        builder = builder.with_auto_isq(bits);
        builder.build().await.map_err(napi_err)?
    };
    let mut guard = model_cell().lock().await;
    *guard = Some(model);
    Ok(())
}

#[napi]
pub async fn is_loaded() -> bool {
    model_cell().lock().await.is_some()
}

#[napi]
pub async fn unload_model() -> Result<()> {
    *model_cell().lock().await = None;
    Ok(())
}

#[napi(object)]
pub struct ToolCallInput {
    pub id: String,
    pub name: String,
    /// The tool's arguments, as a JSON-encoded string (matches how the
    /// model itself emits them, and how LangChain's AIMessage.tool_calls
    /// round-trips through this addon).
    pub arguments_json: String,
}

#[napi(object)]
pub struct ChatMessageInput {
    /// "system" | "user" | "assistant" | "tool"
    pub role: String,
    pub content: Option<String>,
    /// Required when role == "tool": which prior tool call this is a result for.
    pub tool_call_id: Option<String>,
    /// Set on an "assistant" message that itself made tool calls, so the
    /// conversation history replays correctly on the next turn.
    pub tool_calls: Option<Vec<ToolCallInput>>,
}

#[napi(object)]
pub struct ToolSpecInput {
    pub name: String,
    pub description: Option<String>,
    /// JSON Schema object, as a JSON-encoded string.
    pub parameters_json: String,
}

#[napi(object)]
pub struct ChatCompletionRequestInput {
    pub messages: Vec<ChatMessageInput>,
    pub tools: Option<Vec<ToolSpecInput>>,
    /// "auto" | "none" | "required". Defaults to "auto" when tools are set.
    pub tool_choice: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

#[napi(object)]
pub struct ChatCompletionResultOutput {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCallInput>,
    pub prompt_tokens_per_sec: Option<f64>,
    pub completion_tokens_per_sec: Option<f64>,
}

fn parse_role(role: &str) -> Result<TextMessageRole> {
    match role {
        "system" => Ok(TextMessageRole::System),
        "user" => Ok(TextMessageRole::User),
        "assistant" => Ok(TextMessageRole::Assistant),
        "tool" => Ok(TextMessageRole::Tool),
        other => Err(napi_err(format!("unknown chat role: {other}"))),
    }
}

#[napi]
pub async fn chat_completion(req: ChatCompletionRequestInput) -> Result<ChatCompletionResultOutput> {
    let guard = model_cell().lock().await;
    let model = guard
        .as_ref()
        .ok_or_else(|| napi_err("mistral.rs model not loaded — call loadModel() first"))?;

    let mut rb = RequestBuilder::new();
    for m in req.messages {
        let role = parse_role(&m.role)?;
        if m.role == "tool" {
            let tool_call_id = m
                .tool_call_id
                .ok_or_else(|| napi_err("a \"tool\" message requires tool_call_id"))?;
            rb = rb.add_tool_message(m.content.unwrap_or_default(), tool_call_id);
        } else if let Some(tool_calls) = m.tool_calls {
            let calls: Vec<ToolCallResponse> = tool_calls
                .into_iter()
                .enumerate()
                .map(|(index, tc)| ToolCallResponse {
                    index,
                    id: tc.id,
                    tp: ToolCallType::Function,
                    function: CalledFunction {
                        name: tc.name,
                        arguments: tc.arguments_json,
                    },
                })
                .collect();
            rb = rb.add_message_with_tool_call(role, m.content.unwrap_or_default(), calls);
        } else {
            rb = rb.add_message(role, m.content.unwrap_or_default());
        }
    }

    if let Some(tools) = req.tools {
        let mistral_tools = tools
            .into_iter()
            .map(|t| -> Result<Tool> {
                let params: HashMap<String, Value> = serde_json::from_str(&t.parameters_json)
                    .map_err(|e| napi_err(format!("bad tool parameters JSON for {}: {e}", t.name)))?;
                Ok(Tool {
                    tp: ToolType::Function,
                    function: Function {
                        description: t.description,
                        name: t.name,
                        parameters: Some(params),
                    },
                })
            })
            .collect::<Result<Vec<_>>>()?;
        rb = rb.set_tools(mistral_tools);
        // This pinned mistralrs-core version's ToolChoice has no "required"
        // variant (only None/Auto/a single forced Tool) — "required" from the
        // JS side degrades to "auto" rather than erroring.
        let choice = match req.tool_choice.as_deref() {
            Some("none") => ToolChoice::None,
            _ => ToolChoice::Auto,
        };
        rb = rb.set_tool_choice(choice);
    }

    if let Some(t) = req.temperature {
        rb = rb.set_sampler_temperature(t);
    }
    if let Some(n) = req.max_tokens {
        rb = rb.set_sampler_max_len(n as usize);
    }

    let response = model.send_chat_request(rb).await.map_err(napi_err)?;
    let choice0 = response
        .choices
        .first()
        .ok_or_else(|| napi_err("mistral.rs returned no choices"))?;
    let message = &choice0.message;

    let tool_calls = message
        .tool_calls
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|tc| ToolCallInput {
            id: tc.id,
            name: tc.function.name,
            arguments_json: tc.function.arguments,
        })
        .collect();

    Ok(ChatCompletionResultOutput {
        content: message.content.clone(),
        tool_calls,
        prompt_tokens_per_sec: Some(response.usage.avg_prompt_tok_per_sec as f64),
        completion_tokens_per_sec: Some(response.usage.avg_compl_tok_per_sec as f64),
    })
}
