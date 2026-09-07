// agent-core listens on the same machine; the desktop shell spawns it as a
// child process (see src-tauri/src/main.rs). Multi-user now: every request
// carries a bearer token from the logged-in family member, and a 401 drops
// the UI back to the login screen.
// Production/Tauri: agent-core is always the local sidecar on :4173.
// Override with VITE_API_BASE for `vite dev` / `vite preview` against a
// separate backend (e.g. a seeded dev instance on another port).
const BASE_URL = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:4173";

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
  /** 24-hour "HH:MM" when the task has a specific time; null = all-day. */
  dueTime: string | null;
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
  /** MIME of the stored original file (uploads), for the preview. null = none / not recorded. */
  originalMime: string | null;
  extractionStatus: "pending" | "done" | "failed";
}

/** One hit from GET /documents/search — a list row plus a match snippet. */
export interface DocumentSearchHit {
  id: string;
  filename: string;
  category: string | null;
  summary: string | null;
  snippet: string;
  createdAt: string;
  extractionStatus: "pending" | "done" | "failed";
}

/** One hit from GET /tasks/search. */
export interface TaskSearchHit {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  dueTime: string | null;
  status: "open" | "done";
  snippet: string;
}

/** A family member as shown in the chat / mention pickers (GET /family/members). */
export interface FamilyMember {
  id: string;
  username: string;
  displayName: string;
}

export interface ChannelMember {
  id: string;
  username: string;
  displayName: string;
}

export interface ChannelLastMessage {
  senderId: string;
  body: string;
  createdAt: string;
  pending: boolean;
}

export interface Channel {
  id: string;
  kind: "dm" | "group";
  name: string | null;
  createdBy: string;
  createdAt: string;
  members: ChannelMember[];
  /** Display title: group name, or the other member(s) for a DM. */
  title: string;
  lastMessage: ChannelLastMessage | null;
  unreadCount: number;
}

export interface Message {
  id: string;
  channelId: string;
  /** A user id, or "_agent_" for the assistant. */
  senderId: string;
  body: string;
  /** Image attachments as data URIs — same as the 1:1 chat composer. */
  images: string[];
  pending: boolean;
  createdAt: string;
}

/** senderId of an assistant message (mirrors AGENT_SENDER_ID server-side). */
export const AGENT_SENDER_ID = "_agent_";

// ---- chat sessions (private 1:1 assistant chat history) ----
export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessage: string | null;
  messageCount: number;
}

export interface ChatSessionMessage {
  id: string;
  role: "user" | "assistant";
  body: string;
  images: string[];
  refs: ChatReference[];
  createdAt: string;
}

export type NoteScope = "shared" | "private";

export interface StickyNote {
  id: string;
  scope: NoteScope;
  userId: string;
  text: string;
  color: string;
  /** Position on the corkboard, CSS px from its top-left. */
  x: number;
  y: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityEntry {
  id: string;
  ts: string;
  actor: string;
  action: string;
  detail: string;
}

// ---- scheduled routines ----
export type RoutineTrigger =
  | { kind: "cron"; expr: string }
  | { kind: "once"; at: string }
  | { kind: "every"; minutes: number };

export type RoutineAgentKind = "planner" | "task" | "document" | "notes" | "tools";

export interface RoutineAction {
  agent: RoutineAgentKind;
  instruction: string;
}

/** Friendly schedule fields sent to POST/PATCH /routines — exactly one is set. */
export interface RoutineTriggerInput {
  cron?: string;
  dailyAt?: string;
  weeklyOn?: string;
  weeklyAt?: string;
  monthlyDay?: number;
  monthlyAt?: string;
  onceAt?: string;
  everyMinutes?: number;
}

export type RoutineRunStatus = "running" | "ok" | "error" | "skipped";

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: RoutineTrigger;
  /** Human sentence for the schedule, e.g. "every day at 7:00 AM". */
  triggerText: string;
  action: RoutineAction;
  deliverChannelId: string | null;
  catchUp: "skip" | "run";
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: RoutineRunStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RoutineRunStatus;
  trigger: "schedule" | "manual" | "catchup";
  output: string | null;
  error: string | null;
}

export interface RoutineInput {
  name: string;
  trigger: RoutineTriggerInput;
  action: RoutineAction;
  deliverChannelId?: string | null;
  catchUp?: "skip" | "run";
  enabled?: boolean;
}

/** Something the assistant used while answering — rendered as a clickable chip.
 *  "link" is a web page the research agent opened (`id` is the URL). */
