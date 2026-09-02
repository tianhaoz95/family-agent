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

// The owner assigned to any pre-existing row when a single-user database is
// upgraded to the multi-user schema. `reassignLegacyData()` moves these to
// the first real admin the moment one is created during setup.
export const LEGACY_USER_ID = "_legacy_";

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
  extraction_status TEXT NOT NULL DEFAULT 'pending'
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
  { table: "documents", column: "user_id", ddl: `ALTER TABLE documents ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}'` },
  { table: "activity", column: "user_id", ddl: `ALTER TABLE activity ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}'` },
  { table: "tools", column: "user_id", ddl: `ALTER TABLE tools ADD COLUMN user_id TEXT NOT NULL DEFAULT '${LEGACY_USER_ID}'` },
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
    for (const table of ["tasks", "documents", "activity", "tools", "sessions"] as const) {
      this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id);
    }
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return user;
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
  createTask(input: { title: string; notes?: string | null; dueDate?: string | null }): TaskRecord {
    const now = new Date().toISOString();
    const rec: TaskRecord = {
      id: shortId(),
      title: input.title,
      notes: input.notes ?? null,
      dueDate: input.dueDate ?? null,
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO tasks (id, user_id, title, notes, due_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(rec.id, this.userId, rec.title, rec.notes, rec.dueDate, rec.status, rec.createdAt, rec.updatedAt);
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

  updateTaskStatus(id: string, status: "open" | "done"): TaskRecord | undefined {
    if (!this.getTask(id)) return undefined;
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(status, now, id, this.userId);
    const updated = this.getTask(id);
    if (updated) {
      this.logActivity("task-agent", "task.updated", `Marked task "${updated.title}" as ${status}`);
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
    extractionStatus: (r.extraction_status as ExtractionStatus) ?? "pending",
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
