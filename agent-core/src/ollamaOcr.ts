import { config } from "./config.js";

// Optional OCR path: hand a page image to a local Ollama vision model and get
// Markdown back. Uses Ollama's native /api/generate (not the OpenAI-compat
// /v1/chat) — the GLM-OCR maintainers note the compat layer is less reliable
// for vision. Still fully local: config.ollamaBaseUrl is localhost or a
// tailnet node, never a public host.

const OCR_PROMPT =
  "Transcribe this document page to Markdown. Reproduce all text exactly. " +
  "Render tables as Markdown tables and keep headings and lists. " +
  "Output only the document content — no preamble, no commentary.";

export async function ocrImageViaOllama(imagePng: Buffer, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${config.ollamaBaseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.ocrModel,
      prompt: OCR_PROMPT,
      images: [imagePng.toString("base64")],
      stream: false,
      options: { temperature: 0 },
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama OCR model "${config.ocrModel}" returned ${res.status} ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { response?: string };
  return (data.response ?? "").trim();
}

/**
 * Model names currently pulled into an Ollama instance, or null if it
 * couldn't be reached at all. Defaults to the configured Ollama, but takes
 * an explicit base URL so PUT /settings can validate a model against a *new*
 * Ollama address in the same request that changes it. Deduped.
 */
export async function listOllamaModels(baseUrl: string = config.ollamaBaseUrl): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`);
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = (data.models ?? []).flatMap((m) => [m.name, m.model].filter((x): x is string => !!x));
    return [...new Set(names)];
  } catch {
    return null;
  }
}

/** Tolerant match — Ollama tag lists sometimes carry ":latest", sometimes not. */
export function ollamaListHasModel(list: string[], model: string): boolean {
  const strip = (s: string) => s.replace(/:latest$/, "");
  return list.some((n) => n === model || strip(n) === strip(model));
}