export interface ChatReference {
  type: "document" | "task" | "tool" | "link";
  id: string;
  label: string;
}

/** An operation a server tool exposes to the chat assistant (its MCP tools/list). */
export interface ToolOperation {
  name: string;
  description: string;
  access: "read" | "write";
  inputSchema: { type?: string; properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  kind: "static" | "server";
  status: "building" | "ready" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string | null;
  /** How many times the tool has been improved. */
  revisionCount: number;
  /** null = idle · "revising" = an improve is running · else = why the last improve failed. */
  revisionState: string | null;
  /** True when there's a snapshot to roll back to (one level). */
  canRevert: boolean;
  /** Path under the tools server, e.g. "/AB12CD34/". null until ready. */
  path: string | null;
}

// ---- tool database inspector (server-kind tools only) ----
export interface ToolDbColumn {
  name: string;
  type: string;
  pk: boolean;
  notNull: boolean;
}

export interface ToolDbTable {
  name: string;
  type: "table" | "view";
  rowCount: number | null;
  columns: ToolDbColumn[];
  sql: string | null;
}

export interface ToolDbStateEntry {
  key: string;
  bytes: number;
}

export interface ToolDbOverview {
  kind: "static" | "server";
  exists: boolean;
  sizeBytes: number | null;
  tables: ToolDbTable[];
  /** Static tools only — the tool's saved `/__state` blobs. */
  stateEntries: ToolDbStateEntry[];
}

export interface ToolDbRowPage {
  table: string;
  columns: ToolDbColumn[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface ToolDbQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface Health {
  ok: boolean;
  model: string;
  serverName: string;
  needsSetup: boolean;
  toolsPort: number;
  toolsEnabled: "full" | "static-only" | "off";
  /** Whether the server offers speech-to-text — the chat mic button hides when false. */
  asrEnabled: boolean;
  /** "on" when an embedding model is configured for semantic document search. */
  semanticSearch?: "on" | "off";
  /** Whether scheduled routines are available — the Routines nav item hides when false. */
  routinesEnabled?: boolean;
  /** "on" when an admin has configured a web search provider (research agent). */
  web?: "on" | "off";
  /** "on" when file processing works here; "unavailable" if requested but the sandbox is missing. */
  shell?: "on" | "off" | "unavailable";
  /** Whether the stateless code sandbox (run_code / the /calc command) is available. */
  compute?: boolean;
}

/** Document search strategy — see agent-core embeddings.ts. */
export type DocumentSearchMode = "keyword" | "fuzzy" | "semantic" | "hybrid";

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
  /** Hugging Face repo id of the speech-to-text model used for voice input. */
  asrModel: string;
  /** Whether voice input is enabled at all (env-controlled, not editable here). */
  asrEnabled: boolean;
  serverName: string;
  isAdmin: boolean;
  /** Fields pinned by an env var — read-only in the UI. */
  envLocked: {
    model: boolean;
    ollamaBaseUrl: boolean;
    inboxDir: boolean;
    ocrModel: boolean;
    asrModel: boolean;
    serverName: boolean;
  };
}

export interface SettingsPatch {
  inboxDir?: string;
  model?: string;
  ollamaBaseUrl?: string;
  ocrModel?: string;
  asrModel?: string;
  serverName?: string;
}

// Separate from request() because a file upload must NOT set
// Content-Type: application/json — the browser sets multipart/form-data with
// its own boundary. Still needs the bearer token.
async function upload<T>(path: string, file: Blob, field = "file", filename = (file as File).name || "upload"): Promise<T> {
  const formData = new FormData();
  formData.append(field, file, filename);
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
  chat: (message: string, images: string[] = [], sessionId?: string, signal?: AbortSignal) =>
    request<{ reply: string; references?: ChatReference[]; sessionId: string }>("/chat", {
      method: "POST",
      body: JSON.stringify({ message, ...(images.length ? { images } : {}), ...(sessionId ? { sessionId } : {}) }),
      signal,
    }),
  listChatSessions: () => request<{ sessions: ChatSession[] }>("/chat/sessions"),
  getChatSessionMessages: (id: string) =>
    request<{ messages: ChatSessionMessage[] }>(`/chat/sessions/${id}/messages`),
  renameChatSession: (id: string, title: string) =>
    request<{ session: ChatSession }>(`/chat/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteChatSession: (id: string) => request<{ deleted: true }>(`/chat/sessions/${id}`, { method: "DELETE" }),
  /** Transcribe a recorded voice clip (16 kHz mono WAV) for the chat composer. */
  transcribe: (wav: Blob) => upload<{ text: string }>("/transcribe", wav, "audio", "voice.wav"),
  listTasks: () => request<{ tasks: Task[] }>("/tasks"),
  getTask: (id: string) => request<{ task: Task }>(`/tasks/${id}`),
  getDocument: (id: string) => request<{ document: Document }>(`/documents/${id}`),
  /** The document's original file (PDF / image) for previewing. Throws on 404
   *  (e.g. a pasted-text document, or one uploaded before originals were kept). */
  getDocumentOriginal: async (id: string): Promise<{ buffer: ArrayBuffer; type: string }> => {
    const token = getToken();
    const res = await fetch(`${BASE_URL}/documents/${id}/original`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (res.status === 401) {
      clearToken();
      emitSignedOut();
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return { buffer: await res.arrayBuffer(), type: res.headers.get("content-type") ?? "" };
  },
  /** Keyword search over task titles and notes, ranked, optionally filtered by status. */
  searchTasks: (query: string, opts: { status?: "open" | "done"; limit?: number } = {}) => {
    const p = new URLSearchParams({ q: query });
    if (opts.status) p.set("status", opts.status);
    if (opts.limit) p.set("limit", String(opts.limit));
    return request<{ results: TaskSearchHit[] }>(`/tasks/search?${p.toString()}`);
  },
  createTask: (title: string, dueDate?: string, dueTime?: string) =>
    request<{ task: Task }>("/tasks", {
      method: "POST",
      body: JSON.stringify({ title, dueDate: dueDate || undefined, dueTime: dueTime || undefined }),
    }),
  completeTask: (id: string) =>
    request<{ task: Task }>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) }),
  rescheduleTask: (id: string, patch: { dueDate?: string | null; dueTime?: string | null }) =>
    request<{ task: Task }>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  listDocuments: () => request<{ documents: Document[] }>("/documents"),
  /**
   * Search documents (filename + full text + summary), ranked, with optional
   * filters. `mode` (default "hybrid" server-side) picks the strategy:
   * keyword | fuzzy (typo-tolerant) | semantic (by meaning) | hybrid (all).
   */
  searchDocuments: (
    query: string,
    opts: {
      category?: string;
      dueBefore?: string;
      dueAfter?: string;
      limit?: number;
      mode?: DocumentSearchMode;
    } = {}
  ) => {
    const p = new URLSearchParams({ q: query });
    if (opts.category) p.set("category", opts.category);
    if (opts.dueBefore) p.set("dueBefore", opts.dueBefore);
    if (opts.dueAfter) p.set("dueAfter", opts.dueAfter);
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.mode) p.set("mode", opts.mode);
    return request<{ results: DocumentSearchHit[] }>(`/documents/search?${p.toString()}`);
  },
  ingestDocument: (filename: string, text: string) =>
    request<{ document: Document }>("/documents/ingest", { method: "POST", body: JSON.stringify({ filename, text }) }),
  uploadDocument: (file: File) => upload<{ document: Document }>("/documents/upload", file),
  deleteDocument: (id: string) => request<{ document: Document }>(`/documents/${id}`, { method: "DELETE" }),
  retryExtraction: (id: string) =>
    request<{ document: Document }>(`/documents/${id}/retry-extraction`, { method: "POST" }),
  /** Rename a document. `by` is "document-agent" when applying an AI suggestion the user confirmed. */
  renameDocument: (id: string, filename: string, by: "user" | "document-agent" = "user") =>
    request<{ document: Document }>(`/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ filename, by }),
    }),
  /** Ask the local model for a better filename from the document's content. Does not apply it. */
  suggestDocumentName: (id: string) =>
    request<{ suggestion: { filename: string }; current: string }>(`/documents/${id}/suggest-name`, {
      method: "POST",
    }),
  listActivity: () => request<{ activity: ActivityEntry[] }>("/activity"),

  // ---- scheduled routines ----
  listRoutines: () => request<{ routines: Routine[] }>("/routines"),
  getRoutine: (id: string) => request<{ routine: Routine; runs: RoutineRun[] }>(`/routines/${id}`),
  createRoutine: (body: RoutineInput) =>
    request<{ routine: Routine }>("/routines", { method: "POST", body: JSON.stringify(body) }),
  updateRoutine: (
    id: string,
    patch: Partial<Omit<RoutineInput, "enabled">> & { enabled?: boolean }
  ) => request<{ routine: Routine }>(`/routines/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRoutine: (id: string) => request<{ deleted: true }>(`/routines/${id}`, { method: "DELETE" }),
  listRoutineRuns: (id: string, limit = 20) =>
    request<{ runs: RoutineRun[] }>(`/routines/${id}/runs?limit=${limit}`),
  /** Run a routine now. Resolves when the run finishes (can take a while). */
  runRoutine: (id: string) =>
    request<{ status: RoutineRunStatus; output: string | null; error: string | null; run: RoutineRun | null }>(
      `/routines/${id}/run`,
      { method: "POST" }
    ),

  // ---- family chat ----
  listFamilyMembers: () => request<{ members: FamilyMember[] }>("/family/members"),
  listChannels: () => request<{ channels: Channel[] }>("/channels"),
  createChannel: (body: { kind: "dm" | "group"; memberIds: string[]; name?: string }) =>
    request<{ channel: Channel }>("/channels", { method: "POST", body: JSON.stringify(body) }),
  getChannel: (id: string) => request<{ channel: Channel }>(`/channels/${id}`),
  listMessages: (id: string, after?: string) => {
    const q = after ? `?after=${encodeURIComponent(after)}` : "";
    return request<{ messages: Message[] }>(`/channels/${id}/messages${q}`);
  },
  postMessage: (id: string, body: string, mentionAgent = false, images: string[] = []) =>
    request<{ message: Message }>(`/channels/${id}/messages`, {
      method: "POST",
      body: JSON.stringify(images.length ? { body, mentionAgent, images } : { body, mentionAgent }),
    }),
  markChannelRead: (id: string, ts: string) =>
    request<{ ok: true }>(`/channels/${id}/read`, { method: "POST", body: JSON.stringify({ ts }) }),
  deleteChannel: (id: string) => request<{ deleted: true }>(`/channels/${id}`, { method: "DELETE" }),

  // ---- sticky notes ----
  listNotes: (scope: NoteScope) => request<{ notes: StickyNote[] }>(`/notes?scope=${scope}`),
  createNote: (scope: NoteScope, text: string, color?: string, pos?: { x: number; y: number }) =>
    request<{ note: StickyNote }>("/notes", {
      method: "POST",
      body: JSON.stringify({ scope, text, color, ...pos }),
    }),
  updateNote: (id: string, patch: { text?: string; color?: string; x?: number; y?: number }) =>
    request<{ note: StickyNote }>(`/notes/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteNote: (id: string) => request<{ note: StickyNote }>(`/notes/${id}`, { method: "DELETE" }),
  listTools: () => request<{ tools: Tool[] }>("/tools"),
  buildTool: (prompt: string) =>
    request<{ building: true; prompt: string }>("/tools", { method: "POST", body: JSON.stringify({ prompt }) }),
  iterateTool: (id: string, instruction: string) =>
    request<{ improving: true; instruction: string }>(`/tools/${id}/iterate`, {
      method: "POST",
      body: JSON.stringify({ instruction }),
    }),
  revertTool: (id: string) => request<{ tool: Tool; note: string }>(`/tools/${id}/revert`, { method: "POST" }),
  deleteTool: (id: string) => request<{ deleted: true }>(`/tools/${id}`, { method: "DELETE" }),
  getTool: (id: string) => request<{ tool: Tool }>(`/tools/${id}`),
  toolDb: (id: string) => request<ToolDbOverview>(`/tools/${id}/db`),
  toolDbRows: (
    id: string,
    params: { table: string; limit?: number; offset?: number; orderBy?: string; dir?: "asc" | "desc" },
  ) => {
    const q = new URLSearchParams({ table: params.table });
    if (params.limit != null) q.set("limit", String(params.limit));
    if (params.offset != null) q.set("offset", String(params.offset));
    if (params.orderBy) q.set("orderBy", params.orderBy);
    if (params.dir) q.set("dir", params.dir);
    return request<ToolDbRowPage>(`/tools/${id}/db/rows?${q.toString()}`);
  },
  toolDbQuery: (id: string, sql: string) =>
    request<ToolDbQueryResult>(`/tools/${id}/db/query`, { method: "POST", body: JSON.stringify({ sql }) }),
  toolDbState: (id: string, key: string) =>
    request<{ key: string; value: unknown }>(`/tools/${id}/db/state?key=${encodeURIComponent(key)}`),
  toolOperations: (id: string) => request<{ operations: ToolOperation[] }>(`/tools/${id}/operations`),
};
