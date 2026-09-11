import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { hashPassword, newSessionToken, sha256Hex } from "./auth.js";
import type {
  RoutineTrigger,
  RoutineAction,
  CatchUpPolicy,
  RoutineRunTrigger,
  RoutineRunStatus,
} from "./routines.js";
import type { AgentStep } from "./agents/steps.js";
import type { CardRecord } from "./cards/wrap.js";

// Short, unambiguous ids (Crockford base32, no 0/O/1/I/L confusion) — small
// local models reliably garble long UUIDs when copying them into tool
// call arguments (observed firsthand; see docs/DECISIONS.md), so any id a
// model has to transcribe stays short. Full randomUUID() is still used for
// activity log entries, which models never need to type back out.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
function shortId(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Turn a free-text query into a safe FTS5 MATCH expression. FTS5 treats bare
// punctuation, quotes, and the bare words AND/OR/NOT/NEAR as query operators,
// so handing it raw user text ("what's my water bill?") is a syntax error, not
// a search. Reduce the query to its word tokens, quote each (so it can't be an
// operator) and prefix-match it (`*`), joined with OR and left to bm25() to
// rank. OR, not the implicit AND: a family question carries filler the target
// document doesn't contain verbatim ("what is my insurance *number*", "when is
// the water bill *due*") — ANDing every token drops the very document the user
// wants. Returns "" when nothing usable is left; callers then fall back to a
// plain recency listing with whatever structured filters were also supplied.
export function toFtsMatchQuery(raw: string): string {
  const tokens = (raw ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens
    .filter((t) => t.length >= 2)
    .slice(0, 12) // guard against someone pasting a whole paragraph
    .map((t) => `"${t}"*`)
    .join(" OR ");
}

// ---- fuzzy (trigram) search ----
// FTS5's `trigram` tokenizer indexes every 3-character run in a column, so a
// MATCH on a quoted string is really a case-insensitive substring test. That
// already beats the prefix-only keyword index for mid-word hits ("surance"),
// but on its own it still can't tolerate a typo — "insurnce" is not a
// substring of "insurance". So rather than matching the query as one string,
// this breaks every query word into its OWN trigrams and ORs them: a
// misspelling still shares most of its trigrams with the real word, bm25()
// ranks the document with the most overlap first, and `trigramSimilarity()`
// below re-scores the shortlist to drop the long tail of 1-trigram
// coincidences. Returns "" when the query has no word of length ≥ 3 (nothing
// for the trigram tokenizer to bite on); the caller then falls back to the
// keyword path.
export function toTrigramMatchQuery(raw: string): string {
  const words = (raw ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const grams = new Set<string>();
  for (const w of words.slice(0, 12)) {
    if (w.length < 3) continue;
    for (let i = 0; i <= w.length - 3; i++) grams.add(w.slice(i, i + 3));
  }
  // Quote each gram so a run like "or"+space can't be read as the OR operator,
  // and cap the count so a pasted paragraph can't build a 500-term MATCH.
  return [...grams].slice(0, 60).map((g) => `"${g.replace(/"/g, '""')}"`).join(" OR ");
}

/** Trigram multiset of a string, space-padded so short words still yield grams. */
function trigramSet(s: string): Set<string> {
  const norm = ` ${(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const out = new Set<string>();
  for (let i = 0; i <= norm.length - 3; i++) {
    const g = norm.slice(i, i + 3);
    if (g.trim().length > 0) out.add(g);
  }
  return out;
}

/**
 * Sørensen–Dice coefficient of two strings' trigram sets, 0…1. Robust to
 * typos, transpositions, and word-order changes ("insurnce" vs "insurance" ≈
 * 0.6; "auto policy" vs "policy auto" ≈ 1). Used to re-rank and gate fuzzy
 * search hits.
 */
export function trigramSimilarity(a: string, b: string): number {
  const A = trigramSet(a);
  const B = trigramSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// ---- embedding-vector math (for ScopedStore's semantic search) ----
// Vectors are stored as little-endian Float32 BLOBs. A SQLite BLOB comes back
// as a Uint8Array whose underlying ArrayBuffer may be pooled and unaligned, so
// copy into a fresh, 8-byte-aligned buffer before viewing it as Float32.
function bytesToFloat32(u8: Uint8Array): Float32Array {
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return new Float32Array(ab);
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function vectorNorm(a: Float32Array): number {
  return Math.sqrt(dotProduct(a, a));
}

// The owner assigned to any pre-existing row when a single-user database is
// upgraded to the multi-user schema. `reassignLegacyData()` moves these to
// the first real admin the moment one is created during setup.
export const LEGACY_USER_ID = "_legacy_";

// The `messages.sender_id` value for a message the AI planner posted into a
// family channel (in response to an @agent mention). Not a real user — it has
// no `users` row and is never a `channel_members` entry; the agent only ever
// speaks when invoked. Clients render it as a distinct participant.
export const AGENT_SENDER_ID = "_agent_";

// A session lasts this long without being used before it's rejected. Long,
// because this is a family LAN device, not a bank — but not forever, so a
// lost/old phone eventually stops working.
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// A QR pairing token (desktop "Pair a phone" → auto sign-in) is single-use and
// dies fast: it grants a full session for one account with no password, so a
// stale photo of the QR must be worthless within minutes.
export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;

export type UserRole = "admin" | "member";

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  /** Per-user watched folder; null means "use the derived default". */
  inboxDir: string | null;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  /** 24-hour "HH:MM" if the task has a specific time of day; null = all-day. */
  dueTime: string | null;
  status: "open" | "done";
  createdAt: string;
  updatedAt: string;
}

export type ExtractionStatus = "pending" | "done" | "failed";

export interface DocumentRecord {
  id: string;
  filename: string;
  rawText: string;
  extracted: Record<string, unknown> | null;
  createdAt: string;
  /** Absolute path if this came from the watched inbox folder; null for API-pasted documents. */
  sourcePath: string | null;
  /** MIME type of the stored original file (uploads), for the preview route.
   *  null when there's no stored original or it wasn't recorded. */
  originalMime: string | null;
  /** Basename the stored original is saved under in documents/<userId>/ — the
   *  document's own filename, sanitized, with a " (2)" suffix on collision.
   *  null when there's no stored original, or it predates this and still lives
   *  at the legacy documents/<userId>/<docId> path. */
  originalDiskName: string | null;
  /**
   * Where field extraction got to. "pending" while the model is working (or
   * queued), "done" once fields are saved, "failed" once retries are
   * exhausted. Without this the UI can only tell "has fields" from "no
   * fields yet" and shows a failed extraction as "Extracting…" forever.
   */
  extractionStatus: ExtractionStatus;
}

export interface ActivityRecord {
  id: string;
  ts: string;
  actor: string;
  action: string;
  detail: string;
}

/** One hit from `ScopedStore.searchDocuments()` — a list-row shape plus a match snippet. */
export interface DocumentSearchHit {
  id: string;
  filename: string;
  category: string | null;
  summary: string | null;
  /** A short excerpt around the match (FTS `snippet()`), or the head of the text on a filter-only search. */
  snippet: string;
  createdAt: string;
  extractionStatus: ExtractionStatus;
}

/** One hit from `ScopedStore.searchTasks()`. */
export interface TaskSearchHit {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  dueTime: string | null;
  status: "open" | "done";
  snippet: string;
}

export type ToolKind = "static" | "server";
export type ToolStatus = "building" | "ready" | "failed";

export interface ToolRecord {
  id: string;
  name: string;
  description: string;
  /** The user's original request, kept so a tool can be rebuilt/iterated on. */
  prompt: string;
  kind: ToolKind;
  status: ToolStatus;
  /** Failure detail when status === "failed". */
  error: string | null;
  createdAt: string;
  /** Last successful build or improve; null for a tool from before this column. */
  updatedAt: string | null;
  /** How many times the tool has been improved since its first build. */
  revisionCount: number;
  /** null = idle; "revising" = an improve is running; else = why the last improve failed. */
  revisionState: string | null;
}

// ---- AI-generated artifacts (render_artifact) ----

export interface ArtifactRecord {
  id: string;
  title: string;
  /** The raw <body> fragment the model wrote; artifacts/wrap.ts wraps it. */
  html: string;
  /** Where it was generated: "chat" | "channel" | null. */
  source: string | null;
  /** The chat session id / channel id it was born in, for a "back" link. */
  sourceId: string | null;
  /** Bumped on every html change (a comment resolution or a revert). */
  revision: number;
  /** True when there's a prior version to revert to (one step). */
  canRevert: boolean;
  createdAt: string;
  updatedAt: string | null;
}

function rowToArtifact_(r: any): ArtifactRecord {
  return {
    id: r.id,
    title: r.title,
    html: r.html,
    source: r.source ?? null,
    sourceId: r.source_id ?? null,
    revision: Number(r.revision ?? 0),
    canRevert: !!r.prev_html,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
  };
}

export interface ArtifactCommentRecord {
  id: string;
  artifactId: string;
  /** Who left the comment. */
  userId: string;
  body: string;
  /** The highlighted text, and a little context on each side to anchor it. */
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

function rowToArtifactComment_(r: any): ArtifactCommentRecord {
  return {
    id: r.id,
    artifactId: r.artifact_id,
    userId: r.user_id,
    body: r.body,
    quote: r.quote ?? null,
    prefix: r.prefix ?? null,
    suffix: r.suffix ?? null,
    status: r.status === "resolved" ? "resolved" : "open",
    resolution: r.resolution ?? null,
    resolvedBy: r.resolved_by ?? null,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at ?? null,
  };
}

// ---- family chat ----
// The first cross-account data in the app. A `channel` is either a 1:1 "dm" or
// a named "group" (Slack-style); `channel_members` is the access boundary —
// every read method on `Store` takes the requesting user id and returns
// nothing when they aren't a member. See docs/DECISIONS.md.
export type ChannelKind = "dm" | "group";

export interface ChannelMemberInfo {
  id: string;
  username: string;
  displayName: string;
}

export interface ChannelRecord {
  id: string;
  kind: ChannelKind;
  /** Set for groups; null for DMs (the client derives a title from members). */
  name: string | null;
  createdBy: string;
  createdAt: string;
}

/** A channel plus its member list — returned by getChannelForUser / create*. */
export interface ChannelDetail extends ChannelRecord {
  members: ChannelMemberInfo[];
}

/** A row in the channel list: channel + a preview + this user's unread count. */
export interface ChannelSummary extends ChannelRecord {
  members: ChannelMemberInfo[];
  /** Display title: the group name, or the other member(s) for a DM. */
  title: string;
  lastMessage: { senderId: string; body: string; createdAt: string; pending: boolean } | null;
  unreadCount: number;
}

export interface MessageRecord {
  id: string;
  channelId: string;
  /** A user id, or AGENT_SENDER_ID. */
  senderId: string;
  body: string;
  /** Image attachments as data URIs — same as the 1:1 chat composer. */
  images: string[];
  /** Tool calls the assistant made for this reply — agent messages only. */
  steps: AgentStep[];
  /** Generated HTML cards attached to this reply — agent messages only. */
  cards: CardRecord[];
  /** True while the agent's reply is still being generated (body is ""). */
  pending: boolean;
  createdAt: string;
}

// ---- chat sessions (private 1:1 assistant chat history) ----
// Unlike channels/messages (cross-account, membership-gated) a chat session
// belongs to exactly one user, so it follows the tasks/documents shape: a
// plain `user_id` column, scoped through ScopedStore.
export interface ChatSessionRecord {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** A row in the session list: session + a preview of its last message. */
export interface ChatSessionSummary extends ChatSessionRecord {
  lastMessage: string | null;
  messageCount: number;
}

export interface ChatReference {
  /** "link" is a web page the research agent opened — `id` is the URL.
   *  "artifact" is a full-page artifact render_artifact generated — `id` is
   *  the artifact id; the chip opens the Artifacts view. */
  type: "document" | "task" | "tool" | "link" | "artifact";
  id: string;
  label: string;
}

export interface ChatSessionMessageRecord {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  body: string;
  /** Image attachments as data URIs — user turns only. */
  images: string[];
  /** Reference chips resolved for that reply — assistant turns only. */
  refs: ChatReference[];
  /** Tool calls the assistant made for that reply — assistant turns only. */
  steps: AgentStep[];
  /** Generated HTML cards attached to that reply — assistant turns only. */
  cards: CardRecord[];
  createdAt: string;
}

// ---- sticky notes ----
export type NoteScope = "shared" | "private";

export interface StickyNoteRecord {
  id: string;
  scope: NoteScope;
  /** Author (shared board) or owner (private board). */
  userId: string;
  text: string;
  color: string;
  /** Position on the corkboard, in CSS px from the board's top-left. */
  x: number;
  y: number;
  createdAt: string;
  updatedAt: string;
}

// ---- scheduled routines ----
// Per-user, like tasks/documents: a `user_id` column, scoped through
// ScopedStore. `trigger` and `action` are JSON (RoutineTrigger / RoutineAction
// from routines.ts). `next_run_at` is the one field the scheduler polls.
export interface RoutineRecord {
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  trigger: RoutineTrigger;
  action: RoutineAction;
  /** Optional family channel the run's output is also posted into (as @agent). */
  deliverChannelId: string | null;
  /** What to do with an occurrence missed while the process was down. */
  catchUp: CatchUpPolicy;
  /** ISO; null when disabled or a spent one-shot. The scheduler polls this. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: RoutineRunStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineRunRecord {
  id: string;
  routineId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RoutineRunStatus;
  /** How the run was triggered. */
  trigger: RoutineRunTrigger;
  output: string | null;
  error: string | null;
}

// ---- password vault ----
export type VaultScope = "private" | "shared";

/** The per-user key-wrapping row. Blobs are raw bytes (see vault/crypto.ts). */
export interface VaultKeysRow {
  userId: string;
  kdfParams: string;
  kdfSalt: Buffer;
  dekWrappedLogin: Buffer;
  recoverySalt: Buffer | null;
  dekWrappedRecovery: Buffer | null;
  publicKey: Buffer;
  privateKeyWrapped: Buffer;
  familyKeySealed: Buffer | null;
  createdAt: string;
  updatedAt: string;
}

/** A vault entry's non-secret metadata — safe to list without unlocking. */
export interface VaultEntryRecord {
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

export interface VaultAccessLogRecord {
  id: string;
  entryId: string | null;
  entryTitle: string;
  actor: string;
  action: string;
  at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  inbox_dir TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_label TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Short-lived, single-use tokens minted for the desktop "Pair a phone" QR when
-- auto sign-in is on. Only the sha256 is stored (same as sessions). Redeeming
-- one deletes the row; a sweep clears anything past expires_at.
CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}',
  title TEXT NOT NULL,
  notes TEXT,
  due_date TEXT,
  due_time TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}',
  filename TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  extracted TEXT,
  created_at TEXT NOT NULL,
  source_path TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  original_mime TEXT,
  original_disk_name TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}',
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}',
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  -- null = idle; 'revising' = an improve is running; any other string = the
  -- reason the last improve failed (shown as a warning, tool still works).
  revision_state TEXT
);

-- AI-generated full-page artifacts (render_artifact). Per-user, browsable in
-- the Artifacts tab. We store only the raw <body> fragment the model wrote and
-- wrap it (doctype + sealed CSP + house style) at read time — artifacts/wrap.ts.
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}',
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  -- one-step undo for an AI edit driven by a comment; null = no prior version
  prev_html TEXT,
  -- bumped on every html change (a comment resolution or a revert)
  revision INTEGER NOT NULL DEFAULT 0,
  -- where it was born, for a "back to the conversation" link: 'chat' | 'channel'
  source TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, created_at);

-- Highlight-and-comment on an artifact. The user selects text in the sandboxed
-- viewer and leaves a note; the assistant addresses it (edits the artifact, or
-- replies). Anchored by the quoted text plus a little surrounding context so a
-- highlight survives an edit. Scoped through the owning artifact (per-user).
CREATE TABLE IF NOT EXISTS artifact_comments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  quote TEXT,            -- the highlighted text
  prefix TEXT,           -- ~48 chars before it (disambiguates a repeated quote)
  suffix TEXT,           -- ~48 chars after it
  status TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'resolved'
  resolution TEXT,       -- the assistant's reply / note on what changed
  resolved_by TEXT,      -- 'agent' | 'user' | null
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifact_comments ON artifact_comments(artifact_id, created_at);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  last_read_at TEXT,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0,
  images TEXT,
  steps TEXT,
  cards TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);

CREATE TABLE IF NOT EXISTS sticky_notes (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'butter',
  pos_x REAL NOT NULL DEFAULT 0,
  pos_y REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sticky_scope ON sticky_notes(scope, user_id);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id, updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  images TEXT,
  refs TEXT,
  steps TEXT,
  cards TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);

-- Semantic search: one row per text chunk of a document. The vec column is a
-- little-endian Float32 BLOB; the model column records which embedding model
-- produced it so a model change can invalidate stale rows. Populated off the
-- ingest path by embeddings.ts and cleaned up by the documents DELETE trigger
-- (see migrateSearchIndex). Brute-force cosine scan at query time -- fine at
-- family scale; see docs/DECISIONS.md for why no vector-index extension.
CREATE TABLE IF NOT EXISTS document_embeddings (
  doc_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (doc_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_document_embeddings_user ON document_embeddings(user_id, model);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  deliver_channel_id TEXT,
  catch_up TEXT NOT NULL DEFAULT 'skip',
  next_run_at TEXT,
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routines_user ON routines(user_id);
CREATE INDEX IF NOT EXISTS idx_routines_due ON routines(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  output TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_routine_runs_routine ON routine_runs(routine_id, started_at);

-- ---- password vault ----
-- One wrapping row per user: the data-encryption key (dek) wrapped under a key
-- derived from their login password, and again under a one-time recovery code;
-- an X25519 keypair (private key encrypted under the dek) used only to open the
-- sealed shared "family" key. Nothing here is usable without the login password
-- or the recovery code — a stolen DB file leaks none of it. See
-- agent-core/src/vault/crypto.ts and docs/DECISIONS.md.
CREATE TABLE IF NOT EXISTS vault_keys (
  user_id TEXT PRIMARY KEY,
  kdf_params TEXT NOT NULL,
  kdf_salt BLOB NOT NULL,
  dek_wrapped_login BLOB NOT NULL,
  recovery_salt BLOB,
  dek_wrapped_recovery BLOB,
  public_key BLOB NOT NULL,
  private_key_wrapped BLOB NOT NULL,
  family_key_sealed BLOB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One credential / TOTP entry. Title / username / url stay as plaintext columns
-- so the list and search work without unlocking; the actual secret (password,
-- TOTP seed, notes, custom fields) is one AES-256-GCM blob keyed by the owner's
-- dek (scope='private') or the family key (scope='shared').
CREATE TABLE IF NOT EXISTS vault_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'private',
  folder TEXT,
  title TEXT NOT NULL,
  username TEXT,
  url TEXT,
  has_totp INTEGER NOT NULL DEFAULT 0,
  secret BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_entries_user ON vault_entries(user_id, scope);
CREATE INDEX IF NOT EXISTS idx_vault_entries_scope ON vault_entries(scope);

-- Every reveal of a password or TOTP code (by a person or by the assistant) is
-- logged here with the entry title but NEVER the value — the Vault screen shows
-- it so a family member can see when the assistant last read one of their
-- secrets.
CREATE TABLE IF NOT EXISTS vault_access_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entry_id TEXT,
  entry_title TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vault_access_log_user ON vault_access_log(user_id, at);
`;

// Columns added after a release. `CREATE TABLE IF NOT EXISTS` is a no-op
// against a database that already has the table, so a DB created by an older
// build keeps its old shape and every INSERT that names a newer column fails
// at runtime. Bring such a DB forward by adding any missing column. SQLite's
// ALTER TABLE ADD COLUMN can't carry a UNIQUE constraint, so uniqueness for
// source_path lives in an index (see migrate()).
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "documents", column: "source_path", ddl: "ALTER TABLE documents ADD COLUMN source_path TEXT" },
  {
    table: "documents",
    column: "extraction_status",
    ddl:
      "ALTER TABLE documents ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending'; " +
      "UPDATE documents SET extraction_status = CASE WHEN extracted IS NULL THEN 'failed' ELSE 'done' END",
  },
  // Multi-user: every owned row gets an owner. A DB from a single-user build
  // has rows with no owner — the DEFAULT backfills them to the legacy
  // sentinel, which reassignLegacyData() then hands to the first admin.
  { table: "tasks", column: "user_id", ddl: `ALTER TABLE tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}'` },
  { table: "tasks", column: "due_time", ddl: "ALTER TABLE tasks ADD COLUMN due_time TEXT" },
  { table: "documents", column: "user_id", ddl: `ALTER TABLE documents ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}'` },
  { table: "activity", column: "user_id", ddl: `ALTER TABLE activity ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}'` },
  { table: "tools", column: "user_id", ddl: `ALTER TABLE tools ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}'` },
  // Iterable tools: a tool can be improved after its first build. These track
  // how many times, when last, and whether an improve is in flight / last failed.
  { table: "tools", column: "updated_at", ddl: "ALTER TABLE tools ADD COLUMN updated_at TEXT" },
  { table: "tools", column: "revision_count", ddl: "ALTER TABLE tools ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0" },
  { table: "tools", column: "revision_state", ddl: "ALTER TABLE tools ADD COLUMN revision_state TEXT" },
  // Multimodal family chat: a message can carry image attachments (JSON array
  // of data URIs), the same way the 1:1 chat composer does.
  { table: "messages", column: "images", ddl: "ALTER TABLE messages ADD COLUMN images TEXT" },
  // Tool-call visibility: an agent reply carries the list of tool calls it made.
  { table: "messages", column: "steps", ddl: "ALTER TABLE messages ADD COLUMN steps TEXT" },
  { table: "chat_messages", column: "steps", ddl: "ALTER TABLE chat_messages ADD COLUMN steps TEXT" },
  // Generated HTML cards: an agent reply can carry inline card fragments.
  { table: "messages", column: "cards", ddl: "ALTER TABLE messages ADD COLUMN cards TEXT" },
  { table: "chat_messages", column: "cards", ddl: "ALTER TABLE chat_messages ADD COLUMN cards TEXT" },
  // Original-file preview: uploads keep their bytes on disk; this records the
  // MIME so the preview route can serve the right Content-Type.
  { table: "documents", column: "original_mime", ddl: "ALTER TABLE documents ADD COLUMN original_mime TEXT" },
  // Browsable documents folder: a stored original now keeps its real filename
  // (+ extension) on disk instead of being named after the doc id. This column
  // is that on-disk basename, relative to documents/<userId>/. null = no stored
  // original, or an upload from before this that's still at the <docId> path
  // (backfillOriginalDiskNames() migrates those on the next startup).
  { table: "documents", column: "original_disk_name", ddl: "ALTER TABLE documents ADD COLUMN original_disk_name TEXT" },
  // Corkboard: sticky notes carry an (x, y) position. A DB from before this
  // has none — add both columns and scatter the existing notes so they don't
  // all land on top of each other at (0, 0).
  {
    table: "sticky_notes",
    column: "pos_x",
    ddl:
      "ALTER TABLE sticky_notes ADD COLUMN pos_x REAL NOT NULL DEFAULT 0; " +
      "ALTER TABLE sticky_notes ADD COLUMN pos_y REAL NOT NULL DEFAULT 0; " +
      "UPDATE sticky_notes SET pos_x = (abs(random()) % 460) + 16, pos_y = (abs(random()) % 320) + 16",
  },
  // Artifact comments: an AI edit driven by a comment keeps one prior version
  // for undo, and bumps a revision counter. A DB from the v1.2.0 artifacts
  // release has the table but not these columns.
  { table: "artifacts", column: "prev_html", ddl: "ALTER TABLE artifacts ADD COLUMN prev_html TEXT" },
  { table: "artifacts", column: "revision", ddl: "ALTER TABLE artifacts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0" },
];

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // Add columns that post-date a database's creation, then (re)create the
  // indexes that depend on them. Idempotent: safe to run on every startup.
  private migrate() {
    for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(ddl);
      }
    }
    // source_path is unique *per user* now (two family members can each have a
    // watched folder with a file at the same path). Drop the old global-unique
    // index if a previous build created it.
    this.db.exec("DROP INDEX IF EXISTS idx_documents_source_path");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_user_source ON documents(user_id, source_path)"
    );
    for (const table of ["tasks", "documents", "activity", "tools"] as const) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_user ON ${table}(user_id)`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)");

    this.migrateSearchIndex();
  }

  // ---- full-text search (FTS5) ----
  // Keyword search over documents and tasks, so a family with hundreds of
  // documents isn't answered by dumping every row into a small model's
  // context (the old list-everything approach — see docs/DECISIONS.md,
  // "Document/task search"). Standalone FTS5 mirror tables kept in step by
  // triggers on the base tables: search can't drift out of sync with the
  // data no matter which code path did the write, the same principle as the
  // activity log being written inline by every mutating method. `user_id`
  // rides along UNINDEXED so a search stays scoped to one family member
  // without a join back to the base table. Built here rather than in SCHEMA
  // because the triggers reference `user_id`, which a legacy single-user DB
  // only gains in the column migrations above. Idempotent — runs every start.
  private migrateSearchIndex() {
    // If an earlier build created these mirrors with a different column set,
    // drop them — CREATE ... IF NOT EXISTS won't reshape an existing table,
    // and reconcileFtsTable() below repopulates from scratch anyway.
    this.dropFtsTableIfColumnsDiffer("documents_fts", ["doc_id", "user_id", "filename", "body", "summary", "category"]);
    this.dropFtsTableIfColumnsDiffer("tasks_fts", ["task_id", "user_id", "title", "notes"]);
    // Fuzzy/substring mirror of documents (trigram tokenizer). Documents only —
    // task titles are short enough that keyword + prefix already covers typos.
    this.dropFtsTableIfColumnsDiffer("documents_trigram", ["doc_id", "user_id", "filename", "body", "summary"]);

    // Triggers are dropped and recreated every start (not CREATE IF NOT
    // EXISTS) so the trigger body always matches the column list this build
    // expects — a mirror reshape or a body change can't leave a stale trigger
    // behind.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        doc_id UNINDEXED, user_id UNINDEXED, filename, body, summary, category,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
        task_id UNINDEXED, user_id UNINDEXED, title, notes,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram USING fts5(
        doc_id UNINDEXED, user_id UNINDEXED, filename, body, summary,
        tokenize = 'trigram'
      );

      DROP TRIGGER IF EXISTS documents_fts_ai;
      DROP TRIGGER IF EXISTS documents_fts_ad;
      DROP TRIGGER IF EXISTS documents_fts_au;
      DROP TRIGGER IF EXISTS tasks_fts_ai;
      DROP TRIGGER IF EXISTS tasks_fts_ad;
      DROP TRIGGER IF EXISTS tasks_fts_au;

      -- The documents_fts_* triggers below also maintain documents_trigram and
      -- clear document_embeddings on delete, so all four document-search
      -- mirrors move in lockstep with the base row no matter which code path
      -- wrote it (same "can't drift" rule as the activity log).
      CREATE TRIGGER documents_fts_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(doc_id, user_id, filename, body, summary, category)
        VALUES (new.id, new.user_id, new.filename, new.raw_text,
                COALESCE(json_extract(new.extracted, '$.summary'), ''),
                COALESCE(json_extract(new.extracted, '$.category'), ''));
        INSERT INTO documents_trigram(doc_id, user_id, filename, body, summary)
        VALUES (new.id, new.user_id, new.filename, new.raw_text,
                COALESCE(json_extract(new.extracted, '$.summary'), ''));
      END;
      CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
        DELETE FROM documents_trigram WHERE doc_id = old.id;
        DELETE FROM document_embeddings WHERE doc_id = old.id;
      END;
      CREATE TRIGGER documents_fts_au AFTER UPDATE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
        DELETE FROM documents_trigram WHERE doc_id = old.id;
        INSERT INTO documents_fts(doc_id, user_id, filename, body, summary, category)
        VALUES (new.id, new.user_id, new.filename, new.raw_text,
                COALESCE(json_extract(new.extracted, '$.summary'), ''),
                COALESCE(json_extract(new.extracted, '$.category'), ''));
        INSERT INTO documents_trigram(doc_id, user_id, filename, body, summary)
        VALUES (new.id, new.user_id, new.filename, new.raw_text,
                COALESCE(json_extract(new.extracted, '$.summary'), ''));
      END;

      CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO tasks_fts(task_id, user_id, title, notes)
        VALUES (new.id, new.user_id, new.title, COALESCE(new.notes, ''));
      END;
      CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
        DELETE FROM tasks_fts WHERE task_id = old.id;
      END;
      CREATE TRIGGER tasks_fts_au AFTER UPDATE ON tasks BEGIN
        DELETE FROM tasks_fts WHERE task_id = old.id;
        INSERT INTO tasks_fts(task_id, user_id, title, notes)
        VALUES (new.id, new.user_id, new.title, COALESCE(new.notes, ''));
      END;
    `);
    // Backfill on first upgrade, and self-heal if the mirror ever drifts:
    // a row-count mismatch is a cheap, good-enough signal at family scale
    // (a full rebuild here is milliseconds for thousands of rows).
    this.reconcileFtsTable(
      "documents_fts",
      "documents",
      "doc_id, user_id, filename, body, summary, category",
      "id, user_id, filename, raw_text, COALESCE(json_extract(extracted, '$.summary'), ''), " +
        "COALESCE(json_extract(extracted, '$.category'), '')"
    );
    this.reconcileFtsTable(
      "documents_trigram",
      "documents",
      "doc_id, user_id, filename, body, summary",
      "id, user_id, filename, raw_text, COALESCE(json_extract(extracted, '$.summary'), '')"
    );
    this.reconcileFtsTable(
      "tasks_fts",
      "tasks",
      "task_id, user_id, title, notes",
      "id, user_id, title, COALESCE(notes, '')"
    );
  }

  private dropFtsTableIfColumnsDiffer(ftsTable: string, expected: string[]) {
    const cols = this.db.prepare(`PRAGMA table_info(${ftsTable})`).all() as { name: string }[];
    if (cols.length === 0) return; // doesn't exist yet
    const names = cols.map((c) => c.name);
    if (names.length !== expected.length || names.some((n, i) => n !== expected[i])) {
      this.db.exec(`DROP TABLE ${ftsTable}`);
    }
  }

  private reconcileFtsTable(ftsTable: string, base: string, insertCols: string, selectExpr: string) {
    const baseN = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${base}`).get() as any).n);
    const ftsN = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${ftsTable}`).get() as any).n);
    if (baseN === ftsN) return;
    this.db.exec(`DELETE FROM ${ftsTable}`);
    this.db.exec(`INSERT INTO ${ftsTable}(${insertCols}) SELECT ${selectExpr} FROM ${base}`);
  }

  /** Drop and rebuild the keyword + fuzzy search mirrors from the base tables.
   *  For ops/tests. Does NOT touch document_embeddings — that mirror is rebuilt
   *  by embeddings.ts's backfill, which needs the model. */
  rebuildSearchIndex() {
    this.db.exec("DELETE FROM documents_fts");
    this.db.exec("DELETE FROM tasks_fts");
    this.db.exec("DELETE FROM documents_trigram");
    this.db.exec(
      "INSERT INTO documents_fts(doc_id, user_id, filename, body, summary, category) " +
        "SELECT id, user_id, filename, raw_text, COALESCE(json_extract(extracted, '$.summary'), ''), " +
        "COALESCE(json_extract(extracted, '$.category'), '') FROM documents"
    );
    this.db.exec(
      "INSERT INTO documents_trigram(doc_id, user_id, filename, body, summary) " +
        "SELECT id, user_id, filename, raw_text, COALESCE(json_extract(extracted, '$.summary'), '') FROM documents"
    );
    this.db.exec(
      "INSERT INTO tasks_fts(task_id, user_id, title, notes) " +
        "SELECT id, user_id, title, COALESCE(notes, '') FROM tasks"
    );
  }

  close() {
    this.db.close();
  }

  /** Raw handle — only for ScopedStore, which lives in this module. */
  get handle(): DatabaseSync {
    return this.db;
  }

  scoped(userId: string): ScopedStore {
    return new ScopedStore(this.db, userId);
  }

  // ---- users ----
  createUser(input: {
    username: string;
    displayName: string;
    password: string;
    role?: UserRole;
    inboxDir?: string | null;
  }): UserRecord {
    const rec: UserRecord = {
      id: shortId(),
      username: input.username.trim(),
      displayName: input.displayName.trim(),
      role: input.role ?? "member",
      inboxDir: input.inboxDir ?? null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO users (id, username, display_name, password_hash, role, inbox_dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(rec.id, rec.username, rec.displayName, hashPassword(input.password), rec.role, rec.inboxDir, rec.createdAt);
    return rec;
  }

  getUser(id: string): UserRecord | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
    return row ? rowToUser(row) : undefined;
  }

  getUserByUsername(username: string): UserRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(username.trim()) as any;
    return row ? rowToUser(row) : undefined;
  }

  /** The stored password hash for a user, for verifyPassword(). */
  getPasswordHash(id: string): string | undefined {
    const row = this.db.prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as any;
    return row?.password_hash;
  }

  listUsers(): UserRecord[] {
    const rows = this.db.prepare("SELECT * FROM users ORDER BY created_at ASC").all() as any[];
    return rows.map(rowToUser);
  }

  countUsers(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as any).n);
  }

  countAdmins(): number {
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as any).n
    );
  }

  updateUser(
    id: string,
    patch: { displayName?: string; password?: string; role?: UserRole; inboxDir?: string | null }
  ): UserRecord | undefined {
    const user = this.getUser(id);
    if (!user) return undefined;
    if (patch.displayName !== undefined)
      this.db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(patch.displayName.trim(), id);
    if (patch.password !== undefined)
      this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(patch.password), id);
    if (patch.role !== undefined)
      this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(patch.role, id);
    if (patch.inboxDir !== undefined)
      this.db.prepare("UPDATE users SET inbox_dir = ? WHERE id = ?").run(patch.inboxDir, id);
    return this.getUser(id);
  }

  deleteUser(id: string): UserRecord | undefined {
    const user = this.getUser(id);
    if (!user) return undefined;
    // Everything the user owned goes with them — this is a hard delete, not a
    // soft "disable". A family removing an account wants the data gone.
    for (const table of [
      "tasks",
      "document_embeddings",
      "documents",
      "activity",
      "tools",
      "sessions",
      "channel_members",
      "sticky_notes",
      "chat_messages",
      "chat_sessions",
      "routines",
      "routine_runs",
      "vault_entries",
      "vault_access_log",
      "vault_keys",
    ] as const) {
      this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id);
    }
    // Their sent messages stay (clients render an unknown sender gracefully),
    // but a DM now missing one side is dead, and so is any channel with nobody
    // left in it — drop both (and their messages).
    const dead = this.db
      .prepare(
        `SELECT c.id FROM channels c
         WHERE (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) < CASE c.kind WHEN 'dm' THEN 2 ELSE 1 END`
      )
      .all() as any[];
    for (const { id: cid } of dead) {
      this.db.prepare("DELETE FROM messages WHERE channel_id = ?").run(cid);
      this.db.prepare("DELETE FROM channel_members WHERE channel_id = ?").run(cid);
      this.db.prepare("DELETE FROM channels WHERE id = ?").run(cid);
    }
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return user;
  }

  /** Minimal public directory of every account — for the chat / mention pickers.
   *  Unlike listUsers() this is not admin-gated; it carries no role or hash. */
  listFamilyMembers(): ChannelMemberInfo[] {
    const rows = this.db
      .prepare("SELECT id, username, display_name FROM users ORDER BY display_name COLLATE NOCASE ASC")
      .all() as any[];
    return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name }));
  }

  // ---- family chat (cross-account) ----
  // Membership is the access boundary: every read takes the requesting user id
  // and yields nothing when they aren't in `channel_members`, so a missed
  // check surfaces as "empty" rather than another family's messages.

  isChannelMember(channelId: string, userId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .get(channelId, userId);
  }

  channelMemberIds(channelId: string): string[] {
    return (
      this.db.prepare("SELECT user_id FROM channel_members WHERE channel_id = ?").all(channelId) as any[]
    ).map((r) => r.user_id);
  }

  private channelMemberInfo(channelId: string): ChannelMemberInfo[] {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name FROM channel_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = ? ORDER BY u.display_name COLLATE NOCASE ASC`
      )
      .all(channelId) as any[];
    return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name }));
  }

  private channelRow(channelId: string): ChannelRecord | undefined {
    const r = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as any;
    return r ? rowToChannel(r) : undefined;
  }

  /** A channel + its members, but only if `userId` is one of them. */
  getChannelForUser(channelId: string, userId: string): ChannelDetail | undefined {
    if (!this.isChannelMember(channelId, userId)) return undefined;
    const channel = this.channelRow(channelId);
    if (!channel) return undefined;
    return { ...channel, members: this.channelMemberInfo(channelId) };
  }

  /** DM title = the other member's name; group title = its name (or a member join). */
  private channelTitle(channel: ChannelRecord, members: ChannelMemberInfo[], forUserId: string): string {
    if (channel.kind === "group") {
      return channel.name || members.map((m) => m.displayName).join(", ");
    }
    const others = members.filter((m) => m.id !== forUserId);
    return others.map((m) => m.displayName).join(", ") || "Note to self";
  }

  listChannelsForUser(userId: string): ChannelSummary[] {
    const ids = (
      this.db
        .prepare("SELECT channel_id FROM channel_members WHERE user_id = ?")
        .all(userId) as any[]
    ).map((r) => r.channel_id);

    const summaries = ids
      .map((id) => {
        const channel = this.channelRow(id);
        if (!channel) return undefined;
        const members = this.channelMemberInfo(id);
        const last = this.db
          .prepare(
            "SELECT sender_id, body, pending, created_at FROM messages WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
          )
          .get(id) as any;
        const readRow = this.db
          .prepare("SELECT last_read_at FROM channel_members WHERE channel_id = ? AND user_id = ?")
          .get(id, userId) as any;
        const lastReadAt: string | null = readRow?.last_read_at ?? null;
        const unread = Number(
          (
            this.db
              .prepare(
                `SELECT COUNT(*) AS n FROM messages
                 WHERE channel_id = ? AND sender_id != ? AND pending = 0
                 AND (? IS NULL OR created_at > ?)`
              )
              .get(id, userId, lastReadAt, lastReadAt) as any
          ).n
        );
        return {
          ...channel,
          members,
          title: this.channelTitle(channel, members, userId),
          lastMessage: last
            ? {
                senderId: last.sender_id,
                body: last.body,
                createdAt: last.created_at,
                pending: !!last.pending,
              }
            : null,
          unreadCount: unread,
        } as ChannelSummary;
      })
      .filter((c): c is ChannelSummary => !!c);

    // Most recent activity first; a channel with no messages sorts by creation.
    summaries.sort((a, b) => {
      const at = a.lastMessage?.createdAt ?? a.createdAt;
      const bt = b.lastMessage?.createdAt ?? b.createdAt;
      return bt < at ? -1 : bt > at ? 1 : 0;
    });
    return summaries;
  }

  /** Idempotent: one canonical DM channel per unordered pair of user ids. */
  findOrCreateDm(userIdA: string, userIdB: string): ChannelDetail {
    if (userIdA === userIdB) throw new Error("A DM needs two different people.");
    // A DM channel is exactly the two of them and nobody else.
    const existing = this.db
      .prepare(
        `SELECT c.id FROM channels c
         WHERE c.kind = 'dm'
         AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) = 2
         AND EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = ?)
         AND EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = ?)
         LIMIT 1`
      )
      .get(userIdA, userIdB) as any;
    if (existing) return this.getChannelForUser(existing.id, userIdA)!;

    const now = new Date().toISOString();
    const id = shortId();
    this.db
      .prepare("INSERT INTO channels (id, kind, name, created_by, created_at) VALUES (?, 'dm', NULL, ?, ?)")
      .run(id, userIdA, now);
    for (const uid of [userIdA, userIdB]) {
      this.db
        .prepare("INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)")
        .run(id, uid, now);
    }
    return this.getChannelForUser(id, userIdA)!;
  }

  createGroupChannel(createdBy: string, name: string, memberIds: string[]): ChannelDetail {
    const now = new Date().toISOString();
    const id = shortId();
    this.db
      .prepare("INSERT INTO channels (id, kind, name, created_by, created_at) VALUES (?, 'group', ?, ?, ?)")
      .run(id, name.trim(), createdBy, now);
    const all = new Set([createdBy, ...memberIds]);
    for (const uid of all) {
      if (!this.getUser(uid)) continue; // skip unknown ids rather than fail the whole create
      this.db
        .prepare("INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)")
        .run(id, uid, now);
    }
    return this.getChannelForUser(id, createdBy)!;
  }

  /** Add members to a group. `requesterId` must already be a member. */
  addChannelMembers(channelId: string, requesterId: string, memberIds: string[]): ChannelDetail | undefined {
    const channel = this.channelRow(channelId);
    if (!channel || channel.kind !== "group") return undefined;
    if (!this.isChannelMember(channelId, requesterId)) return undefined;
    const now = new Date().toISOString();
    for (const uid of memberIds) {
      if (!this.getUser(uid)) continue;
      this.db
        .prepare("INSERT OR IGNORE INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, ?)")
        .run(channelId, uid, now);
    }
    return this.getChannelForUser(channelId, requesterId);
  }

  listMessages(
    channelId: string,
    userId: string,
    opts: { afterTs?: string | null; limit?: number } = {}
  ): MessageRecord[] {
    if (!this.isChannelMember(channelId, userId)) return [];
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const rows = (
      opts.afterTs
        ? this.db
            .prepare(
              "SELECT * FROM messages WHERE channel_id = ? AND created_at > ? ORDER BY created_at ASC, rowid ASC LIMIT ?"
            )
            .all(channelId, opts.afterTs, limit)
        : this.db
            .prepare(
              "SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
            )
            .all(channelId, limit)
    ) as any[];
    const msgs = rows.map(rowToMessage);
    // The unbounded (initial) query pulls newest-first for the LIMIT; hand it
    // back oldest-first like the incremental case.
    return opts.afterTs ? msgs : msgs.reverse();
  }

  postMessage(channelId: string, senderId: string, body: string, images: string[] = []): MessageRecord {
    const rec: MessageRecord = {
      id: shortId(),
      channelId,
      senderId,
      body,
      images,
      steps: [],
      cards: [],
      pending: false,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO messages (id, channel_id, sender_id, body, pending, images, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)"
      )
      .run(
        rec.id,
        rec.channelId,
        rec.senderId,
        rec.body,
        images.length ? JSON.stringify(images) : null,
        rec.createdAt
      );
    return rec;
  }

  /** A placeholder the AI reply fills in later (clients show "typing…"). */
  insertPendingAgentMessage(channelId: string): MessageRecord {
    const rec: MessageRecord = {
      id: shortId(),
      channelId,
      senderId: AGENT_SENDER_ID,
      body: "",
      images: [],
      steps: [],
      cards: [],
      pending: true,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO messages (id, channel_id, sender_id, body, pending, created_at) VALUES (?, ?, ?, '', 1, ?)"
      )
      .run(rec.id, rec.channelId, rec.senderId, rec.createdAt);
    return rec;
  }

  resolvePendingAgentMessage(
    messageId: string,
    body: string,
    steps: AgentStep[] = [],
    cards: CardRecord[] = []
  ): void {
    this.db
      .prepare("UPDATE messages SET body = ?, pending = 0, steps = ?, cards = ? WHERE id = ?")
      .run(
        body,
        steps.length ? JSON.stringify(steps) : null,
        cards.length ? JSON.stringify(cards) : null,
        messageId
      );
  }

  /** Any agent messages left "pending" by a killed process will never finish. */
  failStalePendingMessages(): number {
    const info = this.db
      .prepare(
        "UPDATE messages SET pending = 0, body = '(the assistant didn''t finish replying)' WHERE pending = 1"
      )
      .run();
    return Number(info.changes ?? 0);
  }

  markChannelRead(channelId: string, userId: string, ts: string): void {
    this.db
      .prepare("UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?")
      .run(ts, channelId, userId);
  }

  /** Delete a channel and everything in it. Any member can — a conversation is
   *  shared, so the delete is shared too: messages and membership go for
   *  everyone. Returns false when the caller isn't a member. */
  deleteChannel(channelId: string, userId: string): boolean {
    if (!this.isChannelMember(channelId, userId)) return false;
    this.db.prepare("DELETE FROM messages WHERE channel_id = ?").run(channelId);
    this.db.prepare("DELETE FROM channel_members WHERE channel_id = ?").run(channelId);
    this.db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
    return true;
  }

  /** Hand every row still owned by the legacy sentinel to a real user. */
  reassignLegacyData(userId: string): number {
    let moved = 0;
    for (const table of ["tasks", "documents", "activity", "tools"] as const) {
      const info = this.db
        .prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`)
        .run(userId, LEGACY_USER_ID);
      moved += Number(info.changes ?? 0);
    }
    return moved;
  }

  // ---- password vault: key-wrapping rows ----
  // These live on the base Store, not ScopedStore: provisioning the shared
  // "family" key for a new member reads every member's public key, and the
  // login/bootstrap routes touch a user's row before a ScopedStore for them
  // is in hand.

  getVaultKeys(userId: string): VaultKeysRow | undefined {
    const r = this.db.prepare("SELECT * FROM vault_keys WHERE user_id = ?").get(userId) as any;
    return r ? rowToVaultKeys(r) : undefined;
  }

  hasVaultSetup(): boolean {
    return !!this.db.prepare("SELECT 1 FROM vault_keys LIMIT 1").get();
  }

  /** True once any member holds the sealed family key (i.e. the shared vault
   *  has been initialised). */
  hasFamilyVaultKey(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM vault_keys WHERE family_key_sealed IS NOT NULL LIMIT 1")
      .get();
  }

  insertVaultKeys(row: VaultKeysRow): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO vault_keys
          (user_id, kdf_params, kdf_salt, dek_wrapped_login, recovery_salt, dek_wrapped_recovery,
           public_key, private_key_wrapped, family_key_sealed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.userId,
        row.kdfParams,
        row.kdfSalt,
        row.dekWrappedLogin,
        row.recoverySalt,
        row.dekWrappedRecovery,
        row.publicKey,
        row.privateKeyWrapped,
        row.familyKeySealed,
        row.createdAt ?? now,
        now
      );
  }

  setVaultLoginWrap(
    userId: string,
    fields: { kdfParams: string; kdfSalt: Buffer; dekWrappedLogin: Buffer }
  ): void {
    this.db
      .prepare(
        "UPDATE vault_keys SET kdf_params = ?, kdf_salt = ?, dek_wrapped_login = ?, updated_at = ? WHERE user_id = ?"
      )
      .run(fields.kdfParams, fields.kdfSalt, fields.dekWrappedLogin, new Date().toISOString(), userId);
  }

  setVaultRecoveryWrap(
    userId: string,
    fields: { recoverySalt: Buffer; dekWrappedRecovery: Buffer }
  ): void {
    this.db
      .prepare(
        "UPDATE vault_keys SET recovery_salt = ?, dek_wrapped_recovery = ?, updated_at = ? WHERE user_id = ?"
      )
      .run(fields.recoverySalt, fields.dekWrappedRecovery, new Date().toISOString(), userId);
  }

  setVaultFamilySeal(userId: string, sealed: Buffer): void {
    this.db
      .prepare("UPDATE vault_keys SET family_key_sealed = ?, updated_at = ? WHERE user_id = ?")
      .run(sealed, new Date().toISOString(), userId);
  }

  /** {userId, publicKey, hasFamilyKey} for every provisioned vault — drives
   *  VaultService.syncFamilyKeys. */
  listVaultPublicKeys(): { userId: string; publicKey: Buffer; hasFamilyKey: boolean }[] {
    return (
      this.db
        .prepare("SELECT user_id, public_key, family_key_sealed FROM vault_keys")
        .all() as any[]
    ).map((r) => ({
      userId: r.user_id,
      publicKey: toBuf(r.public_key),
      hasFamilyKey: r.family_key_sealed != null,
    }));
  }

  // ---- sessions ----
  createSession(userId: string, deviceLabel?: string | null): { token: string; expiresAt: string } {
    const token = newSessionToken();
    const now = Date.now();
    const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    this.db
      .prepare(
        "INSERT INTO sessions (token_hash, user_id, device_label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(sha256Hex(token), userId, deviceLabel ?? null, new Date(now).toISOString(), new Date(now).toISOString(), expiresAt);
    return { token, expiresAt };
  }

  /**
   * Resolve a bearer token to its user, sliding the expiry forward. Returns
   * undefined for an unknown or expired token (and drops the expired row).
   */
  resolveSession(token: string): UserRecord | undefined {
    const hash = sha256Hex(token);
    const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hash) as any;
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
      return undefined;
    }
    const now = Date.now();
    this.db
      .prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
      .run(new Date(now).toISOString(), new Date(now + SESSION_TTL_MS).toISOString(), hash);
    return this.getUser(row.user_id);
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(token));
  }

  deleteSessionsForUser(userId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  purgeExpiredSessions(): number {
    const info = this.db
      .prepare("DELETE FROM sessions WHERE expires_at < ?")
      .run(new Date().toISOString());
    return Number(info.changes ?? 0);
  }

  // ---- phone pairing (QR auto sign-in) ----

  /**
   * Mint a single-use pairing token for `userId`. Any prior unredeemed token
   * for that user is dropped first — only the QR currently on screen is live.
   */
  createPairingToken(userId: string): { token: string; expiresAt: string } {
    const now = Date.now();
    this.db
      .prepare("DELETE FROM pairing_tokens WHERE user_id = ? OR expires_at < ?")
      .run(userId, new Date(now).toISOString());
    const token = newSessionToken();
    const expiresAt = new Date(now + PAIRING_TOKEN_TTL_MS).toISOString();
    this.db
      .prepare("INSERT INTO pairing_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256Hex(token), userId, new Date(now).toISOString(), expiresAt);
    return { token, expiresAt };
  }

  /**
   * Consume a pairing token. The row is deleted whatever the outcome (so a
   * token works exactly once); returns the bound user only if it existed and
   * hadn't expired.
   */
  redeemPairingToken(token: string): UserRecord | undefined {
    const hash = sha256Hex(token);
    const row = this.db.prepare("SELECT * FROM pairing_tokens WHERE token_hash = ?").get(hash) as
      | { user_id: string; expires_at: string }
      | undefined;
    this.db.prepare("DELETE FROM pairing_tokens WHERE token_hash = ?").run(hash);
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() < Date.now()) return undefined;
    return this.getUser(row.user_id);
  }

  /**
   * Look up a tool by its (globally unique) id regardless of owner. Only the
   * tools HTTP server uses this — it serves a generated tool's static assets
   * by id from a single unauthenticated port, and the id itself is the
   * capability. Everything else goes through ScopedStore.getTool().
   */
  getToolAny(id: string): (ToolRecord & { userId: string }) | undefined {
    const row = this.db.prepare("SELECT * FROM tools WHERE id = ?").get(id) as any;
    return row ? { ...rowToTool_(row), userId: row.user_id } : undefined;
  }

  // ---- global startup housekeeping (all users) ----

  // Any document still "pending" when the server starts belongs to a process
  // that is no longer running — its extraction will never resume on its own.
  failStalePendingExtractions(): number {
    const info = this.db
      .prepare("UPDATE documents SET extraction_status = 'failed' WHERE extraction_status = 'pending'")
      .run();
    return Number(info.changes ?? 0);
  }

  // A build that was still "building" when the process died will never finish.
  failStaleBuildingTools(): number {
    const info = this.db
      .prepare("UPDATE tools SET status = 'failed', error = 'The build was interrupted — try again.' WHERE status = 'building'")
      .run();
    // An improve that was mid-flight at shutdown: the tool's live files are
    // untouched (staging is separate), so it still works — just surface that
    // the change didn't land.
    this.db
      .prepare(
        "UPDATE tools SET revision_state = 'The last change was interrupted — try again.' WHERE revision_state = 'revising'"
      )
      .run();
    return Number(info.changes ?? 0);
  }

  // ---- scheduled routines (cross-user, for the scheduler) ----
  // ScopedStore owns per-user routine CRUD; these two let the process-wide
  // RoutineScheduler find work without knowing users up front.

  /** {id, userId} for every enabled routine — drives startup reconciliation. */
  allEnabledRoutineIds(): { id: string; userId: string }[] {
    return (
      this.db.prepare("SELECT id, user_id FROM routines WHERE enabled = 1").all() as any[]
    ).map((r) => ({ id: r.id, userId: r.user_id }));
  }

  /** {id, userId} for every enabled routine whose next_run_at has arrived. */
  dueRoutineIds(nowIso: string): { id: string; userId: string }[] {
    return (
      this.db
        .prepare(
          "SELECT id, user_id FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?"
        )
        .all(nowIso) as any[]
    ).map((r) => ({ id: r.id, userId: r.user_id }));
  }

  /** A run left "running" by a killed process will never finish on its own. */
  failStaleRoutineRuns(): number {
    const info = this.db
      .prepare(
        "UPDATE routine_runs SET status = 'error', error = 'The run was interrupted.', finished_at = ? WHERE status = 'running'"
      )
      .run(new Date().toISOString());
    return Number(info.changes ?? 0);
  }
}

