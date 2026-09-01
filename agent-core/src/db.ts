import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  extracted TEXT,
  created_at TEXT NOT NULL,
  source_path TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);
`;

// Columns added after the first release. `CREATE TABLE IF NOT EXISTS` is a
// no-op against a database that already has the table, so a DB created by an
// older build keeps its old shape and every INSERT that names a newer column
// fails at runtime (observed: "table documents has no column named
// source_path" on every document upload). Bring such a DB forward by adding
// any missing column. SQLite's ALTER TABLE ADD COLUMN can't carry a UNIQUE
// constraint, so uniqueness for source_path lives in the index above instead.
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "documents", column: "source_path", ddl: "ALTER TABLE documents ADD COLUMN source_path TEXT" },
  {
    table: "documents",
    column: "extraction_status",
    // Existing rows have already had their one extraction attempt; treat a
    // row that has fields as done and one that doesn't as failed, so nothing
    // is left showing "Extracting…" after the upgrade.
    ddl:
      "ALTER TABLE documents ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending'; " +
      "UPDATE documents SET extraction_status = CASE WHEN extracted IS NULL THEN 'failed' ELSE 'done' END",
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
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_path ON documents(source_path)",
    );
  }

  close() {
    this.db.close();
  }

  // ---- activity log (every write in this class logs here; keeps the trail truthful) ----
  logActivity(actor: string, action: string, detail: string): ActivityRecord {
    const rec: ActivityRecord = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      actor,
      action,
      detail,
    };
    this.db
      .prepare("INSERT INTO activity (id, ts, actor, action, detail) VALUES (?, ?, ?, ?, ?)")
      .run(rec.id, rec.ts, rec.actor, rec.action, rec.detail);
    return rec;
  }

  listActivity(limit = 100): ActivityRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM activity ORDER BY ts DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      action: r.action,
      detail: r.detail,
    }));
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
        "INSERT INTO tasks (id, title, notes, due_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(rec.id, rec.title, rec.notes, rec.dueDate, rec.status, rec.createdAt, rec.updatedAt);
    this.logActivity("task-agent", "task.created", `Created task "${rec.title}"`);
    return rec;
  }

  listTasks(status?: "open" | "done"): TaskRecord[] {
    const rows = (
      status
        ? this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC").all(status)
        : this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all()
    ) as any[];
    return rows.map(rowToTask);
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;
    return row ? rowToTask(row) : undefined;
  }

  updateTaskStatus(id: string, status: "open" | "done"): TaskRecord | undefined {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
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
        "INSERT INTO documents (id, filename, raw_text, extracted, created_at, source_path, extraction_status) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        rec.id,
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
    const row = this.db.prepare("SELECT * FROM documents WHERE source_path = ?").get(sourcePath) as any;
    return row ? rowToDocument(row) : undefined;
  }

  updateDocumentExtraction(id: string, extracted: Record<string, unknown>): DocumentRecord | undefined {
    this.db
      .prepare("UPDATE documents SET extracted = ?, extraction_status = 'done' WHERE id = ?")
      .run(JSON.stringify(extracted), id);
    const doc = this.getDocument(id);
    if (doc) {
      this.logActivity("document-agent", "document.extracted", `Extracted fields from "${doc.filename}"`);
    }
    return doc;
  }

  setDocumentExtractionStatus(id: string, status: ExtractionStatus): DocumentRecord | undefined {
    this.db.prepare("UPDATE documents SET extraction_status = ? WHERE id = ?").run(status, id);
    return this.getDocument(id);
  }

  deleteDocument(id: string): DocumentRecord | undefined {
    const doc = this.getDocument(id);
    if (!doc) return undefined;
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
    this.logActivity("user", "document.deleted", `Deleted "${doc.filename}"`);
    return doc;
  }

  // Any document still "pending" when the server starts belongs to a process
  // that is no longer running — its extraction will never resume on its own.
  // Flip those to "failed" so the UI stops showing "Extracting…" and offers a
  // retry instead. Returns how many were reset.
  failStalePendingExtractions(): number {
    const info = this.db
      .prepare("UPDATE documents SET extraction_status = 'failed' WHERE extraction_status = 'pending'")
      .run();
    return Number(info.changes ?? 0);
  }

  getDocument(id: string): DocumentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as any;
    return row ? rowToDocument(row) : undefined;
  }

  listDocuments(): DocumentRecord[] {
    const rows = this.db.prepare("SELECT * FROM documents ORDER BY created_at DESC").all() as any[];
    return rows.map(rowToDocument);
  }
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
