import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { hashPassword, newSessionToken, sha256Hex } from "./auth.js";

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
  /** True while the agent's reply is still being generated (body is ""). */
  pending: boolean;
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
  original_mime TEXT
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
  created_at TEXT NOT NULL
);

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
  // Multimodal family chat: a message can carry image attachments (JSON array
  // of data URIs), the same way the 1:1 chat composer does.
  { table: "messages", column: "images", ddl: "ALTER TABLE messages ADD COLUMN images TEXT" },
  // Original-file preview: uploads keep their bytes on disk; this records the
  // MIME so the preview route can serve the right Content-Type.
  { table: "documents", column: "original_mime", ddl: "ALTER TABLE documents ADD COLUMN original_mime TEXT" },
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

      DROP TRIGGER IF EXISTS documents_fts_ai;
      DROP TRIGGER IF EXISTS documents_fts_ad;
      DROP TRIGGER IF EXISTS documents_fts_au;
      DROP TRIGGER IF EXISTS tasks_fts_ai;
      DROP TRIGGER IF EXISTS tasks_fts_ad;
      DROP TRIGGER IF EXISTS tasks_fts_au;

      CREATE TRIGGER documents_fts_ai AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(doc_id, user_id, filename, body, summary, category)
        VALUES (new.id, new.user_id, new.filename, new.raw_text,
                COALESCE(json_extract(new.extracted, '$.summary'), ''),
                COALESCE(json_extract(new.extracted, '$.category'), ''));
      END;
      CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
      END;
      CREATE TRIGGER documents_fts_au AFTER UPDATE ON documents BEGIN
        DELETE FROM documents_fts WHERE doc_id = old.id;
        INSERT INTO documents_fts(doc_id, user_id, filename, body, summary, category)
        VALUES (new.id, new.user_id, new.filename, new.raw_text,
                COALESCE(json_extract(new.extracted, '$.summary'), ''),
                COALESCE(json_extract(new.extracted, '$.category'), ''));
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

  /** Drop and rebuild both search mirrors from the base tables. For ops/tests. */
  rebuildSearchIndex() {
    this.db.exec("DELETE FROM documents_fts");
    this.db.exec("DELETE FROM tasks_fts");
    this.db.exec(
      "INSERT INTO documents_fts(doc_id, user_id, filename, body, summary, category) " +
        "SELECT id, user_id, filename, raw_text, COALESCE(json_extract(extracted, '$.summary'), ''), " +
        "COALESCE(json_extract(extracted, '$.category'), '') FROM documents"
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
      "documents",
      "activity",
      "tools",
      "sessions",
      "channel_members",
      "sticky_notes",
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

  resolvePendingAgentMessage(messageId: string, body: string): void {
    this.db
      .prepare("UPDATE messages SET body = ?, pending = 0 WHERE id = ?")
      .run(body, messageId);
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
      .prepare("UPDATE tools SET status = 'failed', error = 'interrupted' WHERE status = 'building'")
      .run();
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
      rec.sourcePath ? `Ingested "${rec.filename}" from watched folder` : `Ingested "${rec.filename}"`
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
   * Keyword search over this user's documents (filename + full text +
   * extracted summary), best match first, with optional structured filters
   * on the extracted `category` and `importantDates`. An empty / unparseable
   * query falls back to a recency listing, so `searchDocuments("", { category:
   * "bill" })` is "my bills". See `toFtsMatchQuery`.
   */
  searchDocuments(
    query: string,
    opts: { category?: string; dueAfter?: string; dueBefore?: string; limit?: number } = {}
  ): DocumentSearchHit[] {
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
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

    return rows.map((r) => {
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
    });
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
      .prepare("UPDATE tools SET name = ?, description = ?, kind = ? WHERE id = ? AND user_id = ?")
      .run(name, description, kind, id, this.userId);
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
        "UPDATE tools SET status = 'failed', error = 'interrupted' WHERE status = 'building' AND user_id = ?"
      )
      .run(this.userId);
    return Number(info.changes ?? 0);
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
    pending: !!r.pending,
    createdAt: r.created_at,
  };
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
  };
}