/**
 * Every task/document/activity/tool operation goes through here, bound to one
 * user id. The server builds one per authenticated request; the agent, its
 * subagents, and each user's inbox watcher get one too. This is the isolation
 * boundary — nothing below ever runs a query without `WHERE user_id = ?`, so a
 * bug that forgets to scope shows up as "no rows" rather than "another
 * family member's rows". Method names match the old single-user `Store` so
 * makeTaskTools / makeDocumentTools / extraction / inboxWatcher didn't change.
 */
export class ScopedStore {
  constructor(private db: DatabaseSync, public readonly userId: string) {}

  // ---- activity log ----
  logActivity(actor: string, action: string, detail: string): ActivityRecord {
    const rec: ActivityRecord = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      actor,
      action,
      detail,
    };
    this.db
      .prepare("INSERT INTO activity (id, user_id, ts, actor, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(rec.id, this.userId, rec.ts, rec.actor, rec.action, rec.detail);
    return rec;
  }

  listActivity(limit = 100): ActivityRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM activity WHERE user_id = ? ORDER BY ts DESC LIMIT ?")
      .all(this.userId, limit) as any[];
    return rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, detail: r.detail }));
  }

  // ---- tasks ----
  createTask(input: {
    title: string;
    notes?: string | null;
    dueDate?: string | null;
    dueTime?: string | null;
  }): TaskRecord {
    const now = new Date().toISOString();
    const dueDate = input.dueDate ?? null;
    const rec: TaskRecord = {
      id: shortId(),
      title: input.title,
      notes: input.notes ?? null,
      dueDate,
      // A time with no date is meaningless — drop it.
      dueTime: dueDate ? input.dueTime ?? null : null,
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO tasks (id, user_id, title, notes, due_date, due_time, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        rec.id,
        this.userId,
        rec.title,
        rec.notes,
        rec.dueDate,
        rec.dueTime,
        rec.status,
        rec.createdAt,
        rec.updatedAt
      );
    this.logActivity("task-agent", "task.created", `Created task "${rec.title}"`);
    return rec;
  }

  listTasks(status?: "open" | "done"): TaskRecord[] {
    const rows = (
      status
        ? this.db
            .prepare("SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY created_at DESC")
            .all(this.userId, status)
        : this.db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC").all(this.userId)
    ) as any[];
    return rows.map(rowToTask);
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").get(id, this.userId) as any;
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Keyword search over this user's task titles and notes, best match first.
   * An empty / unparseable query falls back to a recency listing (optionally
   * status-filtered), so `searchTasks("", { status: "open" })` is "my open
   * tasks". See `toFtsMatchQuery`.
   */
  searchTasks(
    query: string,
    opts: { status?: "open" | "done"; limit?: number } = {}
  ): TaskSearchHit[] {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const match = toFtsMatchQuery(query);
    const where: string[] = ["t.user_id = ?"];
    const params: unknown[] = [this.userId];
    let fromClause: string;
    let orderClause: string;
    let snippetExpr: string;

    if (match) {
      fromClause = "tasks_fts f JOIN tasks t ON t.id = f.task_id";
      where.unshift("f.user_id = ?");
      params.unshift(this.userId);
      where.push("tasks_fts MATCH ?");
      params.push(match);
      orderClause = "bm25(tasks_fts)";
      snippetExpr = "snippet(tasks_fts, 3, '', '', ' … ', 12)";
    } else {
      fromClause = "tasks t";
      orderClause = "t.created_at DESC, t.rowid DESC";
      snippetExpr = "COALESCE(t.notes, '')";
    }
    if (opts.status) {
      where.push("t.status = ?");
      params.push(opts.status);
    }

    const rows = this.db
      .prepare(
        `SELECT t.id, t.title, t.notes, t.due_date, t.due_time, t.status, ${snippetExpr} AS snippet
         FROM ${fromClause}
         WHERE ${where.join(" AND ")}
         ORDER BY ${orderClause}
         LIMIT ?`
      )
      .all(...(params as any[]), limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      notes: r.notes ?? null,
      dueDate: r.due_date ?? null,
      dueTime: r.due_time ?? null,
      status: r.status,
      snippet: String(r.snippet ?? "").trim(),
    }));
  }

  updateTaskStatus(id: string, status: "open" | "done"): TaskRecord | undefined {
    return this.updateTask(id, { status });
  }

  /**
   * Patch a task's status, due date, and/or due time. `null` clears a field;
   * omitting the key leaves it untouched. Callers must supply at least one key.
   * Clearing `dueDate` also clears `dueTime` (a time with no date is meaningless).
   */
  updateTask(
    id: string,
    patch: { status?: "open" | "done"; dueDate?: string | null; dueTime?: string | null }
  ): TaskRecord | undefined {
    const existing = this.getTask(id);
    if (!existing) return undefined;

    // Resolve the target date/time, applying the "time needs a date" invariant.
    const nextDate = "dueDate" in patch ? patch.dueDate ?? null : existing.dueDate;
    let nextTime = "dueTime" in patch ? patch.dueTime ?? null : existing.dueTime;
    if (!nextDate) nextTime = null;

    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (nextDate !== existing.dueDate) {
      sets.push("due_date = ?");
      values.push(nextDate);
    }
    if (nextTime !== existing.dueTime) {
      sets.push("due_time = ?");
      values.push(nextTime);
    }
    if (sets.length === 0) return existing;
    const now = new Date().toISOString();
    sets.push("updated_at = ?");
    values.push(now);
    this.db
      .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .run(...values, id, this.userId);
    const updated = this.getTask(id);
    if (updated) {
      if (patch.status !== undefined && patch.status !== existing.status) {
        this.logActivity("task-agent", "task.updated", `Marked task "${updated.title}" as ${patch.status}`);
      }
      if (updated.dueDate !== existing.dueDate || updated.dueTime !== existing.dueTime) {
        this.logActivity(
          "task-agent",
          "task.updated",
          updated.dueDate
            ? `Rescheduled task "${updated.title}" to ${updated.dueDate}${updated.dueTime ? ` ${updated.dueTime}` : ""}`
            : `Cleared due date on task "${updated.title}"`
        );
      }
    }
    return updated;
  }

  // ---- documents ----
  createDocument(input: {
    filename: string;
    rawText: string;
    extracted?: Record<string, unknown> | null;
    sourcePath?: string | null;
  }): DocumentRecord {
    const rec: DocumentRecord = {
      id: shortId(),
      filename: input.filename,
      rawText: input.rawText,
      extracted: input.extracted ?? null,
      createdAt: new Date().toISOString(),
      sourcePath: input.sourcePath ?? null,
      originalMime: null,
      originalDiskName: null,
      extractionStatus: input.extracted ? "done" : "pending",
    };
    this.db
      .prepare(
        "INSERT INTO documents (id, user_id, filename, raw_text, extracted, created_at, source_path, extraction_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        rec.id,
        this.userId,
        rec.filename,
        rec.rawText,
        rec.extracted ? JSON.stringify(rec.extracted) : null,
        rec.createdAt,
        rec.sourcePath,
        rec.extractionStatus
      );
    this.logActivity(
      "document-agent",
      "document.ingested",
      rec.sourcePath ? `Added "${rec.filename}" from the watched folder` : `Added "${rec.filename}"`
    );
    return rec;
  }

  /** Record the MIME type of a stored original file (set right after an upload
   *  is written to disk) so the preview route can serve the right Content-Type. */
  setDocumentOriginalMime(id: string, mime: string): void {
    if (!mime) return;
    this.db
      .prepare("UPDATE documents SET original_mime = ? WHERE id = ? AND user_id = ?")
      .run(mime, id, this.userId);
  }

  /** Record the basename a stored original is saved under (see
   *  DocumentRecord.originalDiskName). Set right after the file is written or
   *  moved on disk. */
  setDocumentOriginalDiskName(id: string, diskName: string): void {
    if (!diskName) return;
    this.db
      .prepare("UPDATE documents SET original_disk_name = ? WHERE id = ? AND user_id = ?")
      .run(diskName, id, this.userId);
  }

  findDocumentBySourcePath(sourcePath: string): DocumentRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE source_path = ? AND user_id = ?")
      .get(sourcePath, this.userId) as any;
    return row ? rowToDocument(row) : undefined;
  }

  updateDocumentExtraction(id: string, extracted: Record<string, unknown>): DocumentRecord | undefined {
    if (!this.getDocument(id)) return undefined;
    this.db
      .prepare("UPDATE documents SET extracted = ?, extraction_status = 'done' WHERE id = ? AND user_id = ?")
      .run(JSON.stringify(extracted), id, this.userId);
    const doc = this.getDocument(id);
    if (doc) {
      this.logActivity("document-agent", "document.extracted", `Extracted fields from "${doc.filename}"`);
    }
    return doc;
  }

  /** Rename a document. `by` distinguishes a manual rename from an agent one in the activity log. */
  renameDocument(id: string, filename: string, by: "user" | "document-agent" = "user"): DocumentRecord | undefined {
    const doc = this.getDocument(id);
    if (!doc) return undefined;
    const next = filename.trim();
    if (!next || next === doc.filename) return doc;
    this.db
      .prepare("UPDATE documents SET filename = ? WHERE id = ? AND user_id = ?")
      .run(next, id, this.userId);
    this.logActivity(by, "document.renamed", `Renamed "${doc.filename}" to "${next}"`);
    return this.getDocument(id);
  }

  setDocumentExtractionStatus(id: string, status: ExtractionStatus): DocumentRecord | undefined {
    this.db
      .prepare("UPDATE documents SET extraction_status = ? WHERE id = ? AND user_id = ?")
      .run(status, id, this.userId);
    return this.getDocument(id);
  }

  deleteDocument(id: string): DocumentRecord | undefined {
    const doc = this.getDocument(id);
    if (!doc) return undefined;
    this.db.prepare("DELETE FROM documents WHERE id = ? AND user_id = ?").run(id, this.userId);
    this.logActivity("user", "document.deleted", `Deleted "${doc.filename}"`);
    return doc;
  }

  /** Flip this user's stuck "pending" documents to "failed" (startup). */
  failStalePendingExtractions(): number {
    const info = this.db
      .prepare(
        "UPDATE documents SET extraction_status = 'failed' WHERE extraction_status = 'pending' AND user_id = ?"
      )
      .run(this.userId);
    return Number(info.changes ?? 0);
  }

  getDocument(id: string): DocumentRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE id = ? AND user_id = ?")
      .get(id, this.userId) as any;
    return row ? rowToDocument(row) : undefined;
  }

  listDocuments(): DocumentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC")
      .all(this.userId) as any[];
    return rows.map(rowToDocument);
  }

  /**
   * Search this user's documents (filename + full text + extracted summary),
   * best match first, with optional structured filters on the extracted
   * `category` and `importantDates`. An empty / unparseable query falls back to
   * a recency listing, so `searchDocuments("", { category: "bill" })` is "my
   * bills".
   *
   * `mode`:
   *  - `"keyword"` (default) — FTS5 prefix match, ranked by bm25. See `toFtsMatchQuery`.
   *  - `"fuzzy"` — trigram match (typo- and substring-tolerant), re-ranked and
   *    gated by `trigramSimilarity`. See `toTrigramMatchQuery`.
   *
   * Semantic (embedding) search and the keyword+fuzzy+semantic merge live in
   * `embeddings.ts` (`searchDocumentsSmart`), which calls this method for its
   * lexical legs — this stays a pure, synchronous, model-free SQL method.
   */
  searchDocuments(
    query: string,
    opts: {
      category?: string;
      dueAfter?: string;
      dueBefore?: string;
      limit?: number;
      mode?: "keyword" | "fuzzy";
    } = {}
  ): DocumentSearchHit[] {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
    if (opts.mode === "fuzzy") return this.fuzzyDocuments(query, opts, limit);
    const match = toFtsMatchQuery(query);
    const where: string[] = ["d.user_id = ?"];
    const params: unknown[] = [this.userId];
    let fromClause: string;
    let orderClause: string;
    let snippetExpr: string;

    if (match) {
      fromClause = "documents_fts f JOIN documents d ON d.id = f.doc_id";
      where.unshift("f.user_id = ?");
      params.unshift(this.userId);
      where.push("documents_fts MATCH ?");
      params.push(match);
      orderClause = "bm25(documents_fts)";
      // Column 3 is `body` (0=doc_id, 1=user_id, 2=filename, 3=body, 4=summary).
      snippetExpr = "snippet(documents_fts, 3, '', '', ' … ', 14)";
    } else {
      fromClause = "documents d";
      orderClause = "d.created_at DESC, d.rowid DESC";
      snippetExpr = "substr(d.raw_text, 1, 180)";
    }

    if (opts.category) {
      where.push("json_extract(d.extracted, '$.category') = ?");
      params.push(opts.category);
    }
    if (opts.dueAfter) {
      where.push(
        "json_extract(d.extracted, '$.importantDates') IS NOT NULL AND " +
          "EXISTS (SELECT 1 FROM json_each(d.extracted, '$.importantDates') WHERE value >= ?)"
      );
      params.push(opts.dueAfter);
    }
    if (opts.dueBefore) {
      where.push(
        "json_extract(d.extracted, '$.importantDates') IS NOT NULL AND " +
          "EXISTS (SELECT 1 FROM json_each(d.extracted, '$.importantDates') WHERE value <= ?)"
      );
      params.push(opts.dueBefore);
    }

    const rows = this.db
      .prepare(
        `SELECT d.id, d.filename, d.extracted, d.created_at, d.extraction_status, ${snippetExpr} AS snippet
         FROM ${fromClause}
         WHERE ${where.join(" AND ")}
         ORDER BY ${orderClause}
         LIMIT ?`
      )
      .all(...(params as any[]), limit) as any[];

    return rows.map(rowToDocumentHit);
  }

  /** Structured-filter WHERE fragments shared by the keyword and fuzzy paths.
   *  Appends to `where` / `params` in place; `d` is the documents alias. */
  private appendDocumentFilters(
    where: string[],
    params: unknown[],
    opts: { category?: string; dueAfter?: string; dueBefore?: string }
  ): void {
    if (opts.category) {
      where.push("json_extract(d.extracted, '$.category') = ?");
      params.push(opts.category);
    }
    if (opts.dueAfter) {
      where.push(
        "json_extract(d.extracted, '$.importantDates') IS NOT NULL AND " +
          "EXISTS (SELECT 1 FROM json_each(d.extracted, '$.importantDates') WHERE value >= ?)"
      );
      params.push(opts.dueAfter);
    }
    if (opts.dueBefore) {
      where.push(
        "json_extract(d.extracted, '$.importantDates') IS NOT NULL AND " +
          "EXISTS (SELECT 1 FROM json_each(d.extracted, '$.importantDates') WHERE value <= ?)"
      );
      params.push(opts.dueBefore);
    }
  }

  /**
   * Trigram (fuzzy / substring) document search. FTS5's trigram MATCH pulls a
   * generous candidate pool — every doc sharing a few 3-char runs with the
   * query, bm25-ordered — which is then re-scored with `trigramSimilarity` and
   * gated at a low threshold so a bare 1-trigram coincidence ("the", "ing")
   * doesn't surface. With no trigram-usable word in the query (nothing ≥ 3
   * chars) it degrades to the keyword path, which also owns the empty-query /
   * filter-only recency fallback.
   */
  private fuzzyDocuments(
    query: string,
    opts: { category?: string; dueAfter?: string; dueBefore?: string },
    limit: number
  ): DocumentSearchHit[] {
    const match = toTrigramMatchQuery(query);
    if (!match) return this.searchDocuments(query, { ...opts, limit, mode: "keyword" });

    const where = ["d.user_id = ?", "tg.user_id = ?", "documents_trigram MATCH ?"];
    const params: unknown[] = [this.userId, this.userId, match];
    this.appendDocumentFilters(where, params, opts);

    // Candidate pool: wider than `limit` so the re-rank has room to work, but
    // bounded so a common trigram can't drag in the whole corpus.
    const pool = Math.min(Math.max(limit * 5, 50), 250);
    const rows = this.db
      .prepare(
        `SELECT d.id, d.filename, d.extracted, d.created_at, d.extraction_status,
                snippet(documents_trigram, 3, '', '', ' … ', 14) AS snippet
         FROM documents_trigram tg JOIN documents d ON d.id = tg.doc_id
         WHERE ${where.join(" AND ")}
         ORDER BY bm25(documents_trigram)
         LIMIT ?`
      )
      .all(...(params as any[]), pool) as any[];

    const scored = rows.map((r, i) => {
      const hit = rowToDocumentHit(r);
      const hay = [hit.filename, hit.summary ?? "", hit.snippet].filter(Boolean).join(" ");
      // Blend similarity to the short fields with a small bm25-rank bonus so
      // ties fall back to FTS's own ordering.
      const score = trigramSimilarity(query, hay) + (rows.length - i) / (rows.length * 50);
      return { hit, score };
    });

    return scored
      .filter((s) => s.score >= 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.hit);
  }

  // ---- semantic search (document embeddings) ----
  // These store and read the vector index; the embedding model itself is never
  // touched here (that's embeddings.ts). Vectors are little-endian Float32
  // BLOBs. See docs/DECISIONS.md → "Semantic + fuzzy document search".

  /**
   * Replace this document's embedding rows with `chunks` (one embedded text
   * span each), tagged with the `model` that produced them. Wrapped in a
   * transaction so a crash mid-write never leaves a document half-indexed.
   * No-op if the document doesn't belong to this user.
   */
  upsertDocumentEmbeddings(
    docId: string,
    model: string,
    chunks: { text: string; vector: Float32Array }[]
  ): void {
    if (!this.getDocument(docId)) return;
    const del = this.db.prepare("DELETE FROM document_embeddings WHERE doc_id = ? AND user_id = ?");
    const ins = this.db.prepare(
      "INSERT INTO document_embeddings (doc_id, user_id, chunk_index, chunk_text, model, dim, vec) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    this.db.exec("BEGIN");
    try {
      del.run(docId, this.userId);
      chunks.forEach((c, i) => {
        ins.run(
          docId,
          this.userId,
          i,
          c.text.slice(0, 4000),
          model,
          c.vector.length,
          Buffer.from(c.vector.buffer, c.vector.byteOffset, c.vector.byteLength)
        );
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Best cosine similarity to `queryVector` per document, for this user, over
   * every embedded chunk — brute force, which is fine at family scale. Returns
   * docs scoring at least `minScore` (default 0.2), best first, capped at
   * `limit`. Structured filters mirror `searchDocuments`. Synchronous: the
   * caller embeds the query text and hands the vector in.
   */
  searchDocumentChunksByVector(
    queryVector: Float32Array,
    opts: {
      limit?: number;
      minScore?: number;
      model?: string;
      category?: string;
      dueAfter?: string;
      dueBefore?: string;
    } = {}
  ): { id: string; score: number; snippet: string }[] {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
    const minScore = opts.minScore ?? 0.2;
    const where = ["e.user_id = ?"];
    const params: unknown[] = [this.userId];
    if (opts.model) {
      where.push("e.model = ?");
      params.push(opts.model);
    }
    this.appendDocumentFilters(where, params, opts);

    const rows = this.db
      .prepare(
        `SELECT e.doc_id, e.chunk_text, e.dim, e.vec
         FROM document_embeddings e JOIN documents d ON d.id = e.doc_id
         WHERE ${where.join(" AND ")}`
      )
      .all(...(params as any[])) as any[];

    const q = queryVector;
    const qNorm = vectorNorm(q);
    if (qNorm === 0) return [];
    const best = new Map<string, { score: number; snippet: string }>();
    for (const r of rows) {
      if (r.dim !== q.length) continue; // a stale row from a different model
      const v = bytesToFloat32(r.vec as Uint8Array);
      const vNorm = vectorNorm(v);
      if (vNorm === 0) continue;
      const score = dotProduct(q, v) / (qNorm * vNorm);
      const prev = best.get(r.doc_id);
      if (!prev || score > prev.score) {
        best.set(r.doc_id, { score, snippet: String(r.chunk_text ?? "").replace(/\s+/g, " ").trim().slice(0, 240) });
      }
    }
    return [...best.entries()]
      .map(([id, b]) => ({ id, score: b.score, snippet: b.snippet }))
      .filter((h) => h.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Ids of this user's documents that have no embedding rows for `model` yet
   *  (have some text to embed). Drives the startup backfill. Newest first. */
  documentIdsMissingEmbeddings(model: string, limit = 1000): string[] {
    const rows = this.db
      .prepare(
        `SELECT d.id FROM documents d
         WHERE d.user_id = ?
           AND TRIM(d.raw_text) <> ''
           AND NOT EXISTS (
             SELECT 1 FROM document_embeddings e WHERE e.doc_id = d.id AND e.model = ?
           )
         ORDER BY d.created_at DESC
         LIMIT ?`
      )
      .all(this.userId, model, limit) as any[];
    return rows.map((r) => r.id);
  }

  /** Drop this user's embedding rows not produced by `keepModel` (model
   *  changed). Returns how many were removed. */
  pruneEmbeddingsNotMatching(keepModel: string): number {
    const info = this.db
      .prepare("DELETE FROM document_embeddings WHERE user_id = ? AND model <> ?")
      .run(this.userId, keepModel);
    return Number(info.changes ?? 0);
  }

  /** How many embedding chunks this user has indexed (for /health, tests). */
  embeddingChunkCount(): number {
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM document_embeddings WHERE user_id = ?").get(this.userId) as any).n
    );
  }

  // ---- builder tools ----
  createTool(input: { name: string; description: string; prompt: string; kind: ToolKind }): ToolRecord {
    const rec: ToolRecord = {
      id: shortId(),
      name: input.name,
      description: input.description,
      prompt: input.prompt,
      kind: input.kind,
      status: "building",
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      revisionCount: 0,
      revisionState: null,
    };
    this.db
      .prepare(
        "INSERT INTO tools (id, user_id, name, description, prompt, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'building', ?)"
      )
      .run(rec.id, this.userId, rec.name, rec.description, rec.prompt, rec.kind, rec.createdAt);
    this.logActivity("builder-agent", "tool.building", `Building tool "${rec.name}"`);
    return rec;
  }

  renameTool(id: string, name: string, description: string, kind: ToolKind): ToolRecord | undefined {
    this.db
      .prepare("UPDATE tools SET name = ?, description = ?, kind = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(name, description, kind, new Date().toISOString(), id, this.userId);
    return this.getTool(id);
  }

  setToolStatus(id: string, status: ToolStatus, error?: string | null): ToolRecord | undefined {
    this.db
      .prepare("UPDATE tools SET status = ?, error = ? WHERE id = ? AND user_id = ?")
      .run(status, error ?? null, id, this.userId);
    const tool = this.getTool(id);
    if (tool && status === "ready") {
      this.logActivity("builder-agent", "tool.ready", `Built tool "${tool.name}"`);
    } else if (tool && status === "failed") {
      this.logActivity("builder-agent", "tool.failed", `Could not build "${tool.name}": ${error ?? "unknown error"}`);
    }
    return tool;
  }

  /** Mark an improve as in flight (the tool keeps working meanwhile). */
  beginToolRevision(id: string): ToolRecord | undefined {
    this.db
      .prepare("UPDATE tools SET revision_state = 'revising' WHERE id = ? AND user_id = ?")
      .run(id, this.userId);
    const tool = this.getTool(id);
    if (tool) this.logActivity("builder-agent", "tool.revising", `Improving tool "${tool.name}"`);
    return tool;
  }

  /** Finish an improve — success bumps the revision count and clears the flag;
   *  failure records the reason (shown as a warning; the tool still works). */
  finishToolRevision(
    id: string,
    outcome: { ok: true } | { ok: false; error: string }
  ): ToolRecord | undefined {
    if (outcome.ok) {
      this.db
        .prepare(
          "UPDATE tools SET revision_state = NULL, revision_count = revision_count + 1, updated_at = ? WHERE id = ? AND user_id = ?"
        )
        .run(new Date().toISOString(), id, this.userId);
      const tool = this.getTool(id);
      if (tool) this.logActivity("builder-agent", "tool.revised", `Improved tool "${tool.name}"`);
      return tool;
    }
    this.db
      .prepare("UPDATE tools SET revision_state = ? WHERE id = ? AND user_id = ?")
      .run(outcome.error.slice(0, 300), id, this.userId);
    const tool = this.getTool(id);
    if (tool) this.logActivity("builder-agent", "tool.revise_failed", `Could not improve "${tool.name}": ${outcome.error}`);
    return tool;
  }

  /** Clear a stale/failed revision_state (e.g. before a retry, or on revert). */
  clearToolRevisionState(id: string): void {
    this.db
      .prepare("UPDATE tools SET revision_state = NULL WHERE id = ? AND user_id = ?")
      .run(id, this.userId);
  }

  getTool(id: string): ToolRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tools WHERE id = ? AND user_id = ?").get(id, this.userId) as any;
    return row ? rowToTool_(row) : undefined;
  }

  listTools(): ToolRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tools WHERE user_id = ? ORDER BY created_at DESC")
      .all(this.userId) as any[];
    return rows.map(rowToTool_);
  }

  deleteTool(id: string): ToolRecord | undefined {
    const tool = this.getTool(id);
    if (!tool) return undefined;
    this.db.prepare("DELETE FROM tools WHERE id = ? AND user_id = ?").run(id, this.userId);
    this.logActivity("user", "tool.deleted", `Deleted tool "${tool.name}"`);
    return tool;
  }

  failStaleBuildingTools(): number {
    const info = this.db
      .prepare(
        "UPDATE tools SET status = 'failed', error = 'The build was interrupted — try again.' WHERE status = 'building' AND user_id = ?"
      )
      .run(this.userId);
    return Number(info.changes ?? 0);
  }

  // ---- AI-generated artifacts (render_artifact) ----

  createArtifact(input: {
    title: string;
    html: string;
    source?: string | null;
    sourceId?: string | null;
  }): ArtifactRecord {
    const rec: ArtifactRecord = {
      id: shortId(),
      title: input.title,
      html: input.html,
      source: input.source ?? null,
      sourceId: input.sourceId ?? null,
      revision: 0,
      canRevert: false,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO artifacts (id, user_id, title, html, source, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(rec.id, this.userId, rec.title, rec.html, rec.source, rec.sourceId, rec.createdAt);
    this.logActivity("artifact-agent", "artifact.created", `Generated an artifact: "${rec.title}"`);
    return rec;
  }

  listArtifacts(): ArtifactRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE user_id = ? ORDER BY created_at DESC")
      .all(this.userId) as any[];
    return rows.map(rowToArtifact_);
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ? AND user_id = ?").get(id, this.userId) as any;
    return row ? rowToArtifact_(row) : undefined;
  }

  renameArtifact(id: string, title: string): ArtifactRecord | undefined {
    const t = title.trim().slice(0, 120);
    if (!t) return this.getArtifact(id);
    this.db
      .prepare("UPDATE artifacts SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(t, new Date().toISOString(), id, this.userId);
    const a = this.getArtifact(id);
    if (a) this.logActivity("user", "artifact.renamed", `Renamed an artifact to "${a.title}"`);
    return a;
  }

  deleteArtifact(id: string): ArtifactRecord | undefined {
    const a = this.getArtifact(id);
    if (!a) return undefined;
    this.db.prepare("DELETE FROM artifacts WHERE id = ? AND user_id = ?").run(id, this.userId);
    this.db.prepare("DELETE FROM artifact_comments WHERE artifact_id = ?").run(id);
    this.logActivity("user", "artifact.deleted", `Deleted artifact "${a.title}"`);
    return a;
  }

  /** Replace an artifact's body, keeping the current one for a one-step revert. */
  updateArtifactHtml(id: string, html: string): ArtifactRecord | undefined {
    const cur = this.getArtifact(id);
    if (!cur) return undefined;
    this.db
      .prepare(
        "UPDATE artifacts SET prev_html = html, html = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ?"
      )
      .run(html, new Date().toISOString(), id, this.userId);
    return this.getArtifact(id);
  }

  /** Swap back to the version before the last edit (one level). */
  revertArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ? AND user_id = ?").get(id, this.userId) as any;
    if (!row || !row.prev_html) return this.getArtifact(id);
    this.db
      .prepare(
        "UPDATE artifacts SET html = prev_html, prev_html = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND user_id = ?"
      )
      .run(new Date().toISOString(), id, this.userId);
    const a = this.getArtifact(id);
    if (a) this.logActivity("user", "artifact.reverted", `Reverted artifact "${a.title}"`);
    return a;
  }

  // ---- artifact comments ----
  // Scoped through the owning artifact: every method checks the artifact
  // belongs to this user before touching its comments.

  private ownsArtifact_(artifactId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM artifacts WHERE id = ? AND user_id = ?")
      .get(artifactId, this.userId);
  }

  addArtifactComment(input: {
    artifactId: string;
    body: string;
    quote?: string | null;
    prefix?: string | null;
    suffix?: string | null;
  }): ArtifactCommentRecord | undefined {
    if (!this.ownsArtifact_(input.artifactId)) return undefined;
    const rec: ArtifactCommentRecord = {
      id: shortId(),
      artifactId: input.artifactId,
      userId: this.userId,
      body: input.body.trim().slice(0, 2000),
      quote: input.quote?.slice(0, 1000) ?? null,
      prefix: input.prefix?.slice(0, 80) ?? null,
      suffix: input.suffix?.slice(0, 80) ?? null,
      status: "open",
      resolution: null,
      resolvedBy: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.db
      .prepare(
        "INSERT INTO artifact_comments (id, artifact_id, user_id, body, quote, prefix, suffix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(rec.id, rec.artifactId, rec.userId, rec.body, rec.quote, rec.prefix, rec.suffix, rec.createdAt);
    return rec;
  }

  listArtifactComments(artifactId: string): ArtifactCommentRecord[] {
    if (!this.ownsArtifact_(artifactId)) return [];
    return (
      this.db
        .prepare("SELECT * FROM artifact_comments WHERE artifact_id = ? ORDER BY created_at ASC")
        .all(artifactId) as any[]
    ).map(rowToArtifactComment_);
  }

  getArtifactComment(artifactId: string, id: string): ArtifactCommentRecord | undefined {
    if (!this.ownsArtifact_(artifactId)) return undefined;
    const row = this.db
      .prepare("SELECT * FROM artifact_comments WHERE id = ? AND artifact_id = ?")
      .get(id, artifactId) as any;
    return row ? rowToArtifactComment_(row) : undefined;
  }

  updateArtifactComment(artifactId: string, id: string, body: string): ArtifactCommentRecord | undefined {
    if (!this.ownsArtifact_(artifactId)) return undefined;
    this.db
      .prepare("UPDATE artifact_comments SET body = ? WHERE id = ? AND artifact_id = ?")
      .run(body.trim().slice(0, 2000), id, artifactId);
    return this.getArtifactComment(artifactId, id);
  }

  deleteArtifactComment(artifactId: string, id: string): boolean {
    if (!this.ownsArtifact_(artifactId)) return false;
    const info = this.db
      .prepare("DELETE FROM artifact_comments WHERE id = ? AND artifact_id = ?")
      .run(id, artifactId);
    return Number(info.changes ?? 0) > 0;
  }

  resolveArtifactComment(
    artifactId: string,
    id: string,
    outcome: { resolution: string; resolvedBy: "agent" | "user" }
  ): ArtifactCommentRecord | undefined {
    if (!this.ownsArtifact_(artifactId)) return undefined;
    this.db
      .prepare(
        "UPDATE artifact_comments SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND artifact_id = ?"
      )
      .run(outcome.resolution.slice(0, 2000), outcome.resolvedBy, new Date().toISOString(), id, artifactId);
    return this.getArtifactComment(artifactId, id);
  }

  reopenArtifactComment(artifactId: string, id: string): ArtifactCommentRecord | undefined {
    if (!this.ownsArtifact_(artifactId)) return undefined;
    this.db
      .prepare(
        "UPDATE artifact_comments SET status = 'open', resolution = NULL, resolved_by = NULL, resolved_at = NULL WHERE id = ? AND artifact_id = ?"
      )
      .run(id, artifactId);
    return this.getArtifactComment(artifactId, id);
  }

  openArtifactCommentCount(artifactId: string): number {
    return Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM artifact_comments WHERE artifact_id = ? AND status = 'open'")
          .get(artifactId) as any
      ).n
    );
  }

  // ---- sticky notes ----
  // The "private" board is scoped like everything else (WHERE user_id = ?); the
  // "shared" board is the family board — any member reads and edits it, and the
  // `user_id` column just records who authored each note.

  listStickyNotes(scope: NoteScope): StickyNoteRecord[] {
    // Ascending by updated_at: on a corkboard the render order *is* the
    // stacking order, so the note you most recently touched (moved or edited)
    // paints last — on top — which is the physical behaviour.
    const rows = (
      scope === "private"
        ? this.db
            .prepare(
              "SELECT * FROM sticky_notes WHERE scope = 'private' AND user_id = ? ORDER BY updated_at ASC"
            )
            .all(this.userId)
        : this.db
            .prepare("SELECT * FROM sticky_notes WHERE scope = 'shared' ORDER BY updated_at ASC")
            .all()
    ) as any[];
    return rows.map(rowToStickyNote);
  }

  getStickyNote(id: string): StickyNoteRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sticky_notes WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    const note = rowToStickyNote(row);
    // A private note is only visible to its owner; a shared note to anyone.
    if (note.scope === "private" && note.userId !== this.userId) return undefined;
    return note;
  }

  createStickyNote(input: {
    scope: NoteScope;
    text: string;
    color?: string;
    x?: number;
    y?: number;
  }): StickyNoteRecord {
    const now = new Date().toISOString();
    // No position given (a fresh "+ Add" note, or a note the agent pinned) —
    // scatter it near the top-left so it's on-screen at any board width, but
    // not exactly on top of the last one.
    const scatter = (span: number) => Math.round(16 + Math.random() * span);
    const rec: StickyNoteRecord = {
      id: shortId(),
      scope: input.scope,
      userId: this.userId,
      text: input.text,
      color: input.color?.trim() || "butter",
      x: input.x ?? scatter(460),
      y: input.y ?? scatter(320),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO sticky_notes (id, scope, user_id, text, color, pos_x, pos_y, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(rec.id, rec.scope, rec.userId, rec.text, rec.color, rec.x, rec.y, rec.createdAt, rec.updatedAt);
    this.logActivity(
      "user",
      "note.created",
      rec.text.trim()
        ? `Added a ${rec.scope} sticky note: "${rec.text.slice(0, 80)}"`
        : `Added a blank ${rec.scope} sticky note`
    );
    return rec;
  }

  updateStickyNote(
    id: string,
    patch: { text?: string; color?: string; x?: number; y?: number }
  ): StickyNoteRecord | undefined {
    const note = this.getStickyNote(id);
    if (!note) return undefined;
    // Shared notes: any member can edit. Private notes: getStickyNote already
    // guaranteed ownership.
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (patch.text !== undefined) {
      sets.push("text = ?");
      values.push(patch.text);
    }
    if (patch.color !== undefined) {
      sets.push("color = ?");
      values.push(patch.color.trim() || "butter");
    }
    if (patch.x !== undefined) {
      sets.push("pos_x = ?");
      values.push(patch.x);
    }
    if (patch.y !== undefined) {
      sets.push("pos_y = ?");
      values.push(patch.y);
    }
    if (sets.length === 0) return note;
    const now = new Date().toISOString();
    sets.push("updated_at = ?");
    values.push(now);
    this.db.prepare(`UPDATE sticky_notes SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    // A drag (position only) isn't worth an activity-log line — it'd flood it.
    if (patch.text !== undefined || patch.color !== undefined) {
      this.logActivity("user", "note.updated", `Edited a ${note.scope} sticky note`);
    }
    return this.getStickyNote(id);
  }

  deleteStickyNote(id: string): StickyNoteRecord | undefined {
    const note = this.getStickyNote(id);
    if (!note) return undefined;
    this.db.prepare("DELETE FROM sticky_notes WHERE id = ?").run(id);
    this.logActivity("user", "note.deleted", `Removed a ${note.scope} sticky note`);
    return note;
  }

  // ---- password vault entries ----
  // Metadata columns (title/username/url) are plaintext so the list works
  // locked; `secret` is opaque bytes to the store — the caller (VaultService)
  // holds the key and does the crypto. "private" scope is `AND user_id = ?`;
  // "shared" is the family vault, readable/editable by any member (author
  // tracked in user_id), mirroring the sticky-note board.

  listVaultEntries(): VaultEntryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, scope, folder, title, username, url, has_totp, created_at, updated_at
         FROM vault_entries
         WHERE scope = 'shared' OR (scope = 'private' AND user_id = ?)
         ORDER BY LOWER(COALESCE(folder, '')), LOWER(title)`
      )
      .all(this.userId) as any[];
    return rows.map(rowToVaultEntry);
  }

  private vaultEntryRow(id: string): any | undefined {
    const r = this.db.prepare("SELECT * FROM vault_entries WHERE id = ?").get(id) as any;
    if (!r) return undefined;
    if (r.scope === "private" && r.user_id !== this.userId) return undefined;
    return r;
  }

  getVaultEntryMeta(id: string): VaultEntryRecord | undefined {
    const r = this.vaultEntryRow(id);
    return r ? rowToVaultEntry(r) : undefined;
  }

  /** The opaque secret blob for an entry the caller may see, or undefined. */
  getVaultSecretBlob(id: string): { meta: VaultEntryRecord; blob: Buffer } | undefined {
    const r = this.vaultEntryRow(id);
    if (!r) return undefined;
    return { meta: rowToVaultEntry(r), blob: toBuf(r.secret) };
  }

  countVaultEntries(): number {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM vault_entries WHERE scope = 'shared' OR (scope = 'private' AND user_id = ?)"
          )
          .get(this.userId) as any
      ).n
    );
  }

  createVaultEntry(input: {
    scope: VaultScope;
    folder?: string | null;
    title: string;
    username?: string | null;
    url?: string | null;
    hasTotp: boolean;
    secret: Buffer;
  }): VaultEntryRecord {
    const now = new Date().toISOString();
    const rec: VaultEntryRecord = {
      id: shortId(),
      userId: this.userId,
      scope: input.scope,
      folder: input.folder?.trim() || null,
      title: input.title.trim(),
      username: input.username?.trim() || null,
      url: input.url?.trim() || null,
      hasTotp: input.hasTotp,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO vault_entries
          (id, user_id, scope, folder, title, username, url, has_totp, secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rec.id,
        rec.userId,
        rec.scope,
        rec.folder,
        rec.title,
        rec.username,
        rec.url,
        rec.hasTotp ? 1 : 0,
        input.secret,
        rec.createdAt,
        rec.updatedAt
      );
    this.logActivity("user", "vault.entry.created", `Added ${rec.scope} vault entry "${rec.title}"`);
    this.logVaultAccess("user", "create", { id: rec.id, title: rec.title });
    return rec;
  }

  updateVaultEntry(
    id: string,
    patch: {
      folder?: string | null;
      title?: string;
      username?: string | null;
      url?: string | null;
      scope?: VaultScope;
      hasTotp?: boolean;
      secret?: Buffer;
    }
  ): VaultEntryRecord | undefined {
    const r = this.vaultEntryRow(id);
    if (!r) return undefined;
    const sets: string[] = [];
    const values: (string | number | Buffer | null)[] = [];
    const put = (col: string, v: string | number | Buffer | null) => {
      sets.push(`${col} = ?`);
      values.push(v);
    };
    if (patch.folder !== undefined) put("folder", patch.folder?.trim() || null);
    if (patch.title !== undefined) put("title", patch.title.trim());
    if (patch.username !== undefined) put("username", patch.username?.trim() || null);
    if (patch.url !== undefined) put("url", patch.url?.trim() || null);
    if (patch.scope !== undefined) put("scope", patch.scope);
    if (patch.hasTotp !== undefined) put("has_totp", patch.hasTotp ? 1 : 0);
    if (patch.secret !== undefined) put("secret", patch.secret);
    if (sets.length === 0) return rowToVaultEntry(r);
    put("updated_at", new Date().toISOString());
    this.db.prepare(`UPDATE vault_entries SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    const updated = this.getVaultEntryMeta(id)!;
    this.logActivity("user", "vault.entry.updated", `Edited vault entry "${updated.title}"`);
    this.logVaultAccess("user", "update", { id, title: updated.title });
    return updated;
  }

  deleteVaultEntry(id: string): VaultEntryRecord | undefined {
    const r = this.vaultEntryRow(id);
    if (!r) return undefined;
    const meta = rowToVaultEntry(r);
    this.db.prepare("DELETE FROM vault_entries WHERE id = ?").run(id);
    this.logActivity("user", "vault.entry.deleted", `Removed vault entry "${meta.title}"`);
    this.logVaultAccess("user", "delete", { id, title: meta.title });
    return meta;
  }

  logVaultAccess(
    actor: string,
    action: string,
    entry: { id: string | null; title: string }
  ): void {
    this.db
      .prepare(
        "INSERT INTO vault_access_log (id, user_id, entry_id, entry_title, actor, action, at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), this.userId, entry.id, entry.title, actor, action, new Date().toISOString());
  }

  listVaultAccessLog(limit = 100): VaultAccessLogRecord[] {
    return (
      this.db
        .prepare(
          "SELECT id, entry_id, entry_title, actor, action, at FROM vault_access_log WHERE user_id = ? ORDER BY at DESC LIMIT ?"
        )
        .all(this.userId, Math.min(Math.max(limit, 1), 500)) as any[]
    ).map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      entryTitle: r.entry_title,
      actor: r.actor,
      action: r.action,
      at: r.at,
    }));
  }

  // ---- chat sessions (private assistant chat history) ----
  createChatSession(firstMessageForTitle: string): ChatSessionRecord {
    const now = new Date().toISOString();
    const rec: ChatSessionRecord = {
      id: shortId(),
      userId: this.userId,
      title: titleFromMessage(firstMessageForTitle),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare("INSERT INTO chat_sessions (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(rec.id, rec.userId, rec.title, rec.createdAt, rec.updatedAt);
    return rec;
  }

  listChatSessions(): ChatSessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
                (SELECT body FROM chat_messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count
         FROM chat_sessions s WHERE s.user_id = ? ORDER BY s.updated_at DESC`
      )
      .all(this.userId) as any[];
    return rows.map(rowToChatSessionSummary);
  }

  getChatSession(id: string): ChatSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?").get(id, this.userId) as
      | any
      | undefined;
    return row ? rowToChatSession(row) : undefined;
  }

  renameChatSession(id: string, title: string): ChatSessionRecord | undefined {
    if (!this.getChatSession(id)) return undefined;
    const trimmed = title.trim().slice(0, 120) || "Untitled chat";
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(trimmed, now, id, this.userId);
    return this.getChatSession(id);
  }

  deleteChatSession(id: string): boolean {
    if (!this.getChatSession(id)) return false;
    this.db.prepare("DELETE FROM chat_messages WHERE session_id = ? AND user_id = ?").run(id, this.userId);
    this.db.prepare("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?").run(id, this.userId);
    return true;
  }

  /** [] for a session that doesn't exist or isn't this user's — same "missed
   *  check surfaces as empty" shape as the channel methods use for membership. */
  listChatMessages(sessionId: string): ChatSessionMessageRecord[] {
    if (!this.getChatSession(sessionId)) return [];
    const rows = this.db
      .prepare("SELECT * FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC")
      .all(sessionId, this.userId) as any[];
    return rows.map(rowToChatSessionMessage);
  }

  addChatMessage(
    sessionId: string,
    role: "user" | "assistant",
    body: string,
    images: string[] = [],
    refs: ChatReference[] = [],
    steps: AgentStep[] = [],
    cards: CardRecord[] = []
  ): ChatSessionMessageRecord {
    const now = new Date().toISOString();
    const rec: ChatSessionMessageRecord = { id: shortId(), sessionId, role, body, images, refs, steps, cards, createdAt: now };
    this.db
      .prepare(
        "INSERT INTO chat_messages (id, session_id, user_id, role, body, images, refs, steps, cards, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        rec.id,
        rec.sessionId,
        this.userId,
        rec.role,
        rec.body,
        images.length ? JSON.stringify(images) : null,
        refs.length ? JSON.stringify(refs) : null,
        steps.length ? JSON.stringify(steps) : null,
        cards.length ? JSON.stringify(cards) : null,
        rec.createdAt
      );
    this.db
      .prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND user_id = ?")
      .run(now, sessionId, this.userId);
    return rec;
  }

  // ---- scheduled routines ----
  // next_run_at is left null on create; the RoutineScheduler computes it on its
  // next reconcile/tick (or the server computes it inline right after create so
  // a "run tomorrow at 9" routine has a visible next time immediately).

  createRoutine(input: {
    name: string;
    trigger: RoutineTrigger;
    action: RoutineAction;
    deliverChannelId?: string | null;
    catchUp?: CatchUpPolicy;
    enabled?: boolean;
  }): RoutineRecord {
    const now = new Date().toISOString();
    const rec: RoutineRecord = {
      id: shortId(),
      userId: this.userId,
      name: input.name.trim() || "Untitled routine",
      enabled: input.enabled ?? true,
      trigger: input.trigger,
      action: input.action,
      deliverChannelId: input.deliverChannelId ?? null,
      catchUp: input.catchUp ?? "skip",
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO routines (id, user_id, name, enabled, trigger, action, deliver_channel_id, catch_up, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        rec.id,
        this.userId,
        rec.name,
        rec.enabled ? 1 : 0,
        JSON.stringify(rec.trigger),
        JSON.stringify(rec.action),
        rec.deliverChannelId,
        rec.catchUp,
        rec.createdAt,
        rec.updatedAt
      );
    this.logActivity("routine", "routine.created", `Created routine "${rec.name}"`);
    return rec;
  }

  listRoutines(): RoutineRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM routines WHERE user_id = ? ORDER BY created_at DESC")
      .all(this.userId) as any[];
    return rows.map(rowToRoutine);
  }

  getRoutine(id: string): RoutineRecord | undefined {
    const row = this.db.prepare("SELECT * FROM routines WHERE id = ? AND user_id = ?").get(id, this.userId) as any;
    return row ? rowToRoutine(row) : undefined;
  }

  updateRoutine(
    id: string,
    patch: {
      name?: string;
      enabled?: boolean;
      trigger?: RoutineTrigger;
      action?: RoutineAction;
      deliverChannelId?: string | null;
      catchUp?: CatchUpPolicy;
    }
  ): RoutineRecord | undefined {
    const existing = this.getRoutine(id);
    if (!existing) return undefined;
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      values.push(patch.name.trim() || "Untitled routine");
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(patch.enabled ? 1 : 0);
    }
    if (patch.trigger !== undefined) {
      sets.push("trigger = ?");
      values.push(JSON.stringify(patch.trigger));
    }
    if (patch.action !== undefined) {
      sets.push("action = ?");
      values.push(JSON.stringify(patch.action));
    }
    if (patch.deliverChannelId !== undefined) {
      sets.push("deliver_channel_id = ?");
      values.push(patch.deliverChannelId);
    }
    if (patch.catchUp !== undefined) {
      sets.push("catch_up = ?");
      values.push(patch.catchUp);
    }
    // Any change to the trigger, or re-enabling, invalidates the stored next
    // time — clear it so the scheduler recomputes on its next pass.
    if (patch.trigger !== undefined || patch.enabled === true) {
      sets.push("next_run_at = NULL");
    }
    if (sets.length === 0) return existing;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    this.db
      .prepare(`UPDATE routines SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
      .run(...values, id, this.userId);
    return this.getRoutine(id);
  }

  /** Scheduler-only: persist a recomputed schedule / last-run outcome. */
  setRoutineSchedule(
    id: string,
    patch: {
      nextRunAt?: string | null;
      lastRunAt?: string;
      lastStatus?: RoutineRunStatus;
      enabled?: boolean;
    }
  ): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if ("nextRunAt" in patch) {
      sets.push("next_run_at = ?");
      values.push(patch.nextRunAt ?? null);
    }
    if (patch.lastRunAt !== undefined) {
      sets.push("last_run_at = ?");
      values.push(patch.lastRunAt);
    }
    if (patch.lastStatus !== undefined) {
      sets.push("last_status = ?");
      values.push(patch.lastStatus);
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(patch.enabled ? 1 : 0);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE routines SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`).run(...values, id, this.userId);
  }

  deleteRoutine(id: string): RoutineRecord | undefined {
    const routine = this.getRoutine(id);
    if (!routine) return undefined;
    this.db.prepare("DELETE FROM routine_runs WHERE routine_id = ? AND user_id = ?").run(id, this.userId);
    this.db.prepare("DELETE FROM routines WHERE id = ? AND user_id = ?").run(id, this.userId);
    this.logActivity("routine", "routine.deleted", `Deleted routine "${routine.name}"`);
    return routine;
  }

  startRoutineRun(routineId: string, trigger: RoutineRunTrigger): string {
    const id = shortId();
    this.db
      .prepare(
        "INSERT INTO routine_runs (id, routine_id, user_id, started_at, status, trigger_kind) VALUES (?, ?, ?, ?, 'running', ?)"
      )
      .run(id, routineId, this.userId, new Date().toISOString(), trigger);
    return id;
  }

  finishRoutineRun(
    runId: string,
    outcome: { status: RoutineRunStatus; output?: string; error?: string }
  ): void {
    this.db
      .prepare(
        "UPDATE routine_runs SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ? AND user_id = ?"
      )
      .run(
        outcome.status,
        outcome.output ?? null,
        outcome.error ?? null,
        new Date().toISOString(),
        runId,
        this.userId
      );
  }

  listRoutineRuns(routineId: string, limit = 20): RoutineRunRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM routine_runs WHERE routine_id = ? AND user_id = ? ORDER BY started_at DESC LIMIT ?"
      )
      .all(routineId, this.userId, Math.min(Math.max(limit, 1), 100)) as any[];
    return rows.map(rowToRoutineRun);
  }
}

