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
  /** Tool calls the assistant made for this reply (agent messages). */
  steps: ToolStep[];
  /** Generated HTML cards attached to this reply (agent messages). */
  cards: Card[];
  pending: boolean;
  createdAt: string;
}

/** A generated HTML card — see agent-core/src/cards/. `html` is the full
 *  sealed document to drop into a sandboxed iframe; `fragment` is the raw
 *  snippet the model wrote (for "view code"). */
export interface Card {
  id: string;
  title: string;
  html: string;
  fragment: string;
}

/** One tool call the agent made during a turn — see agent-core/src/agents/steps.ts. */
export interface ToolStep {
  id: string;
  tool: string;
  /** For a `task` delegation: the subagent it was handed to. */
  subagent?: string;
  phase: "running" | "done" | "error";
  input: unknown;
  output?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
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
  /** Tool calls the assistant made for this reply (assistant turns). */
  steps: ToolStep[];
  /** Generated HTML cards attached to this reply (assistant turns). */
  cards: Card[];
  createdAt: string;
}

export type NoteScope = "shared" | "private";
export type NoteKind = "text" | "drawing" | "photo";

export interface StickyNote {
  id: string;
  scope: NoteScope;
  userId: string;
  kind: NoteKind;
  text: string;
  /** A drawing/photo note's flattened image, as a data: URI. */
  image: string | null;
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
 *  "link" is a web page the research agent opened (`id` is the URL).
 *  "artifact" is a full page render_artifact generated (`id` is the artifact id). */
export interface ChatReference {
  type: "document" | "task" | "tool" | "link" | "artifact";
  id: string;
  label: string;
}

/** A full-page artifact the assistant generated (render_artifact). List view. */
export interface ArtifactSummary {
  id: string;
  title: string;
  source: string | null;
  sourceId: string | null;
  /** Bumped on every html change (a comment resolution or a revert). */
  revision: number;
  /** True when the last edit can be undone (one step). */
  canRevert: boolean;
  /** How many comments are still open. */
  openComments: number;
  createdAt: string;
  updatedAt: string | null;
}

/** One artifact with its raw fragment and the wrapped, sandboxed document. */
export interface Artifact extends ArtifactSummary {
  html: string;
  /** The full sandboxed HTML document — load into an opaque-origin iframe. */
  document: string;
}

/** A highlight-and-comment left on an artifact. */
export interface ArtifactComment {
  id: string;
  artifactId: string;
  userId: string;
  body: string;
  quote: string | null;
  prefix: string | null;
  suffix: string | null;
  status: "open" | "resolved";
  /** The assistant's reply, or a note on what it changed. */
  resolution: string | null;
  resolvedBy: "agent" | "user" | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Per-comment outcome from POST /artifacts/:id/resolve-comments. */
export interface CommentOutcome {
  id: string;
  action: "edited" | "replied" | "skipped";
  resolution: string;
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
  /** This machine's LAN base URLs — the "Pair a phone" QR encodes the first. */
  lanUrls?: string[];
  /** Same list with the kind of each address (tailscale addresses sort first). */
  lanAddrs?: { url: string; kind: "tailscale" | "lan" | "other" }[];
  needsSetup: boolean;
  toolsPort: number;
  toolsEnabled: "full" | "static-only" | "off";
  /** Whether the server offers speech-to-text — the chat mic button hides when false. */
  asrEnabled: boolean;
  /** Whether the server offers text-to-speech — the "read aloud" button hides when false. */
  ttsEnabled?: boolean;
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
  /** "full" = skills + sandboxed scripts; "docs-only" = instructions but no script runner; "off". */
  skills?: "full" | "docs-only" | "off";
  /** "on" = MCP enabled with ≥1 connected server; "no-servers" = enabled, none configured; "off". */
  mcp?: "on" | "no-servers" | "off";
  /** "on" when render_artifact + the Artifacts tab are available. */
  artifacts?: "on" | "off";
  /** "on" when the password vault feature is enabled — the Vault nav item hides when "off". */
  vault?: "on" | "off";
  /** Whether the assistant may read the vault via the "/vault" chat command. */
  vaultAi?: boolean;
  /** "on" when the assistant may answer with a generated HTML card (render_card). */
  cards?: "on" | "off";
}

// ---- password vault ----

export type VaultScope = "private" | "shared";

export interface VaultEntry {
  id: string;
  userId: string;
  scope: VaultScope;
  folder: string | null;
  title: string;
  username: string | null;
  url: string | null;
  hasTotp: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VaultSecret {
  password?: string;
  totp?: { secret: string; digits: number; period: number; algorithm: string; issuer?: string };
  notes?: string;
  fields?: { label: string; value: string; secret?: boolean }[];
}

export interface VaultEntryDetail extends VaultEntry {
  secret: VaultSecret;
}

export interface VaultStatus {
  enabled: boolean;
  aiEnabled: boolean;
  exists: boolean;
  unlocked: boolean;
  hasRecovery: boolean;
  hasSharedAccess: boolean;
  familyVaultInitialised: boolean;
  entryCount: number;
}

export interface VaultAccessLogEntry {
  id: string;
  entryId: string | null;
  entryTitle: string;
  actor: string;
  action: string;
  at: string;
}

export interface VaultEntryInput {
  scope: VaultScope;
  title: string;
  folder?: string | null;
  username?: string | null;
  url?: string | null;
  password?: string | null;
  totpInput?: string | null;
  notes?: string | null;
  fields?: { label: string; value: string; secret?: boolean }[];
}

export interface VaultEntryPatch extends Partial<Omit<VaultEntryInput, "scope">> {
  clearTotp?: boolean;
}

// ---- skills ----

export interface Skill {
  name: string;
  description: string;
  whenToUse: string | null;
  enabled: boolean;
  scripts: string[];
  updatedAt: string;
}

/** A skill with its full markdown body — from GET /skills/:name. */
export interface SkillDetail extends Skill {
  body: string;
}

// ---- MCP connections ----

export type McpTransport = "http" | "stdio";

export interface McpServer {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  allowHosts?: string[];
  scope?: string;
  note?: string;
}

export interface McpProbeResult {
  ok: boolean;
  toolCount?: number;
  error?: string;
}

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
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
  /** Whether voice output is enabled at all (env-controlled, not editable here). */
  ttsEnabled: boolean;
  /** The Kokoro voice used for voice output — editable here. */
  ttsVoice: string;
  serverName: string;
  /** Whether the assistant may answer with a generated HTML card — admin-toggleable. */
  cardsEnabled: boolean;
  /** Whether the password vault is turned on for this server — admin-toggleable. */
  vaultEnabled: boolean;
  /** Whether the desktop app installs a found update on its own instead of waiting to be asked. */
  autoUpdateEnabled: boolean;
  /** Whether the research agent can reach the internet (a provider is configured). */
  webEnabled: boolean;
  /** Web-search provider: "none" = off; "ddg" | "searxng" | "tavily" | "brave". */
  webSearchProvider: "none" | "ddg" | "searxng" | "tavily" | "brave";
  /** SearXNG base URL (only meaningful when webSearchProvider === "searxng"). */
  webSearchUrl: string;
  /** Whether an API key is stored (tavily/brave) — the key itself is never sent. */
  webSearchApiKeySet: boolean;
  /**
   * Which backend answers the chat/planner model. ADDITIVE, not exclusive —
   * switching this never touches ocrModel/embedModel above, which stay on
   * their own Ollama-only settings regardless. See agent-core's config.ts.
   */
  modelProvider: "ollama" | "openai" | "mistralrs";
  /** Base URL of a generic OpenAI-API-compatible server (modelProvider === "openai"). */
  openaiBaseUrl: string;
  /** Whether an API key is stored for that server — the key itself is never sent. */
  openaiApiKeySet: boolean;
  /** Model name to request from that server. */
  openaiModel: string;
  /** HF repo id or local path for the embedded mistral.rs model. */
  mistralrsModelId: string;
  /** GGUF filename within that repo; empty = full-precision + in-situ quant. */
  mistralrsGgufFile: string;
  /** In-situ quantization width in bits, non-GGUF path only. */
  mistralrsIsqBits: number;
  /** Only present when modelProvider === "mistralrs" — load progress/health. */
  mistralrsStatus?: {
    status: "unavailable" | "idle" | "loading" | "ready" | "error";
    modelId?: string;
    error?: string;
  };
  isAdmin: boolean;
  /** Fields pinned by an env var — read-only in the UI. */
  envLocked: {
    model: boolean;
    ollamaBaseUrl: boolean;
    inboxDir: boolean;
    ocrModel: boolean;
    asrModel: boolean;
    ttsVoice: boolean;
    serverName: boolean;
    cardsEnabled: boolean;
    vaultEnabled: boolean;
    autoUpdateEnabled: boolean;
    webSearchProvider: boolean;
    modelProvider: boolean;
    openaiProvider: boolean;
    mistralrsProvider: boolean;
  };
}

export interface SettingsPatch {
  inboxDir?: string;
  model?: string;
  ollamaBaseUrl?: string;
  ocrModel?: string;
  asrModel?: string;
  ttsVoice?: string;
  serverName?: string;
  cardsEnabled?: boolean;
  vaultEnabled?: boolean;
  autoUpdateEnabled?: boolean;
  webSearchProvider?: "none" | "ddg" | "searxng" | "tavily" | "brave";
  webSearchUrl?: string;
  webSearchApiKey?: string;
  modelProvider?: "ollama" | "openai" | "mistralrs";
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  mistralrsModelId?: string;
  mistralrsGgufFile?: string;
  mistralrsIsqBits?: number;
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

/** Remote update-and-restart of the host desktop app (triggered from a phone). */
export interface DesktopUpdateStatus {
  state: "idle" | "requested" | "checking" | "no-update" | "downloading" | "installing" | "restarting" | "error";
  message?: string;
  percent?: number;
  requestedAt?: string;
  requestedBy?: string;
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
  /** Mint a single-use QR pairing token for the signed-in account (5-min TTL). */
  startPairing: () =>
    request<{ token: string; expiresAt: string }>("/auth/pair/start", { method: "POST" }),

