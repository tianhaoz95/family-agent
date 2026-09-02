// agent-core always listens on localhost; the desktop shell spawns it as a
// child process (see src-tauri/src/main.rs). No tailnet/relay wiring yet —
// see docs/DECISIONS.md.
const BASE_URL = "http://127.0.0.1:4173";

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  status: "open" | "done";
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  id: string;
  filename: string;
  rawText: string;
  extracted: { category?: string; summary?: string; importantDates?: string[] } | null;
  createdAt: string;
  sourcePath: string | null;
  extractionStatus: "pending" | "done" | "failed";
}

export interface ActivityEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  detail: string;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  kind: "static" | "server";
  status: "building" | "ready" | "failed";
  error: string | null;
  createdAt: string;
  /** Path under the tools server, e.g. "/AB12CD34/". null until ready. */
  path: string | null;
}

export interface Health {
  ok: boolean;
  model: string;
  inboxDir: string;
  toolsPort: number;
  toolsEnabled: "full" | "static-only" | "off";
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send Content-Type: application/json when there's actually a JSON body.
  // Fastify rejects a bodyless request that still declares a JSON content-type
  // with 400 "Body cannot be empty" — which is every DELETE and the bodyless
  // retry POST.
  const headers = init?.body != null ? { "Content-Type": "application/json" } : undefined;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface Settings {
  inboxDir: string;
  model: string;
  ollamaBaseUrl: string;
  /** Ollama vision model used for OCR; "" means the built-in engine. */
  ocrModel: string;
  /** Fields pinned by an env var — read-only in the UI, and PUT /settings rejects changing them. */
  envLocked: { model: boolean; ollamaBaseUrl: boolean; inboxDir: boolean; ocrModel: boolean };
}

export interface SettingsPatch {
  inboxDir?: string;
  model?: string;
  ollamaBaseUrl?: string;
  ocrModel?: string;
}

// Separate from request() because a file upload must NOT set
// Content-Type: application/json — the browser needs to set
// multipart/form-data with its own boundary when given a FormData body.
async function upload<T>(path: string, file: File): Promise<T> {
  const formData = new FormData();
  formData.append("file", file, file.name);
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** The tools server runs on its own port next to agent-core. */
export function toolUrl(toolsPort: number, path: string): string {
  return `http://127.0.0.1:${toolsPort}${path}`;
}

export const api = {
  health: () => request<Health>("/health"),
  getSettings: () => request<Settings>("/settings"),
  updateSettings: (patch: SettingsPatch) =>
    request<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  listOllamaModels: () => request<{ models: string[]; reachable: boolean }>("/ollama/models"),
  chat: (message: string, images: string[] = []) =>
    request<{ reply: string }>("/chat", {
      method: "POST",
      body: JSON.stringify(images.length ? { message, images } : { message }),
    }),
  listTasks: () => request<{ tasks: Task[] }>("/tasks"),
  createTask: (title: string, dueDate?: string) =>
    request<{ task: Task }>("/tasks", { method: "POST", body: JSON.stringify({ title, dueDate: dueDate || undefined }) }),
  completeTask: (id: string) =>
    request<{ task: Task }>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) }),
  listDocuments: () => request<{ documents: Document[] }>("/documents"),
  ingestDocument: (filename: string, text: string) =>
    request<{ document: Document }>("/documents/ingest", { method: "POST", body: JSON.stringify({ filename, text }) }),
  uploadDocument: (file: File) => upload<{ document: Document }>("/documents/upload", file),
  deleteDocument: (id: string) => request<{ document: Document }>(`/documents/${id}`, { method: "DELETE" }),
  retryExtraction: (id: string) =>
    request<{ document: Document }>(`/documents/${id}/retry-extraction`, { method: "POST" }),
  listActivity: () => request<{ activity: ActivityEntry[] }>("/activity"),
  listTools: () => request<{ tools: Tool[] }>("/tools"),
  buildTool: (prompt: string) =>
    request<{ building: true; prompt: string }>("/tools", { method: "POST", body: JSON.stringify({ prompt }) }),
  deleteTool: (id: string) => request<{ deleted: true }>(`/tools/${id}`, { method: "DELETE" }),
};
