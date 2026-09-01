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
}

export interface ActivityEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  detail: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
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

export const api = {
  health: () => request<{ ok: boolean; model: string; inboxDir: string }>("/health"),
  getSettings: () => request<Settings>("/settings"),
  updateSettings: (inboxDir: string) =>
    request<Settings>("/settings", { method: "PUT", body: JSON.stringify({ inboxDir }) }),
  chat: (message: string) => request<{ reply: string }>("/chat", { method: "POST", body: JSON.stringify({ message }) }),
  listTasks: () => request<{ tasks: Task[] }>("/tasks"),
  createTask: (title: string, dueDate?: string) =>
    request<{ task: Task }>("/tasks", { method: "POST", body: JSON.stringify({ title, dueDate: dueDate || undefined }) }),
  completeTask: (id: string) =>
    request<{ task: Task }>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) }),
  listDocuments: () => request<{ documents: Document[] }>("/documents"),
  ingestDocument: (filename: string, text: string) =>
    request<{ document: Document }>("/documents/ingest", { method: "POST", body: JSON.stringify({ filename, text }) }),
  uploadDocument: (file: File) => upload<{ document: Document }>("/documents/upload", file),
  listActivity: () => request<{ activity: ActivityEntry[] }>("/activity"),
};