  // ---- users (admin) ----
  listUsers: () => request<{ users: User[] }>("/users"),
  createUser: (body: { username: string; displayName: string; password: string; role: "admin" | "member" }) =>
    request<{ user: User }>("/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, patch: { displayName?: string; password?: string; role?: "admin" | "member" }) =>
    request<{ user: User }>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteUser: (id: string) => request<{ deleted: true }>(`/users/${id}`, { method: "DELETE" }),

  // ---- remote update-and-restart of the host desktop app ----
  getDesktopUpdateStatus: () => request<DesktopUpdateStatus>("/system/update-status"),
  requestDesktopUpdate: () => request<DesktopUpdateStatus>("/system/update-request", { method: "POST" }),
  reportDesktopUpdateStatus: (patch: Omit<DesktopUpdateStatus, "requestedAt" | "requestedBy">) =>
    request<DesktopUpdateStatus>("/system/update-report", { method: "POST", body: JSON.stringify(patch) }),

  getSettings: () => request<Settings>("/settings"),
  updateSettings: (patch: SettingsPatch) =>
    request<Settings>("/settings", { method: "PUT", body: JSON.stringify(patch) }),
  listOllamaModels: () => request<{ models: string[]; reachable: boolean }>("/ollama/models"),
  chat: (
    message: string,
    images: string[] = [],
    sessionId?: string,
    signal?: AbortSignal,
    turnId?: string,
    documentIds: string[] = []
  ) =>
    request<{
      reply: string;
      references?: ChatReference[];
      steps?: ToolStep[];
      cards?: Card[];
      sessionId: string;
    }>("/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        ...(images.length ? { images } : {}),
        ...(documentIds.length ? { documentIds } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(turnId ? { turnId } : {}),
      }),
      signal,
    }),
  /** Poll the tool calls made so far by an in-flight turn (1:1 chat turnId, or
   *  a family-channel pending message id). */
  turnSteps: (turnId: string) =>
    request<{ steps: ToolStep[]; done: boolean }>(`/chat/turns/${encodeURIComponent(turnId)}`),
  listChatSessions: () => request<{ sessions: ChatSession[] }>("/chat/sessions"),
  getChatSessionMessages: (id: string) =>
    request<{ messages: ChatSessionMessage[] }>(`/chat/sessions/${id}/messages`),
  renameChatSession: (id: string, title: string) =>
    request<{ session: ChatSession }>(`/chat/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteChatSession: (id: string) => request<{ deleted: true }>(`/chat/sessions/${id}`, { method: "DELETE" }),
  /** Transcribe a recorded voice clip (16 kHz mono WAV) for the chat composer. */
  transcribe: (wav: Blob) => upload<{ text: string }>("/transcribe", wav, "audio", "voice.wav"),
  /** Synthesize an assistant reply to speech — returns a WAV Blob to play.
   *  The first call downloads the Kokoro model (~86 MB) so it can take ~20s. */
  speak: async (text: string, voice?: string, signal?: AbortSignal): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`${BASE_URL}/speak`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text, voice }),
      signal,
    });
    if (res.status === 401) {
      clearToken();
      emitSignedOut();
    }
    if (!res.ok) {
      const detail = await res.json().catch(() => null);
      throw new Error(detail?.error || `${res.status} ${res.statusText}`);
    }
    return res.blob();
  },
  /** The Kokoro voices the loaded model exposes (empty until it's loaded once). */
  listTtsVoices: () => request<{ voices: string[]; current: string }>("/tts/voices"),
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
  deleteTask: (id: string) => request<{ deleted: boolean }>(`/tasks/${id}`, { method: "DELETE" }),
  /** Bulk-deletes every completed task; returns how many were removed. */
  deleteCompletedTasks: () => request<{ deleted: number }>("/tasks/delete-completed", { method: "POST" }),
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

  // ---- skills ----
  listSkills: () => request<{ skills: Skill[]; scriptsRunnable: boolean }>("/skills"),
  getSkill: (name: string) => request<{ skill: SkillDetail }>(`/skills/${encodeURIComponent(name)}`),
  saveSkill: (body: { name: string; description?: string; whenToUse?: string; enabled?: boolean; markdown: string }) =>
    request<{ skill: SkillDetail }>("/skills", { method: "POST", body: JSON.stringify(body) }),
  setSkillEnabled: (name: string, enabled: boolean) =>
    request<{ skill: SkillDetail }>(`/skills/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  deleteSkill: (name: string) =>
    request<{ deleted: true }>(`/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
  draftSkill: (body: { name: string; description: string }) =>
    request<{ markdown: string }>("/skills/draft", { method: "POST", body: JSON.stringify(body) }),

  // ---- MCP connections (admin) ----
  listMcpServers: () => request<{ servers: McpServer[] }>("/mcp/servers"),
  saveMcpServer: (body: McpServer) =>
    request<{ server: McpServer; probe: McpProbeResult }>("/mcp/servers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  setMcpServerEnabled: (name: string, enabled: boolean) =>
    request<{ server: McpServer }>(`/mcp/servers/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  deleteMcpServer: (name: string) =>
    request<{ deleted: true }>(`/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" }),
  probeMcpServer: (name: string) =>
    request<McpProbeResult>(`/mcp/servers/${encodeURIComponent(name)}/probe`, { method: "POST" }),
  listMcpTools: () => request<{ tools: McpToolInfo[] }>("/mcp/tools"),

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
  createNote: (
    scope: NoteScope,
    text: string,
    color?: string,
    pos?: { x: number; y: number },
    extra?: { kind?: NoteKind; image?: string }
  ) =>
    request<{ note: StickyNote }>("/notes", {
      method: "POST",
      body: JSON.stringify({ scope, text, color, ...pos, ...extra }),
    }),
  updateNote: (id: string, patch: { text?: string; image?: string | null; color?: string; x?: number; y?: number }) =>
    request<{ note: StickyNote }>(`/notes/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteNote: (id: string) => request<{ note: StickyNote }>(`/notes/${id}`, { method: "DELETE" }),
  // ---- password vault ----
  vaultStatus: () => request<VaultStatus>("/vault/status"),
  vaultSetup: (password: string) =>
    request<{ ok: true; recoveryCode: string; status: VaultStatus }>("/vault/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  vaultUnlock: (password: string) =>
    request<{ ok: true; status: VaultStatus }>("/vault/unlock", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  vaultLock: () => request<{ ok: true; status: VaultStatus }>("/vault/lock", { method: "POST" }),
  vaultRecover: (recoveryCode: string, password: string) =>
    request<{ ok: true; recoveryCode: string; status: VaultStatus }>("/vault/recover", {
      method: "POST",
      body: JSON.stringify({ recoveryCode, password }),
    }),
  vaultFamilySync: () => request<{ ok: true; granted: number }>("/vault/family/sync", { method: "POST" }),
  listVaultEntries: () => request<{ entries: VaultEntry[] }>("/vault/entries"),
  getVaultEntry: (id: string) => request<{ entry: VaultEntryDetail }>(`/vault/entries/${id}`),
  createVaultEntry: (body: VaultEntryInput) =>
    request<{ entry: VaultEntry }>("/vault/entries", { method: "POST", body: JSON.stringify(body) }),
  updateVaultEntry: (id: string, patch: VaultEntryPatch) =>
    request<{ entry: VaultEntry }>(`/vault/entries/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteVaultEntry: (id: string) =>
    request<{ deleted: true; entry: VaultEntry }>(`/vault/entries/${id}`, { method: "DELETE" }),
  vaultTotp: (id: string) =>
    request<{ code: string; expiresInSeconds: number }>(`/vault/entries/${id}/totp`),
  vaultAccessLog: () => request<{ entries: VaultAccessLogEntry[] }>("/vault/access-log"),

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

  // ---- artifacts (render_artifact) ----
  listArtifacts: () => request<{ artifacts: ArtifactSummary[] }>("/artifacts"),
  getArtifact: (id: string) =>
    request<{ artifact: Artifact; comments: ArtifactComment[] }>(`/artifacts/${id}`),
  renameArtifact: (id: string, title: string) =>
    request<{ artifact: ArtifactSummary }>(`/artifacts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteArtifact: (id: string) => request<{ deleted: true }>(`/artifacts/${id}`, { method: "DELETE" }),
  revertArtifact: (id: string) =>
    request<{ artifact: Artifact; comments: ArtifactComment[] }>(`/artifacts/${id}/revert`, { method: "POST" }),
  artifactComments: (id: string) =>
    request<{ comments: ArtifactComment[] }>(`/artifacts/${id}/comments`),
  addArtifactComment: (id: string, body: string, anchor?: { quote?: string; prefix?: string; suffix?: string }) =>
    request<{ comment: ArtifactComment }>(`/artifacts/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, ...anchor }),
    }),
  updateArtifactComment: (id: string, cid: string, body: string) =>
    request<{ comment: ArtifactComment }>(`/artifacts/${id}/comments/${cid}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    }),
  reopenArtifactComment: (id: string, cid: string) =>
    request<{ comment: ArtifactComment }>(`/artifacts/${id}/comments/${cid}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "open" }),
    }),
  deleteArtifactComment: (id: string, cid: string) =>
    request<{ deleted: true }>(`/artifacts/${id}/comments/${cid}`, { method: "DELETE" }),
  resolveArtifactComment: (id: string, cid: string, resolution?: string) =>
    request<{ comment: ArtifactComment }>(`/artifacts/${id}/comments/${cid}/resolve`, {
      method: "POST",
      body: JSON.stringify(resolution ? { resolution } : {}),
    }),
  resolveArtifactComments: (id: string, commentIds?: string[]) =>
    request<{ artifact: Artifact; comments: ArtifactComment[]; edited: boolean; outcomes: CommentOutcome[] }>(
      `/artifacts/${id}/resolve-comments`,
      { method: "POST", body: JSON.stringify(commentIds ? { commentIds } : {}) },
    ),
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