/** First ~60 chars of a message, single line, trimmed — the session's default
 *  title until the user renames it. No model call: instant, and this app's
 *  local model is already slow enough (see docs/DECISIONS.md) to not spend a
 *  turn on cosmetics. */
function titleFromMessage(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  return flat.length > 60 ? `${flat.slice(0, 60).trimEnd()}…` : flat;
}

/** node:sqlite hands a BLOB back as a Uint8Array whose buffer may be pooled;
 *  copy into a standalone Buffer before anything holds onto it. */
function toBuf(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (v == null) return Buffer.alloc(0);
  throw new Error("expected a BLOB");
}

function rowToVaultKeys(r: any): VaultKeysRow {
  return {
    userId: r.user_id,
    kdfParams: r.kdf_params,
    kdfSalt: toBuf(r.kdf_salt),
    dekWrappedLogin: toBuf(r.dek_wrapped_login),
    recoverySalt: r.recovery_salt != null ? toBuf(r.recovery_salt) : null,
    dekWrappedRecovery: r.dek_wrapped_recovery != null ? toBuf(r.dek_wrapped_recovery) : null,
    publicKey: toBuf(r.public_key),
    privateKeyWrapped: toBuf(r.private_key_wrapped),
    familyKeySealed: r.family_key_sealed != null ? toBuf(r.family_key_sealed) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToVaultEntry(r: any): VaultEntryRecord {
  return {
    id: r.id,
    userId: r.user_id,
    scope: r.scope === "shared" ? "shared" : "private",
    folder: r.folder ?? null,
    title: r.title,
    username: r.username ?? null,
    url: r.url ?? null,
    hasTotp: !!r.has_totp,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToUser(r: any): UserRecord {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: (r.role as UserRole) ?? "member",
    inboxDir: r.inbox_dir ?? null,
    createdAt: r.created_at,
  };
}

function rowToTask(r: any): TaskRecord {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    dueDate: r.due_date,
    dueTime: r.due_time ?? null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToDocument(r: any): DocumentRecord {
  return {
    id: r.id,
    filename: r.filename,
    rawText: r.raw_text,
    extracted: r.extracted ? JSON.parse(r.extracted) : null,
    createdAt: r.created_at,
    sourcePath: r.source_path ?? null,
    originalMime: r.original_mime ?? null,
    originalDiskName: r.original_disk_name ?? null,
    extractionStatus: (r.extraction_status as ExtractionStatus) ?? "pending",
  };
}

/** A documents row (joined with a `snippet` column) → a DocumentSearchHit. */
function rowToDocumentHit(r: any): DocumentSearchHit {
  const extracted = r.extracted ? JSON.parse(r.extracted) : null;
  return {
    id: r.id,
    filename: r.filename,
    category: (extracted?.category as string) ?? null,
    summary: (extracted?.summary as string) ?? null,
    snippet: String(r.snippet ?? "").trim(),
    createdAt: r.created_at,
    extractionStatus: (r.extraction_status as ExtractionStatus) ?? "pending",
  };
}

function rowToChannel(r: any): ChannelRecord {
  return {
    id: r.id,
    kind: (r.kind as ChannelKind) ?? "dm",
    name: r.name ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function rowToMessage(r: any): MessageRecord {
  return {
    id: r.id,
    channelId: r.channel_id,
    senderId: r.sender_id,
    body: r.body,
    images: parseImages(r.images),
    steps: parseSteps(r.steps),
    cards: parseCards(r.cards),
    pending: !!r.pending,
    createdAt: r.created_at,
  };
}

function parseCards(raw: unknown): CardRecord[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as CardRecord[]) : [];
  } catch {
    return [];
  }
}

function parseImages(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseSteps(raw: unknown): AgentStep[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as AgentStep[]) : [];
  } catch {
    return [];
  }
}

function rowToStickyNote(r: any): StickyNoteRecord {
  return {
    id: r.id,
    scope: (r.scope as NoteScope) ?? "shared",
    userId: r.user_id,
    text: r.text,
    color: r.color ?? "butter",
    x: typeof r.pos_x === "number" ? r.pos_x : 0,
    y: typeof r.pos_y === "number" ? r.pos_y : 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToChatSession(r: any): ChatSessionRecord {
  return { id: r.id, userId: r.user_id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at };
}

function rowToChatSessionSummary(r: any): ChatSessionSummary {
  return { ...rowToChatSession(r), lastMessage: r.last_message ?? null, messageCount: r.message_count ?? 0 };
}

function rowToChatSessionMessage(r: any): ChatSessionMessageRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: (r.role as "user" | "assistant") ?? "user",
    body: r.body,
    images: parseImages(r.images),
    refs: parseRefs(r.refs),
    steps: parseSteps(r.steps),
    cards: parseCards(r.cards),
    createdAt: r.created_at,
  };
}

function parseRefs(raw: unknown): ChatReference[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is ChatReference => x && typeof x === "object" && typeof x.id === "string")
      : [];
  } catch {
    return [];
  }
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRoutine(r: any): RoutineRecord {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    enabled: !!r.enabled,
    trigger: safeJson<RoutineTrigger>(r.trigger, { kind: "every", minutes: 1440 }),
    action: safeJson<RoutineAction>(r.action, { agent: "planner", instruction: "" }),
    deliverChannelId: r.deliver_channel_id ?? null,
    catchUp: (r.catch_up as CatchUpPolicy) ?? "skip",
    nextRunAt: r.next_run_at ?? null,
    lastRunAt: r.last_run_at ?? null,
    lastStatus: (r.last_status as RoutineRunStatus) ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRoutineRun(r: any): RoutineRunRecord {
  return {
    id: r.id,
    routineId: r.routine_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    status: (r.status as RoutineRunStatus) ?? "error",
    trigger: (r.trigger_kind as RoutineRunTrigger) ?? "schedule",
    output: r.output ?? null,
    error: r.error ?? null,
  };
}

function rowToTool_(r: any): ToolRecord {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    prompt: r.prompt,
    kind: (r.kind as ToolKind) ?? "static",
    status: (r.status as ToolStatus) ?? "failed",
    error: r.error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? null,
    revisionCount: Number(r.revision_count ?? 0),
    revisionState: r.revision_state ?? null,
  };
}
