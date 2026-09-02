// agent-core listens on the same machine; the desktop shell spawns it as a
// child process (see src-tauri/src/main.rs). Multi-user now: every request
// carries a bearer token from the logged-in family member, and a 401 drops
// the UI back to the login screen.
const BASE_URL = "http://127.0.0.1:4173";

// ---- session token ----
// localStorage is per-origin and survives restarts. Guarded because the test
// env (vitest "node") has no localStorage.
const TOKEN_KEY = "familyAgent.token";
let memoryToken: string | null = null;

export function getToken(): string | null {
  if (memoryToken) return memoryToken;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string): void {
  memoryToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore — memoryToken still holds it for this session */
  }
}
export function clearToken(): void {
  memoryToken = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Fired when the server rejects our token — main.ts listens and shows login. */
export const SIGNED_OUT_EVENT = "family-agent:signed-out";
function emitSignedOut() {
  try {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  } catch {
    /* no window (tests) */
  }
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "member";
}

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
  serverName: string;
  needsSetup: boolean;
  toolsPort: number;
  toolsEnabled: "full" | "static-only" | "off";
}

export interface AuthStatus {
  needsSetup: boolean;
  serverName: string;
}

function headersFor(hasBody: boolean): Record<string, string> | undefined {
  const h: Record<string, string> = {};
  if (hasBody) h["Content-Type"] = "application/json";
  const token = getToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return Object.keys(h).length ? h : undefined;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { ...headersFor(init?.body != null), ...(init?.headers as Record<string, string> | undefined) };
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    ...(Object.keys(headers).length ? { headers } : {}),
  });
  if (res.status === 401 && !path.startsWith("/auth/")) {
    clearToken();
    emitSignedOut();
  }
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
  ocrModel: string;
  serverName: string;
  isAdmin: boolean;
  /** Fields pinned by an env var — read-only in the UI. */
  envLocked: { model: boolean; ollamaBaseUrl: boolean; inboxDir: boolean; ocrModel: boolean; serverName: boolean };
}

export interface SettingsPatch {
  inboxDir?: string;
  model?: string;
  ollamaBaseUrl?: string;
  ocrModel?: string;
  serverName?: string;
}

// Separate from request() because a file upload must NOT set
// Content-Type: application/json — the browser sets multipart/form-data with
// its own boundary. Still needs the bearer token.
async function upload<T>(path: string, file: File): Promise<T> {
  const formData = new FormData();
  formData.append("file", file, file.name);
  const token = getToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (res.status === 401) {
    clearToken();
    emitSignedOut();
  }
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

  // ---- auth ----
  authStatus: () => request<AuthStatus>("/auth/status"),
  bootstrap: (body: { serverName?: string; username: string; displayName: string; password: string }) =>
    request<{ token: string; user: User }>("/auth/bootstrap", { method: "POST", body: JSON.stringify(body) }),
  login: (username: string, password: string) =>
    request<{ token: string; user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, deviceLabel: "desktop" }),
    }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  me: () => request<{ user: User }>("/auth/me"),

  // ---- users (admin) ----
  listUsers: () => request<{ users: User[] }>("/users"),
  createUser: (body: { username: string; displayName: string; password: string; role: "admin" | "member" }) =>
    request<{ user: User }>("/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, patch: { displayName?: string; password?: string; role?: "admin" | "member" }) =>
    request<{ user: User }>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteUser: (id: string) => request<{ deleted: true }>(`/users/${id}`, { method: "DELETE" }),

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
